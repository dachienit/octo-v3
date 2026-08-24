/**
 * The SAP ADT capability, handed to the agent as a native tool.
 *
 * Design in docs/agent-capability-tool.vi.md. The short version: the agent gets a
 * *reference*, never a secret. The tool object is built once per channel and closes
 * over the channel id; everything that changes per turn — the user, the run id, the
 * user token — is looked up when the tool is called, never captured at build time.
 *
 * That distinction is not stylistic. The tool object outlives the turn that created
 * it (verified live: same instanceId across turns 6.5 minutes apart), so a credential
 * baked into the closure would still be inside its one-hour validity on the next turn
 * and would run that turn under the previous turn's identity — successfully, silently,
 * and with the wrong name in the SAP log.
 *
 * `AgentTool.execute` receives only `(toolCallId, params, signal?, onUpdate?)` — no
 * ambient context at all (pi-agent-core/dist/types.d.ts:328), so both the closure and
 * the turn registry below exist to supply what it cannot see.
 *
 * The ticket broker is deliberately left running alongside this: `/internal/adt-exec`,
 * `.octo/adt-broker.json` and the `adt-cli` skill all still work, so the two paths can
 * be compared before either is removed.
 */

import { randomBytes } from "crypto";
import { basename, resolve } from "path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import * as log from "../log.js";
import type { BotContext } from "../types.js";

/** Beyond this the ADT payload is cut before it reaches the model's context. */
const MAX_OUTPUT_CHARS = 60_000;

// ============================================================================
// Per-turn registry
// ============================================================================

/** What one chat turn knows about itself. Refreshed every turn, read at call time. */
export interface TurnContext {
	/** `ctx.message.ts` — the value trail.jsonl records as `runId`. */
	runId: string;
	/** `ctx.message.user` — the user of THIS turn, which the closure may not have. */
	userId: string;
	channelId: string;
	/** User's XSUAA token, for principal propagation. Absent when running locally. */
	userJwt?: string;
	/** Approuter base URL. Absent when running locally. */
	routerBase?: string;
	startedAt: number;
	/**
	 * Incremented when `beginTurn` finds an entry already in place. Runs on one
	 * channel are serialized by the queue in main.ts, so this must stay 0.
	 */
	reentrantBegins: number;
}

const turnsByChannel = new Map<string, TurnContext>();

/**
 * Open the turn window. Called from the runner decorator in agent.ts, which main.ts
 * invokes from inside its per-channel queue — so the window matches the execution
 * window rather than the request window. That is what stops two overlapping chats on
 * one channel from running under each other's identity.
 *
 * Credentials ride in on `ctx`, not through a side channel keyed by channel: a side
 * channel would be a single slot per channel and would reintroduce exactly the
 * clobbering bug the broker file has today (docs §2.4).
 *
 * A leftover entry is reported rather than thrown. This sits on the path of every
 * chat message, and killing a user's turn over an assumption about the queue would
 * be the wrong trade; the count travels into the tool's details instead.
 */
export function beginTurn(channelId: string, ctx: BotContext): void {
	const existing = turnsByChannel.get(channelId);
	if (existing) {
		log.logWarning(
			`[adt] beginTurn found an open turn for ${channelId}`,
			`previous runId=${existing.runId}, age=${Date.now() - existing.startedAt}ms`,
		);
	}
	turnsByChannel.set(channelId, {
		runId: ctx.message.ts,
		userId: ctx.message.user,
		channelId: ctx.message.channel,
		userJwt: ctx.sap?.userJwt,
		routerBase: ctx.sap?.routerBase,
		startedAt: Date.now(),
		reentrantBegins: existing ? existing.reentrantBegins + 1 : 0,
	});
}

/** Close the turn window. Outside it the capability does not resolve. */
export function endTurn(channelId: string): void {
	turnsByChannel.delete(channelId);
}

/** The turn currently running on this channel, or undefined outside a turn. */
export function currentTurn(channelId: string): TurnContext | undefined {
	return turnsByChannel.get(channelId);
}

// ============================================================================
// Runner registration
// ============================================================================

export interface AdtRunInput {
	userId: string;
	workspaceId: string;
	argv: string[];
	userJwt?: string;
	routerBase?: string;
}

export interface AdtRunOutcome {
	stdout: string;
	stderr: string;
	exitCode: number;
	/** Which adt-cli profile the command resolved to, for the trail. */
	profile?: string;
	/** Which BTP destination that profile maps to, if any. */
	destination?: string;
}

export type AdtRunner = (input: AdtRunInput) => Promise<AdtRunOutcome>;

let adtRunner: AdtRunner | undefined;

/**
 * HttpServer calls this at construction to lend its `runAdtCli` to the capability.
 * Registering a function rather than moving the ADT code keeps the SAP logic exactly
 * where it already is, and keeps this module free of any knowledge about how a
 * command actually reaches the system.
 */
export function registerAdtRunner(runner: AdtRunner): void {
	adtRunner = runner;
}

// ============================================================================
// The tool
// ============================================================================

/**
 * Plain JSON Schema rather than a typebox builder: typebox reaches core-service only
 * as a transitive dependency of core-agent, and the deploy package.json is generated
 * from core-service's own `dependencies` (scripts/assemble-deploy.mjs). Declaring it
 * would desync package-lock.json and break `npm ci` on the BTP build. The MCP tool
 * factory casts a plain schema the same way (core-agent/src/mcp/tools.ts:102).
 */
const adtSchema = {
	type: "object",
	properties: {
		argv: {
			type: "array",
			items: { type: "string" },
			description:
				'The adt-cli command split into arguments, without the leading "adt". ' +
				'Example: ["system","discovery"] or ["object","list","--parent-type","DEVC/K","--parent-name","ZADT_LOCAL"].',
		},
		label: {
			type: "string",
			description: "Short description of what this command is for, shown to the user.",
		},
	},
	required: ["argv"],
} as unknown as AgentTool["parameters"];

/**
 * What the agent must not reach.
 *
 * The absolute-URL rule is the load-bearing one: adt-cli accepts a full URL where a
 * request path is expected (client.js buildUrl) and still attaches the profile's
 * Authorization header, so one argument is enough to send the live user token to any
 * host. The argv is composed by the model out of text it has read — ABAP source
 * included — so this is refused here rather than trusted to a prompt.
 *
 * The three flags select or override the identity a command runs under, which is the
 * app's decision and not the model's.
 *
 * `--output` was on this list until 2026-08-21 and deliberately is not any more: the
 * agent needs the CLI to write files so that reading source does not have to travel
 * through the model's context. It writes with this process's rights, and what keeps
 * that in bounds is now the skill, not this guard.
 */
const BLOCKED_FLAGS = new Set(["--user-jwt", "--iss", "--service-binding"]);

function rejectArgv(argv: string[]): string | undefined {
	if (argv.length === 0) return "argv must not be empty";
	const offending = argv.find((arg) => /^https?:\/\//i.test(arg) || BLOCKED_FLAGS.has(arg));
	return offending ? `Argument not allowed: ${offending}` : undefined;
}

function capOutput(text: string): { text: string; truncated: boolean } {
	if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
	return {
		text: `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[... ${text.length - MAX_OUTPUT_CHARS} more characters truncated]`,
		truncated: true,
	};
}

/** Values fixed when the tool is built. They cannot change for the life of the agent. */
export interface AdtToolClosure {
	channelId: string;
	channelDir: string;
}

export function createAdtTool(closure: AdtToolClosure): AgentTool {
	// Built once per CoreAgent. Carried into `details` so the trail shows which tool
	// instance served a call — the evidence that the object outlives the turn.
	const instanceId = randomBytes(4).toString("hex");
	const builtAt = new Date().toISOString();

	// channelDir is `<workspaceRoot>/sessions/<sessionId>` (main.ts:317), so the
	// workspace id is the folder two levels up. Derived rather than plumbed through
	// RunnerOptions to keep this change additive; the field would be cleaner.
	const workspaceId = basename(resolve(closure.channelDir, "..", ".."));

	return {
		name: "adt",
		label: "adt",
		description: [
			"Run a SAP ADT command against the ABAP system the user connected in this workspace.",
			"Pass the command as `argv` without the leading `adt`, e.g. [\"system\",\"discovery\"].",
			"Identity, connection and credentials are handled by the app — you never supply them, and",
			"there is no profile or token for you to choose. Absolute URLs and the flags --user-jwt,",
			"--iss and --service-binding are rejected.",
			"Use --output <absolute path> to write a command's result straight to a file when you do not",
			"need to read it — the working directory is not the connection folder, so the path must be absolute.",
			"stdout comes back as the result; a non-zero exit code is reported with stderr.",
			"Exit 1 means the command failed or reported findings; exit 2 means auth or network.",
		].join(" "),
		parameters: adtSchema,
		executionMode: "sequential",
		execute: async (toolCallId: string, params: unknown) => {
			const startedAt = Date.now();
			const { argv, label } = (params ?? {}) as { argv?: string[]; label?: string };
			const args = Array.isArray(argv) ? argv.map(String) : [];

			const context = {
				instanceId,
				builtAt,
				channelId: closure.channelId,
				workspaceId,
				toolCallId,
			};

			if (!adtRunner) {
				// Only possible if this module is loaded without HttpServer, e.g. a test
				// harness. Worth a distinct message so it is not mistaken for a SAP fault.
				throw new Error("The ADT capability is not wired up in this process.");
			}

			const turn = currentTurn(closure.channelId);
			if (!turn) {
				// Outside a chat turn there is no user to act for. Reminders and background
				// jobs land here, and that is deliberate: an autonomous run has no identity
				// to borrow (docs §2).
				throw new Error("No chat turn is in flight, so there is no user to run this command for.");
			}

			const rejection = rejectArgv(args);
			if (rejection) {
				log.logWarning(`[adt] rejected argv on ${closure.channelId}`, rejection);
				throw new Error(rejection);
			}

			const outcome = await adtRunner({
				userId: turn.userId,
				workspaceId,
				argv: args,
				userJwt: turn.userJwt,
				routerBase: turn.routerBase,
			});

			const durationMs = Date.now() - startedAt;

			// One structured audit line per command: who ran what, where, and how it went.
			// Answers "who touched which system, when" without reading the conversation.
			log.logInfo(
				`[adt] ${JSON.stringify({
					runId: turn.runId,
					userId: turn.userId,
					workspaceId,
					channelId: closure.channelId,
					profile: outcome.profile ?? null,
					destination: outcome.destination ?? null,
					argv: args,
					exitCode: outcome.exitCode,
					durationMs,
				})}`,
			);

			const body = outcome.exitCode === 0
				? outcome.stdout || "(command produced no output)"
				: [
						`adt exited with code ${outcome.exitCode}.`,
						outcome.stderr && `stderr:\n${outcome.stderr}`,
						outcome.stdout && `stdout:\n${outcome.stdout}`,
					].filter(Boolean).join("\n\n");

			const capped = capOutput(body);

			return {
				// `content` is the only part the model sees: providers build the tool_result
				// block from it and drop `details` (pi-ai/providers/anthropic.js:857-869).
				// So it carries the target system's output and nothing about how Octo works
				// — no profile store paths, no destination names, no router base. A probe
				// build of this tool proved why that matters: with an internal path in the
				// result, the model repeated it to the user and then inferred, wrongly and
				// confidently, what it was for.
				content: [{ type: "text" as const, text: capped.text }],
				// `details` reaches the UI and trail.jsonl only, so full context is safe
				// here and is what makes a failed command diagnosable after the fact.
				details: {
					label: label ?? args.join(" "),
					argv: args,
					exitCode: outcome.exitCode,
					durationMs,
					truncated: capped.truncated,
					profile: outcome.profile ?? null,
					destination: outcome.destination ?? null,
					turn: {
						runId: turn.runId,
						userId: turn.userId,
						ageMs: startedAt - turn.startedAt,
						hasUserJwt: Boolean(turn.userJwt),
						hasRouterBase: Boolean(turn.routerBase),
						reentrantBegins: turn.reentrantBegins,
					},
					context,
				},
			};
		},
	};
}
