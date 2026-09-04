import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
//IYH1HC SAP ADT add
import { randomBytes } from "node:crypto";
import { Dirent, type Stats, appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import {
	getModel,
	getModels,
	cancelAcpJob,
	connectorHomeHasFiles,
	ensureConnectorHome,
	getConnectorHome,
	getConnectorRuntime,
	getProviderAuthStatus,
	listAcpJobs,
	listConnectorRuntimes,
	loginProvider,
	resolveWebSearchConfig,
	safeConnectorUserId,
	SessionStateStore,
	TOOL_CATALOG,
	type ConnectorRuntime,
} from "@octo/core-agent";
import express from "express";
import JSZip from "jszip";
import { CoreServiceAuth } from "./auth.js";
import { getAppHeader, getAppTitle } from "./branding.js";
//IYH1HC capability tool add
import { registerAdtRunner } from "./capabilities/adt-tool.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { prepareBoschAnthropicEndpoint, prepareBoschGoogleEndpoint, prepareBoschOpenAIEndpoint } from "./extensions/bosch-genai-adapter.js";
import { prepareOctoRouterAnthropicEndpoint, prepareOctoRouterGoogleEndpoint, prepareOctoRouterOpenAIEndpoint } from "./extensions/octo-router-adapter.js";
import { GithubSsoProvider, loadSsoConfig } from "./sso.js";
import type { ObjectStoreGateway } from "./object-store.js";
import {
	ADT_ABAPLINT_FILE,
	ADT_PULL_CONFIG_FILE,
	adtDir,
	applyPlan,
	connectionPath,
	initialManifest,
	manifestPath,
	manifestView,
	planChildren,
	readManifest,
	sanitizeFolderName,
	writeManifest,
	type AdtListResult,
} from "./sapTree.js";
import {
	DEFAULT_SAP_CLIENT,
	DEFAULT_SAP_LANGUAGE,
	findSapCatalogSystem,
	listSapCatalogSystems,
	type SapCatalogSystem,
} from "./sapSystems.js";
import * as log from "./log.js";
import { getWorkspaceSandboxStatus } from "./sandbox-manager.js";
import type { BotContext, BotHandler } from "./types.js";
import { truncateToolResult, type AgentTrailEvent, type AgentUsage } from "./agent-events.js"; 
import { TrailStore, readTrail } from "./trail-store.js";
import { WorkspaceDatabase } from "./workspace-database.js";
import { WorkspaceStore } from "./workspaces.js";
import type { SapConnection, WorkspaceRole } from "./workspaces.js";
import type { SandboxConfig } from "@octo/core-agent";

const localRequire = createRequire(import.meta.url);

//IYH1HC adt-config tiers
// Root of this package, where `templates/` sits beside `dist/`. Same shape in
// dev (core-service/) and in the assembled CF payload (deploy/), because
// assemble-deploy.mjs copies both folders side by side.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

interface SapRemoteDest {
	Name: string;
	Type?: string;
	URL?: string;
	Authentication?: string;
	ProxyType?: string;
	Description?: string;
}

//IYH1HC SSO add
// Which SAP connect surface this deployment can actually use. The two are
// mutually exclusive by nature, not by preference: On-Premise (SSO) needs a
// Kerberos ticket from the user's Windows logon, which only exists on their
// machine, and BTP destinations need the destination + connectivity services,
// which only exist in Cloud Foundry. Offering both everywhere just gives the
// user a button that cannot work. VCAP_SERVICES is the canonical "running on
// CF" marker (bin/adt.js keys off the same one); the override is for testing
// the other surface deliberately.
function resolveSapConnectMode(): "local" | "btp" {
	const override = (process.env.OCTO_SAP_CONNECT_MODE ?? "").trim().toLowerCase();
	if (override === "local" || override === "btp") return override;
	return process.env.VCAP_SERVICES ? "btp" : "local";
}

// Drop the Node process warnings a spawned CLI emits on its own stderr, so what
// is left is the CLI's own diagnostics. Failed adt-cli calls surface stderr to
// the client verbatim; a local SSO connection runs with an insecure TLS profile,
// whose "NODE_TLS_REJECT_UNAUTHORIZED" warning would otherwise become the error
// message the user sees instead of the real cause.
// Opt-in verbose tracing of every adt-cli call. Off by default because `-v` mixes
// adt-cli's own step log into stderr, which is what surfaces to the user as an
// error message when a command fails.
function adtTraceEnabled(): boolean {
	const value = (process.env.OCTO_ADT_TRACE ?? "").trim().toLowerCase();
	return value === "1" || value === "true" || value === "yes" || value === "on";
}

// A short, log-safe name for an adt-cli invocation: the subcommand path plus its
// first positional argument. Flags and their values are dropped so a profile name
// or a JWT can never reach the log.
function adtCliLabel(argv: string[]): string {
	const words: string[] = [];
	for (const arg of argv) {
		// Leading global flags (-q, --raw) come before the subcommand; skip them, then
		// take positionals until the first option, which is where values start.
		if (arg.startsWith("-")) {
			if (words.length === 0) continue;
			break;
		}
		words.push(arg);
		if (words.length === 3) break;
	}
	return words.join(" ") || "adt";
}

function cliStderr(raw: string): string {
	return raw
		.split(/\r?\n/)
		.filter((line) => !/^\(node:\d+\)\s/.test(line) && !/^\(Use `node --trace-warnings/.test(line))
		.join("\n")
		.trim();
}

// ============================================================================
// HTTP context adapter
// ============================================================================

type SseEmitter = (event: object) => void;

interface PendingAuthLogin {
	userId: string;
	status: "pending" | "complete" | "error";
	createdAt: number;
	url?: string;
	instructions?: string;
	userCode?: string;
	verificationUri?: string;
	error?: string;
	resolveManualCode?: (value: string) => void;
	rejectManualCode?: (err: Error) => void;
}

const LLM_KEY_PROVIDERS: ReadonlyArray<{ id: string; label: string }> = [
	{ id: "openai", label: "OpenAI" },
	{ id: "google", label: "Google Gemini" },
	{ id: "anthropic", label: "Anthropic" },
];
type ConnectorLoginMode = NonNullable<ConnectorRuntime["loginModes"]>[number];
type JsonObject = Record<string, unknown>;

interface PendingAgentWorkerLogin {
	userId: string;
	connectorId: string;
	status: "pending" | "complete" | "error";
	createdAt: number;
	output: string;
	url?: string;
	error?: string;
	child?: ChildProcessWithoutNullStreams;
	autoConfirmed?: boolean;
}

const BINARY_MIME_TYPES: Record<string, string> = {
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	ppt: "application/vnd.ms-powerpoint",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	xls: "application/vnd.ms-excel",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	zip: "application/zip",
};

/**
 * An `@`-mention from the composer: a scope plus a path relative to it. Deliberately
 * not a filesystem path — the server maps the scope to a root itself, so a client
 * cannot name a location the scopes do not reach.
 */
type MentionPayload = { scope?: "artifacts" | "attachments"; path?: string };

/** More than this in one message is a mistake, not an intent. */
const MAX_MENTIONS = 20;

/** Same reasoning for `/skill` invocations: a message driven by ten skills has no driver. */
const MAX_SKILL_INVOCATIONS = 5;

// Skill folder upload limits. The Express JSON body cap (50mb of base64 is roughly
// 37mb of bytes) is the hard ceiling, so stay well below it.
const MAX_SKILL_UPLOAD_FILES = 500;
const MAX_SKILL_UPLOAD_BYTES = 25 * 1024 * 1024;
// Junk that folder pickers hand over but a skill never needs.
const SKILL_UPLOAD_SKIP_NAMES = new Set([".DS_Store", "Thumbs.db"]);
const SKILL_UPLOAD_SKIP_DIRS = new Set([".git", "node_modules"]);

export function createHttpContext(opts: {
	channelId: string;
	userName: string;
	text: string;
	ts: string;
	send: SseEmitter;
	workingDir: string;
	attachments?: Array<{ local: string }>;
	mentions?: Array<{ local: string; type: "file" | "directory" }>;
	skills?: Array<{ name: string; local: string }>;
	userId?: string;
	authFilePath?: string;
	model?: { provider: string; modelId: string; apiKey?: string; baseUrl?: string; apiType?: string };
	structured?: boolean;
	//IYH1HC capability tool add
	sap?: { userJwt?: string; routerBase?: string };
}): BotContext {
	const { channelId, userName, text, ts, send, workingDir, attachments = [], mentions = [], skills = [], userId = "web-user", authFilePath, model, structured = false, sap } = opts;

	const logToFile = (entry: object) => {
		const dir = join(workingDir, "sessions", channelId);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	};

	let emitAgentEvent: ((event: AgentTrailEvent) => void) | undefined;
	let flushAgentEvents: (() => void) | undefined;
	if (structured) {
		const trailStore = new TrailStore(join(workingDir, "sessions", channelId), ts);
		const FLUSH_MS = 40;
		const FLUSH_CHARS = 2048;
		let seq = 0;
		const nextSeq = () => ++seq;
		const pendingDeltas = new Map<string, { kind: "text" | "thinking"; delta: string }>();
		let flushTimer: ReturnType<typeof setTimeout> | null = null;

		const flushDeltas = () => {
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
			for (const [blockId, p] of pendingDeltas) {
				send({ type: "block", seq: nextSeq(), phase: "delta", blockId, kind: p.kind, delta: p.delta });
			}
			pendingDeltas.clear();
		};

		emitAgentEvent = (event: AgentTrailEvent) => {
			if (event.type === "block" && event.phase === "delta") {
				const pending = pendingDeltas.get(event.blockId);
				if (pending) pending.delta += event.delta;
				else pendingDeltas.set(event.blockId, { kind: event.kind, delta: event.delta });
				if ((pendingDeltas.get(event.blockId)?.delta.length ?? 0) >= FLUSH_CHARS) {
					flushDeltas();
				} else if (!flushTimer) {
					flushTimer = setTimeout(flushDeltas, FLUSH_MS);
				}
				return;
			}
			// Flush buffered deltas before any non-delta event to preserve total order.
			flushDeltas();
			const stamped = { ...event, seq: nextSeq() } as AgentTrailEvent;
			trailStore.append(stamped);
			if (stamped.type === "tool" && stamped.phase === "end") {
				const { text: resultText, truncated } = truncateToolResult(stamped.result);
				send({ ...stamped, result: resultText, resultTruncated: truncated });
			} else if (stamped.type === "tool" && stamped.phase === "update") {
				send({ ...stamped, partialResult: truncateToolResult(stamped.partialResult).text });
			} else {
				send(stamped);
			}
		};
		flushAgentEvents = flushDeltas;
	}

	return {
		message: {
			text,
			rawText: text,
			user: userId,
			userName,
			channel: channelId,
			ts,
			attachments,
			mentions,
			skills,
		},
		authFilePath,
		model,
		//IYH1HC capability tool add
		sap,
		channelName: channelId,
		channels: [{ id: channelId, name: channelId }],
		users: [{ id: userId, userName, displayName: userName }],

		respond: async (responseText: string, shouldLog = true) => {
			if (!structured) send({ type: "delta", text: responseText });
			if (shouldLog) {
				const responseTs = (Date.now() / 1000).toFixed(6);
				logToFile({ date: new Date().toISOString(), ts: responseTs, user: "bot", text: responseText, attachments: [], isBot: true });
			}
		},

		replaceMessage: async (responseText: string) => {
			send({ type: "replace", text: responseText });
			const responseTs = (Date.now() / 1000).toFixed(6);
			logToFile({ date: new Date().toISOString(), ts: responseTs, user: "bot", text: responseText, attachments: [], isBot: true, isFinal: true });
		},

		respondInThread: async (responseText: string) => {
			if (!structured) send({ type: "thread", text: responseText });
			const responseTs = (Date.now() / 1000).toFixed(6);
			logToFile({ date: new Date().toISOString(), ts: responseTs, user: "bot", text: responseText, attachments: [], isBot: true, isThread: true });
		},

		setTyping: async (isTyping: boolean) => {
			send({ type: "status", status: isTyping ? "thinking" : "idle" });
		},

		uploadFile: async (filePath: string, title?: string) => {
			send({ type: "file", path: filePath, title });
		},

		setWorking: async (working: boolean) => {
			send({ type: "status", status: working ? "working" : "idle" });
		},

		deleteMessage: async () => {
			send({ type: "delete" });
		},

		emitAgentEvent,
		flushAgentEvents,
	};
}

// ============================================================================
// HTTP SSE Server
// ============================================================================

/**
 * HTTP server that exposes the bot via Server-Sent Events.
 *
 * Endpoints:
 *   POST /chat              – { channelId, text, userName? }  → SSE stream
 *   POST /stop              – { channelId }                   → { ok, message }
 *   GET  /status/:channelId                                   → { running }
 *   GET  /sessions                                            → SessionInfo[]
 *   GET  /messages/:channelId                                 → ChatMessage[]
 *   GET  /file?path=...                                       → raw file
 *   GET  /artifact-url?path=...                               → { url }
 *   GET  /artifacts/*                                         → static files from {workingDir}/artifacts/
 *
 * SSE event shapes:
 *   { type: "status",  status: "thinking"|"working"|"idle"|"stopped" }
 *   { type: "delta",   text: string }
 *   { type: "replace", text: string }
 *   { type: "thread",  text: string }
 *   { type: "file",    path: string, title?: string }
 *   { type: "delete" }
 *   { type: "done",    stopReason: string }
 *   { type: "error",   message: string }
 *
 * IYH1HC stream add — structured trail events (only when the client POSTs structured:true;
 * `delta`/`thread` are then suppressed, all other legacy events keep flowing):
 *   { type: "turn",   seq, phase: "start"|"end", turnIndex, ts }
 *   { type: "block",  seq, phase: "start"|"delta"|"end", blockId, kind: "text"|"thinking", delta?/content?, ts? }
 *   { type: "tool",   seq, phase: "call"|"start"|"update"|"end", toolCallId, toolName, args?, label?,
 *                     partialResult?, result?, resultTruncated?, isError?, durationMs?, ts? }
 *   { type: "skill",  seq, name, path, toolCallId, ts }
 *   { type: "usage",  seq, scope: "message"|"run", usage: {input,output,cacheRead,cacheWrite,cost}, contextTokens?, contextWindow? }
 *   { type: "compaction", seq, phase: "start"|"end", reason?, tokensBefore?, aborted? }
 *   { type: "retry",  seq, attempt, maxAttempts, errorMessage? }
 * Full definitions: ./agent-events.ts; audit persistence: ./trail-store.ts (trail.jsonl).
 */
export class HttpServer {
	private port: number;
	private workingDir: string;
	// Injected by finishStart() — they depend on a restored data root, which is not
	// available yet when the port is opened.
	private handler!: BotHandler;
	private workspaceStore!: WorkspaceStore;
	private sandboxConfig: SandboxConfig;
	private features: { agentWorkers: boolean; reminders: boolean; connection: boolean; tools: boolean; llmProviders: string[] | null; appTitle: string; appHeader: string; sapConnect: "local" | "btp" };
	private auth: CoreServiceAuth;
	private pendingAuthLogins = new Map<string, PendingAuthLogin>();
	private sso: GithubSsoProvider | null;
	private pendingAgentWorkerLogins = new Map<string, PendingAgentWorkerLogin>();
	private getObjectStoreStatus?: () => unknown;
	private objectStore?: ObjectStoreGateway;
	private app?: express.Express;
	// Flipped by finishStart(). Until then every route except /health answers 503:
	// the port is open from the first moment so the platform health check passes, but
	// nothing is served off a data root that is still being restored.
	private ready = false;
	private phase = "starting";
	//IYH1HC SAP ADT add
	// Live ADT credentials for the chat turn currently running, keyed by a one-shot
	// ticket. RAM only, dropped the moment the turn ends. A script the agent spawns
	// presents the ticket to run ADT commands as the user; it never sees the token
	// itself — the capability is lent, the credential is not.
	private readonly adtTurns = new Map<string, { userId: string; workspaceId: string; jwt?: string; routerBase?: string }>();

	constructor(config: { port: number; workingDir: string; sandboxConfig: SandboxConfig; features?: { agentWorkers?: boolean; reminders?: boolean; connection?: boolean; tools?: boolean; llmProviders?: string[] | null; appTitle?: string; appHeader?: string } }) {
		this.port = config.port;
		this.workingDir = config.workingDir;
		this.sandboxConfig = config.sandboxConfig;
		this.features = {
			agentWorkers: config.features?.agentWorkers !== false,
			reminders: config.features?.reminders !== false,
			connection: config.features?.connection !== false,
			tools: config.features?.tools !== false,
			llmProviders: config.features?.llmProviders ?? null,
			appTitle: config.features?.appTitle ?? getAppTitle(),
			appHeader: config.features?.appHeader ?? getAppHeader(),
			//IYH1HC SSO add — decided by the runtime, not by a caller.
			sapConnect: resolveSapConnectMode(),
		};
		this.auth = new CoreServiceAuth(config.workingDir);
		const ssoConfig = loadSsoConfig();
		this.sso = ssoConfig ? new GithubSsoProvider(ssoConfig) : null;
		if (this.sso) log.logInfo(`SSO enabled: ${ssoConfig?.provider} (${ssoConfig?.label})`);

		//IYH1HC capability tool add
		// Lend runAdtCli to the native `adt` tool. Registering a callback keeps every
		// line of SAP logic where it already is; the capability module stays ignorant
		// of how a command reaches the system. Registered here rather than at route
		// setup because the callback only ever runs at tool-call time, long after the
		// stores it touches are initialised.
		registerAdtRunner(async ({ userId, workspaceId, argv, userJwt, routerBase }) => {
			const profileName = this.adtProfileFor(userId, argv);
			const destination = profileName ? this.getConnectionDestination(userId, workspaceId, profileName) : undefined;
			const result = await this.runAdtCli(userId, argv, {
				userJwt,
				// Same reason as adtOpts: the connection folder is where adt-cli finds
				// this system's `.adt/` config. Without a resolved profile there is no
				// folder to name, so runAdtCli keeps its own fallback.
				//IYH1HC adt-config tiers
				cwd: profileName ? this.sapConnDir(workspaceId, profileName) : undefined,
				profileName: profileName || undefined,
				destinationName: destination,
				routerBase,
			});
			return { ...result, profile: profileName || undefined, destination };
		});
	}

	//IYH1HC capability tool add
	/**
	 * Which connection a bare command runs against: the global `-p`/`--profile` flag,
	 * then `--name` but only inside the `auth` group (on `object activate` it is the
	 * ABAP object name), then whichever connection the user last worked in.
	 *
	 * Duplicated from handleAdtExec rather than shared, so that adding the tool cannot
	 * change the behaviour of the ticket path while both are running. Fold the two
	 * together when the ticket route is removed.
	 */
	private adtProfileFor(userId: string, argv: string[]): string {
		const flagValue = (name: string): string | undefined => {
			const index = argv.indexOf(name);
			return index >= 0 ? argv[index + 1] : undefined;
		};
		return (
			flagValue("-p") ??
			flagValue("--profile") ??
			(argv[0] === "auth" ? flagValue("--name") : undefined) ??
			this.readDefaultProfile(userId)
		);
	}

	/**
	 * Phase 1 — open the port straight away, before the data root is restored.
	 *
	 * The boot used to bind only after the whole object-store tree had been downloaded,
	 * so a tree that took longer than Cloud Foundry's startup health check (60s by
	 * default) got the app killed before it ever listened. Binding first decouples
	 * "process is alive" from "data is ready", whatever the tree grows to.
	 *
	 * Only the readiness probe is answered until finishStart() runs; everything else
	 * gets 503 so no request is ever served off a half-restored data root.
	 */
	startListening(): void {
		const app = express();
		this.app = app;
		app.use(express.json({ limit: "50mb" }));

		// CORS goes on before the readiness gate so a warm-up 503 still reaches the
		// browser as a 503 rather than as an opaque CORS failure.
		app.use((_req, res, next) => {
			const origin = _req.header("Origin");
			res.setHeader("Access-Control-Allow-Origin", origin || "*");
			res.setHeader("Access-Control-Allow-Methods", "POST, GET, PATCH, PUT, DELETE, OPTIONS");
			res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-User-Id, Authorization");
			res.setHeader("Access-Control-Allow-Credentials", "true");
			next();
		});
		app.options("/{*path}", (_req, res) => { res.sendStatus(204); });

		// Readiness gate. A middleware (not a catch-all route) so the real routes
		// registered later by finishStart() are not shadowed by it.
		app.use((req, res, next) => {
			if (this.ready || req.path === "/health") {
				next();
				return;
			}
			res.status(503).json({ error: "warming up", phase: this.phase });
		});

		app.get("/health", (_req, res) => {
			const status = this.getObjectStoreStatus?.() as Record<string, unknown> | undefined;
			res.json({ ok: true, ready: this.ready, phase: this.phase, objectStore: status ?? null });
		});

		app.listen(this.port, () => {
			log.logInfo(`HTTP server listening on port ${this.port} (warming up — routes answer 503 until ready)`);
		});
	}

	setPhase(phase: string): void {
		this.phase = phase;
	}

	/**
	 * Phase 2 — mount the real routes onto the already-listening server and go ready.
	 * Express allows registering routes after listen(), so this needs no rebind.
	 */
	async finishStart(deps: {
		workspaceStore: WorkspaceStore;
		handler: BotHandler;
		objectStore?: ObjectStoreGateway;
		getObjectStoreStatus?: () => unknown;
	}): Promise<void> {
		this.workspaceStore = deps.workspaceStore;
		this.handler = deps.handler;
		this.objectStore = deps.objectStore;
		this.getObjectStoreStatus = deps.getObjectStoreStatus;

		const app = this.app;
		if (!app) throw new Error("finishStart() called before startListening()");

		this.phase = "opening auth store";
		await this.auth.init();
		this.phase = "mounting routes";

		// CORS and the JSON body parser are already mounted by startListening().
		app.use(this.auth.initialize());

		// Static artifact files — serves {workingDir}/artifacts/ at /artifacts/
		const artifactsDir = join(this.workingDir, "artifacts");

		app.post("/auth/register", (req, res) => this.auth.register(req, res));
		app.post("/auth/login", (req, res, next) => this.auth.login(req, res, next));
		app.get("/auth/me", (req, res, next) => this.auth.requireAuth(req, res, next), (req, res) => this.auth.me(req, res));
		app.post("/auth/logout", (req, res, next) => this.auth.requireAuth(req, res, next), (req, res) => this.auth.logout(req, res));

		app.get("/auth/sso/config", (req, res) => this.handleSsoConfig(req, res));
		app.get("/auth/sso/login", (req, res) => this.handleSsoLogin(req, res));
		app.get("/auth/sso/callback", (req, res) => { void this.handleSsoCallback(req, res); });

		app.get("/objectstore/status", (_req, res) => {
			const status = this.getObjectStoreStatus?.();
			res.json(status ? { mode: "mirror", ...status } : { mode: "ephemeral" });
		});

		//IYH1HC SAP ADT add
		// Mounted above requireAuth on purpose: the caller is a script the agent spawned,
		// which holds no user token. It is fenced by loopback + a per-turn ticket instead
		// (see handleAdtExec).
		//app.post("/internal/adt-exec", (req, res) => { void this.handleAdtExec(req, res); });

		app.use((req, res, next) => this.auth.requireAuth(req, res, next));
		app.use("/artifacts", express.static(artifactsDir, { fallthrough: false }));
		// Everything below reads workspace content off disk, so the mirror for that
		// workspace has to be materialized first.
		app.use(this.hydrateWorkspaceMiddleware());

		// API routes
		app.get("/features", (_req, res) => this.handleFeatures(res));
		app.get("/workspaces",      (req, res) => this.handleWorkspaces(req, res));
		app.get("/workspace-templates", (_req, res) => res.json(this.workspaceStore.listWorkspaceTemplates()));
		app.post("/workspaces",     (req, res) => this.handleCreateWorkspace(req, res));
		app.get("/workspaces/:workspaceId/settings", (req, res) => this.handleWorkspaceSettings(req, res));
		app.patch("/workspaces/:workspaceId/settings", (req, res) => this.handleUpdateWorkspaceSettings(req, res));
		app.get("/workspaces/:workspaceId/sap-adt/destinations", (req, res) => { void this.handleSapListDestinations(req, res); });
		app.get("/workspaces/:workspaceId/sap-adt/local-systems", (req, res) => { void this.handleSapListLocalSystems(req, res); });
		app.post("/workspaces/:workspaceId/sap-adt/connections", (req, res) => { void this.handleSapCreateConnection(req, res); });
		app.delete("/workspaces/:workspaceId/sap-adt/connections/:name", (req, res) => { void this.handleSapDeleteConnection(req, res); });
		app.post("/workspaces/:workspaceId/sap-adt/connections/:name/test", (req, res) => { void this.handleSapTestConnection(req, res); });
		app.post("/workspaces/:workspaceId/sap-adt/connections/:name/refresh", (req, res) => { void this.handleSapRefreshConnection(req, res); });
		app.post("/workspaces/:workspaceId/sap-adt/connections/:name/activate", (req, res) => { void this.handleSapActivateConnection(req, res); });
		app.get("/workspaces/:workspaceId/sap-adt/connections/:name/nodes", (req, res) => { void this.handleSapListNodes(req, res); });
		app.get("/workspaces/:workspaceId/sap-adt/connections/:name/source", (req, res) => { void this.handleSapGetSource(req, res); });
		app.post("/workspaces/:workspaceId/sap-adt/connections/:name/tree/expand", (req, res) => { void this.handleSapExpandTree(req, res); });
		app.post("/workspaces/:workspaceId/sap-adt/connections/:name/tree/package", (req, res) => { void this.handleSapAddPackage(req, res); });
		app.post("/workspaces/:workspaceId/sap-adt/connections/:name/tree/hydrate", (req, res) => { void this.handleSapHydrateFile(req, res); });
		app.get("/workspaces/:workspaceId/sap-adt/connections/:name/tree/manifest", (req, res) => { void this.handleSapTreeManifest(req, res); });
		app.get("/workspaces/:workspaceId/sandbox", (req, res) => { void this.handleWorkspaceSandbox(req, res); });
		app.get("/workspaces/:workspaceId/events", (req, res) => this.handleWorkspaceEvents(req, res));
		app.delete("/workspaces/:workspaceId/events/:filename", (req, res) => this.handleDeleteWorkspaceEvent(req, res));
		app.get("/database/tables", (req, res) => this.handleDatabaseTables(req, res));
		app.get("/database/tables/:tableName/rows", (req, res) => this.handleDatabaseRows(req, res));
		app.get("/auth/openai-codex/status", (req, res) => this.handleAuthStatus(req, res));
		app.post("/auth/openai-codex/login", (req, res) => { void this.handleCodexLogin(req, res); });
		app.get("/auth/openai-codex/login/:loginId", (req, res) => this.handleCodexLoginStatus(req, res));
		app.post("/auth/openai-codex/login/:loginId/code", (req, res) => this.handleCodexLoginCode(req, res));
		app.get("/tools", (req, res) => this.handleToolCatalog(req, res));
		app.get("/llm/config", (req, res) => this.handleLlmConfig(req, res));
		app.get("/llm/active-models", (req, res) => this.handleLlmActiveModels(req, res));
		app.put("/llm/providers/:provider/key", (req, res) => this.handleSetProviderKey(req, res));
		app.delete("/llm/providers/:provider/key", (req, res) => this.handleDeleteProviderKey(req, res));
		app.put("/llm/providers/:provider/models", (req, res) => this.handleSetActiveModels(req, res));
		app.get("/llm/custom-models", (req, res) => this.handleListCustomModels(req, res));
		app.post("/llm/custom-models", (req, res) => this.handleCreateCustomModel(req, res));
		app.put("/llm/custom-models/:id", (req, res) => this.handleUpdateCustomModel(req, res));
		app.delete("/llm/custom-models/:id", (req, res) => this.handleDeleteCustomModel(req, res));
		app.get("/auth/connectors", (req, res) => this.handleConnectors(req, res));
		app.get("/auth/connectors/:connector/status", (req, res) => this.handleConnectorStatus(req, res));
		app.post("/auth/connectors/:connector/login", (req, res) => this.handleConnectorLogin(req, res));
		app.get("/auth/connectors/:connector/login/:loginId", (req, res) => this.handleConnectorLoginStatus(req, res));
		app.post("/auth/connectors/:connector/login/:loginId/input", (req, res) => this.handleConnectorLoginInput(req, res));
		app.post("/auth/connectors/:connector/logout", (req, res) => this.handleConnectorLogout(req, res));
		app.post("/connectors/:connector/exec", (req, res) => this.handleConnectorExec(req, res));
		app.get("/auth/agent-workers", (req, res) => this.handleAgentWorkers(req, res));
		app.get("/auth/agent-workers/:agent/status", (req, res) => this.handleAgentWorkerStatus(req, res));
		app.post("/auth/agent-workers/:agent/login", (req, res) => this.handleAgentWorkerLogin(req, res));
		app.get("/auth/agent-workers/:agent/login/:loginId", (req, res) => this.handleAgentWorkerLoginStatus(req, res));
		app.post("/auth/agent-workers/:agent/login/:loginId/input", (req, res) => this.handleAgentWorkerLoginInput(req, res));
		app.post("/auth/agent-workers/:agent/logout", (req, res) => this.handleAgentWorkerLogout(req, res));
		app.get("/workspaces/:workspaceId/sessions", (req, res) => this.handleWorkspaceSessions(req, res));
		app.get("/workspaces/:workspaceId/works", (req, res) => this.handleListWorks(req, res));
		app.post("/workspaces/:workspaceId/work-orders", (req, res) => this.handleCreateWorkOrder(req, res));
		app.post("/workspaces/:workspaceId/work-items", (req, res) => this.handleCreateWorkItem(req, res));
		app.post("/workspaces/:workspaceId/sessions", (req, res) => this.handleCreateSession(req, res));
		app.post("/workspaces/:workspaceId/skills", (req, res) => this.handleUploadSkill(req, res));
		app.post("/sessions/:sessionId/messages", (req, res) => { void this.handleChat(req, res, req.params.sessionId); });
		app.post("/chat",           (req, res) => { void this.handleChat(req, res); });
		app.post("/stop",           (req, res) => { void this.handleStop(req, res); });
		app.get("/status/:id",      (req, res) => this.handleStatus(req, req.params.id, res));
		app.get("/sessions/:id/mode", (req, res) => this.handleSessionMode(req, decodeURIComponent(req.params.id), res));
		app.patch("/sessions/:id/mode", (req, res) => this.handleSetSessionMode(req, decodeURIComponent(req.params.id), res));
		app.get("/sessions/:id/acp-jobs", (req, res) => this.handleAcpJobs(req, decodeURIComponent(req.params.id), res));
		app.post("/sessions/:id/acp-jobs/:jobId/cancel", (req, res) => this.handleCancelAcpJob(req, decodeURIComponent(req.params.id), decodeURIComponent(req.params.jobId), res));
		app.get("/sessions",        (req, res) => this.handleSessions(req, res));
		app.delete("/sessions/:id", (req, res) => { void this.handleDeleteSession(req, decodeURIComponent(req.params.id), res); });
		app.delete("/workspaces/:workspaceId/sessions/:sessionId", (req, res) => { void this.handleDeleteSession(req, decodeURIComponent(req.params.sessionId), res); });
		app.get("/messages/:id",    (req, res) => this.handleMessages(req, decodeURIComponent(req.params.id), res));
		app.get("/sessions/:id/messages", (req, res) => this.handleMessages(req, decodeURIComponent(req.params.id), res));
		app.get("/file",            (req, res) => this.handleFile(req, String(req.query.path ?? ""), res));
		app.delete("/file",         (req, res) => this.handleDeleteFile(req, String(req.query.path ?? ""), res));
		app.get("/artifact-url",    (req, res) => this.handleArtifactUrl(req, String(req.query.path ?? ""), res));
		app.get("/workspace/:id",   (req, res) => this.handleWorkspace(req, decodeURIComponent(req.params.id), res));
		app.get("/sessions/:id/workspace", (req, res) => this.handleWorkspace(req, decodeURIComponent(req.params.id), res));

		this.phase = "ready";
		this.ready = true;
		log.logInfo(`HTTP SSE server ready on port ${this.port}`);
		log.logInfo(`Artifacts served from: ${artifactsDir}`);
	}

	/**
	 * Pulls a workspace's mirrored content down the first time a request touches it.
	 *
	 * Boot only restores the metadata skeleton (see isBootCritical in object-store.ts),
	 * so the bulk of a workspace — session logs, artifacts, events, skills — has to
	 * arrive before a handler reads it off disk. Doing it in one middleware keeps the
	 * handlers unaware of the mirror, and hydrateWorkspace() is memoized so this costs
	 * nothing after the first hit.
	 */
	private hydrateWorkspaceMiddleware(): express.Handler {
		return (req, res, next) => {
			const store = this.objectStore;
			if (!store) {
				next();
				return;
			}
			const workspaceId = this.resolveWorkspaceForHydration(req);
			if (!workspaceId) {
				next();
				return;
			}
			void store
				.hydrateWorkspace(workspaceId)
				.then(() => next())
				.catch((err) => {
					// Serving a half-empty workspace would look like data loss to the
					// user, so fail the request loudly instead.
					log.logWarning(`[object-store] hydrate failed for ${workspaceId}`, err instanceof Error ? err.message : String(err));
					res.status(503).json({ error: "Workspace content is temporarily unavailable" });
				});
		};
	}

	/**
	 * Best-effort workspace id for the request being served. This runs as app-level
	 * middleware, where `req.params` is not populated yet, so the path is matched by
	 * hand. Returning undefined simply means "nothing to hydrate".
	 */
	private resolveWorkspaceForHydration(req: express.Request): string | undefined {
		// /workspaces/<workspaceId>/...
		const byPath = /^\/workspaces\/([^/]+)/.exec(req.path);
		if (byPath) return decodeURIComponent(byPath[1]);

		const body = (req.body ?? {}) as { workspaceId?: string; sessionId?: string; channelId?: string };
		if (typeof body.workspaceId === "string" && body.workspaceId) return body.workspaceId;
		if (typeof req.query.workspaceId === "string" && req.query.workspaceId) return req.query.workspaceId;

		// ?path=workspaces/<workspaceId>/... — /file, /artifact-url, /database/*
		const queryPath = typeof req.query.path === "string" ? req.query.path : undefined;
		const byQueryPath = queryPath ? /^\/?workspaces[\\/]([^\\/]+)/.exec(queryPath) : null;
		if (byQueryPath) return byQueryPath[1];

		// Session-scoped routes. Note /workspace/<id> (singular) also takes a SESSION
		// id, not a workspace id — see handleWorkspace.
		const bySession = /^\/(?:sessions|messages|status|workspace)\/([^/]+)/.exec(req.path);
		const sessionId = bySession ? decodeURIComponent(bySession[1]) : (body.sessionId ?? body.channelId);
		if (sessionId) {
			// session.json is part of the boot set, so this lookup works without the
			// workspace being hydrated yet.
			return this.workspaceStore.findSession(sessionId)?.workspaceId;
		}

		// GET /sessions with no workspaceId lists the user's default workspace
		// (handleSessions). Its previews and message counts come from each session's
		// log.jsonl, which is deferred content — so resolve the same workspace the
		// handler will. listWorkspaces is read-only; unlike ensureDefaultWorkspace it
		// never creates one as a side effect of routing.
		if (req.path === "/sessions") return this.workspaceStore.listWorkspaces(this.getUserId(req))[0]?.id;

		return undefined;
	}

	// ==========================================================================
	// Handlers
	// ==========================================================================

	private getUserId(req: express.Request, fallback?: string): string {
		return String(req.user?.id || req.header("x-user-id") || req.query.userId || fallback || "web-user");
	}

	private getUserName(req: express.Request, fallback?: string): string {
		return String(req.user?.displayName || req.user?.email || fallback || "user");
	}

	private getUserAuthFilePath(userId: string): string {
		const safeUserId = userId.replace(/[^a-zA-Z0-9._-]/g, "_") || "web-user";
		const dir = join(this.workingDir, "users", safeUserId);
		mkdirSync(dir, { recursive: true });
		return join(dir, "auth.json");
	}

	/**
	 * The containment check behind every path a client supplies: normalize, require
	 * the result to sit inside `<dataRoot>/workspaces/<wsId>/`, and require the user
	 * to be a member of that workspace.
	 *
	 * Pure — it reports a failure instead of writing one. Route handlers that serve a
	 * single file want an HTTP response (see `resolveReadableWorkspaceFile`), but
	 * validating a *list* of paths must be able to drop one entry and keep going.
	 */
	private resolveWorkspacePathForUser(
		req: express.Request,
		filePath: string,
	): { ok: true; resolved: string; workspaceId: string } | { ok: false; status: number; error: string } {
		if (!filePath) return { ok: false, status: 400, error: "Missing path" };

		const root = resolve(this.workingDir);
		const resolved = resolve(isAbsolute(filePath) ? filePath : join(this.workingDir, filePath));

		const relFromRoot = relative(root, resolved);
		if (relFromRoot === "" || relFromRoot.startsWith("..") || isAbsolute(relFromRoot)) {
			return { ok: false, status: 403, error: "Forbidden" };
		}

		const workspaceRoot = resolve(join(this.workingDir, "workspaces"));
		const relFromWorkspaces = relative(workspaceRoot, resolved);
		if (relFromWorkspaces === "" || relFromWorkspaces.startsWith("..") || isAbsolute(relFromWorkspaces)) {
			return { ok: false, status: 403, error: "Forbidden" };
		}

		const workspaceId = relFromWorkspaces.split(/[\\/]/)[0];
		try {
			this.workspaceStore.assertWorkspaceAccess(this.getUserId(req), workspaceId);
		} catch (err) {
			return { ok: false, status: 403, error: err instanceof Error ? err.message : String(err) };
		}
		return { ok: true, resolved, workspaceId };
	}

	private resolveReadableWorkspaceFile(req: express.Request, filePath: string, res: express.Response): string | undefined {
		const outcome = this.resolveWorkspacePathForUser(req, filePath);
		if (!outcome.ok) {
			res.status(outcome.status).json({ error: outcome.error });
			return undefined;
		}
		return outcome.resolved;
	}

	/**
	 * Turns the `@`-mentions a client sent into workspace-relative paths the agent
	 * can resolve.
	 *
	 * The client sends a scope plus a path relative to that scope, never a
	 * filesystem path, so the server owns the mapping to a root. Every result still
	 * goes through the containment guard, because a scope-relative path can climb
	 * out with `..` just as easily. A mention that fails validation, or names
	 * something that no longer exists, is **dropped** rather than failing the whole
	 * message — the user's text is still worth delivering.
	 */
	private resolveMentions(
		req: express.Request,
		mentions: MentionPayload[],
		workspaceRoot: string,
		sessionId: string,
	): Array<{ local: string; type: "file" | "directory" }> {
		const resolved: Array<{ local: string; type: "file" | "directory" }> = [];

		for (const mention of mentions.slice(0, MAX_MENTIONS)) {
			if (!mention || typeof mention.path !== "string" || !mention.path) continue;

			const scopeRoot =
				mention.scope === "attachments" ? join("sessions", sessionId, "attachments") : "artifacts";
			const relativeToWorkspace = join(scopeRoot, mention.path);

			const outcome = this.resolveWorkspacePathForUser(req, join(workspaceRoot, relativeToWorkspace));
			if (!outcome.ok) {
				log.logWarning("[mentions] dropped", `${mention.scope}:${mention.path} (${outcome.error})`);
				continue;
			}

			// The workspace guard alone would still let `../` walk from this session's
			// attachments into a sibling session's, which is precisely the boundary
			// `glob`/`grep` refuse to cross. Require the result to stay in its scope.
			const relFromScope = relative(resolve(join(workspaceRoot, scopeRoot)), outcome.resolved);
			if (relFromScope.startsWith("..") || isAbsolute(relFromScope)) {
				log.logWarning("[mentions] dropped", `${mention.scope}:${mention.path} (outside its scope)`);
				continue;
			}

			let stat: Stats;
			try {
				stat = statSync(outcome.resolved);
			} catch {
				log.logWarning("[mentions] dropped", `${mention.scope}:${mention.path} (not found)`);
				continue;
			}

			const local = relativeToWorkspace.replace(/\\/g, "/");
			if (resolved.some((entry) => entry.local === local)) continue;
			resolved.push({ local, type: stat.isDirectory() ? "directory" : "file" });
		}

		return resolved;
	}

	/**
	 * Writes one uploaded file under the session's attachments and returns the path it was
	 * stored at, relative to that directory — or null when the client's name cannot be
	 * trusted, in which case the file is dropped rather than the message failing.
	 *
	 * A folder upload sends each file's path relative to the picked folder, so the tree is
	 * rebuilt here instead of being flattened into the filename: the agent then greps and
	 * globs it the way it would any other directory. Every segment is sanitized, `.`/`..`
	 * and drive letters are rejected outright, and the result still has to resolve inside
	 * the attachments directory. Only the first segment carries the batch stamp, so a folder
	 * stays one folder and re-uploading it does not overwrite the earlier copy.
	 */
	private storeAttachment(attachDir: string, fileName: unknown, content: unknown, stamp: number): string | null {
		const raw = String(fileName ?? "").replace(/\\/g, "/");
		const segments = raw.split("/").filter((segment) => segment !== "");
		if (segments.length === 0) return null;
		if (segments.some((segment) => segment === "." || segment === ".." || segment.includes(":"))) return null;

		const safeSegments = segments.map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, "_"));
		// Re-check after sanitizing: "…" and friends survive the character filter.
		if (safeSegments.some((segment) => segment === "." || segment === "..")) return null;
		safeSegments[0] = `${stamp}_${safeSegments[0]}`;

		const abs = resolve(join(attachDir, ...safeSegments));
		const rel = relative(resolve(attachDir), abs);
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;

		try {
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, Buffer.from(String(content ?? ""), "base64"));
		} catch (err) {
			log.logWarning("[attachments] write failed", err instanceof Error ? err.message : String(err));
			return null;
		}
		return safeSegments.join("/");
	}

	/**
	 * Turns the `/name` skill invocations a client sent into workspace-relative SKILL.md
	 * paths. Session skills override workspace skills, matching how the agent loads them.
	 *
	 * The client sends names, never paths, so the server owns the mapping — and a name that
	 * resolves to nothing is dropped with a warning rather than failing the message.
	 */
	private resolveSkills(skills: string[], workspaceRoot: string, sessionId: string): Array<{ name: string; local: string }> {
		const resolved: Array<{ name: string; local: string }> = [];

		for (const raw of skills.slice(0, MAX_SKILL_INVOCATIONS)) {
			const name = this.sanitizeConnectionName(raw);
			if (!name || name === "." || name === "..") continue;
			if (resolved.some((entry) => entry.name === name)) continue;

			const candidates = [
				join("sessions", sessionId, "skills", name),
				join("skills", name),
			];
			const scope = candidates.find((candidate) => existsSync(join(workspaceRoot, candidate, "SKILL.md")));
			if (!scope) {
				log.logWarning("[skills] dropped", `${String(raw)} (no SKILL.md)`);
				continue;
			}
			resolved.push({ name, local: `${scope.replace(/\\/g, "/")}/SKILL.md` });
		}

		return resolved;
	}

	private createLoginId(): string {
		return `login_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
	}

	private handleAuthStatus(req: express.Request, res: express.Response): void {
		const userId = this.getUserId(req);
		const status = getProviderAuthStatus(this.getUserAuthFilePath(userId), "openai-codex");
		res.json({ provider: "openai-codex", configured: status.configured, source: status.source, label: status.label });
	}

	private handleSsoConfig(_req: express.Request, res: express.Response): void {
		const hideAuthUi = process.env.CORE_SERVICE_HIDE_AUTH_UI === "true";
		if (!this.sso) {
			res.json({ enabled: false, hideAuthUi });
			return;
		}
		res.json({ enabled: true, provider: this.sso.config.provider, label: this.sso.config.label, loginUrl: "/auth/sso/login", hideAuthUi });
	}

	private handleSsoLogin(_req: express.Request, res: express.Response): void {
		if (!this.sso) {
			res.status(404).json({ error: "SSO is not enabled" });
			return;
		}
		res.redirect(this.sso.createAuthorizeUrl());
	}

	private async handleSsoCallback(req: express.Request, res: express.Response): Promise<void> {
		if (!this.sso) {
			res.status(404).json({ error: "SSO is not enabled" });
			return;
		}
		const redirectBase = this.sso.config.postLoginRedirect;
		try {
			const code = String(req.query.code ?? "");
			const state = req.query.state ? String(req.query.state) : undefined;
			if (req.query.error) throw new Error(String(req.query.error_description || req.query.error));
			if (!code) throw new Error("Missing authorization code");
			if (!this.sso.consumeState(state)) throw new Error("Invalid or expired state");

			const identity = await this.sso.resolveIdentity(code);
			const session = await this.auth.completeFederatedLogin(res, identity);
			res.redirect(`${redirectBase}/#sso_token=${encodeURIComponent(session.token)}`);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log.logWarning("[sso] callback failed", message);
			res.redirect(`${redirectBase}/#sso_error=${encodeURIComponent(message)}`);
		}
	}

	private async handleCodexLogin(req: express.Request, res: express.Response): Promise<void> {
		const { userName } = req.body as { userName?: string };
		const userId = this.getUserId(req, userName);
		const loginId = this.createLoginId();
		const entry: PendingAuthLogin = {
			userId,
			status: "pending",
			createdAt: Date.now(),
		};
		this.pendingAuthLogins.set(loginId, entry);

		const manualCodePromise = new Promise<string>((resolve, reject) => {
			entry.resolveManualCode = resolve;
			entry.rejectManualCode = reject;
		});

		void loginProvider(this.getUserAuthFilePath(userId), "openai-codex", {
			onAuth: (info) => {
				entry.url = info.url;
				entry.instructions = info.instructions;
			},
			onDeviceCode: (info) => {
				entry.userCode = info.userCode;
				entry.verificationUri = info.verificationUri;
			},
			onSelect: async () => undefined,
			onPrompt: async () => manualCodePromise,
			onManualCodeInput: async () => manualCodePromise,
			onProgress: (message) => {
				log.logInfo(`[auth:${loginId}] ${message}`);
			},
		}).then(() => {
			entry.status = "complete";
			entry.resolveManualCode = undefined;
			entry.rejectManualCode = undefined;
		}).catch((err) => {
			entry.status = "error";
			entry.error = err instanceof Error ? err.message : String(err);
			entry.resolveManualCode = undefined;
			entry.rejectManualCode = undefined;
			log.logWarning(`[auth:${loginId}] Codex login failed`, entry.error);
		});

		const started = Date.now();
		while (!entry.url && entry.status === "pending" && Date.now() - started < 5000) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		if (!entry.url) {
			res.status(500).json({ error: entry.error || "Codex login did not produce an auth URL" });
			return;
		}

		res.status(201).json({
			loginId,
			provider: "openai-codex",
			url: entry.url,
			instructions: entry.instructions,
			userCode: entry.userCode,
			verificationUri: entry.verificationUri,
			statusUrl: `/auth/openai-codex/login/${encodeURIComponent(loginId)}`,
			codeUrl: `/auth/openai-codex/login/${encodeURIComponent(loginId)}/code`,
		});
	}

	private handleCodexLoginStatus(req: express.Request, res: express.Response): void {
		const entry = this.pendingAuthLogins.get(String(req.params.loginId));
		if (!entry) {
			res.status(404).json({ error: "Login not found" });
			return;
		}
		res.json({
			status: entry.status,
			provider: "openai-codex",
			url: entry.url,
			instructions: entry.instructions,
			userCode: entry.userCode,
			verificationUri: entry.verificationUri,
			error: entry.error,
			createdAt: entry.createdAt,
		});
	}

	private handleCodexLoginCode(req: express.Request, res: express.Response): void {
		const entry = this.pendingAuthLogins.get(String(req.params.loginId));
		if (!entry) {
			res.status(404).json({ error: "Login not found" });
			return;
		}
		if (entry.status !== "pending" || !entry.resolveManualCode) {
			res.status(409).json({ error: `Login is ${entry.status}` });
			return;
		}
		const { code } = req.body as { code?: string };
		if (!code?.trim()) {
			res.status(400).json({ error: "Missing code or redirect URL" });
			return;
		}
		entry.resolveManualCode(code.trim());
		res.json({ ok: true, status: "pending" });
	}

	// ==========================================================================
	// IYH1HC add: per-user LLM provider key + model selection
	// ==========================================================================

	private isAllowedLlmProvider(provider: string): boolean {
		return LLM_KEY_PROVIDERS.some((p) => p.id === provider);
	}

	private modelLabel(provider: string, modelId: string): string {
		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const m = getModel(provider as any, modelId) as any;
			if (m?.name) return String(m.name);
		} catch { /* unknown model — fall back to id */ }
		return modelId;
	}

	// GET /llm/config → per-provider { id, label, hasKey, models:[{id,name,active}] }. Never returns keys.
	private async handleLlmConfig(req: express.Request, res: express.Response): Promise<void> {
		const userId = this.getUserId(req);
		const store = this.auth.getStore();
		const active = new Set((await store.getActiveModels(userId)).map((m) => `${m.provider}:${m.modelId}`));
		const providers = await Promise.all(LLM_KEY_PROVIDERS.map(async (p) => {
			let models: Array<{ id: string; name: string; active: boolean }> = [];
			try {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				models = (getModels(p.id as any) as any[]).map((m) => ({
					id: String(m.id),
					name: String(m.name ?? m.id),
					active: active.has(`${p.id}:${m.id}`),
				}));
			} catch { models = []; }
			return { id: p.id, label: p.label, hasKey: await store.hasProviderKey(userId, p.id), models };
		}));
		res.json({ providers });
	}

	// GET /llm/active-models → flat [{ provider, modelId, label }] for the chatbox listbox.
	private async handleLlmActiveModels(req: express.Request, res: express.Response): Promise<void> {
		const userId = this.getUserId(req);
		const store = this.auth.getStore();
		const models = (await store.getActiveModels(userId)).map((m) => ({
			provider: m.provider,
			modelId: m.modelId,
			label: this.modelLabel(m.provider, m.modelId),
		}));
		for (const cm of await store.listCustomModels(userId)) {
			models.push({ provider: cm.provider, modelId: cm.id, label: cm.name });
		}
		res.json({ models });
	}

	// PUT /llm/providers/:provider/key  body { apiKey } → encrypt + store.
	private async handleSetProviderKey(req: express.Request, res: express.Response): Promise<void> {
		const provider = String(req.params.provider);
		if (!this.isAllowedLlmProvider(provider)) {
			res.status(400).json({ error: "Unsupported provider" });
			return;
		}
		const { apiKey } = req.body as { apiKey?: string };
		if (!apiKey || !apiKey.trim()) {
			res.status(400).json({ error: "Missing apiKey" });
			return;
		}
		try {
			const encrypted = encryptSecret(apiKey.trim());
			await this.auth.getStore().setProviderKey(this.getUserId(req), provider, encrypted);
			res.json({ ok: true, hasKey: true });
		} catch (err) {
			res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	// DELETE /llm/providers/:provider/key → forget the stored key.
	private async handleDeleteProviderKey(req: express.Request, res: express.Response): Promise<void> {
		const provider = String(req.params.provider);
		if (!this.isAllowedLlmProvider(provider)) {
			res.status(400).json({ error: "Unsupported provider" });
			return;
		}
		await this.auth.getStore().deleteProviderKey(this.getUserId(req), provider);
		res.json({ ok: true, hasKey: false });
	}

	// PUT /llm/providers/:provider/models  body { modelIds: string[] } → replace active set.
	private async handleSetActiveModels(req: express.Request, res: express.Response): Promise<void> {
		const provider = String(req.params.provider);
		if (!this.isAllowedLlmProvider(provider)) {
			res.status(400).json({ error: "Unsupported provider" });
			return;
		}
		const { modelIds } = req.body as { modelIds?: unknown };
		if (!Array.isArray(modelIds) || modelIds.some((id) => typeof id !== "string")) {
			res.status(400).json({ error: "modelIds must be a string array" });
			return;
		}
		await this.auth.getStore().setActiveModels(this.getUserId(req), provider, modelIds as string[]);
		res.json({ ok: true });
	}

	private isAllowedBaseProvider(provider: string): boolean {
		return LLM_KEY_PROVIDERS.some((p) => p.id === provider);
	}

	private parseCustomModelBody(
		req: express.Request,
		requireKey: boolean,
	): { name: string; provider: string; baseProvider: string; endpoint: string; apiKey?: string; routing?: string } | { error: string } {
		const { name, provider, baseProvider, endpoint, apiKey, routing } = req.body as {
			name?: string; provider?: string; baseProvider?: string; endpoint?: string; apiKey?: string; routing?: string;
		};
		if (!name || !name.trim()) return { error: "Missing name" };
		if (!baseProvider || !this.isAllowedBaseProvider(baseProvider)) return { error: "Unsupported baseProvider" };
		if (!endpoint || !endpoint.trim()) return { error: "Missing endpoint" };
		if (requireKey && (!apiKey || !apiKey.trim())) return { error: "Missing apiKey" };

		let resolvedProvider = provider && provider.trim() ? provider.trim() : "custom";
		if (resolvedProvider === "custom" || !resolvedProvider) {
			if (name.startsWith("octo-router/")) {
				resolvedProvider = "octo-router";
			} else if (name.startsWith("bosch-genai/")) {
				resolvedProvider = "bosch-genai";
			}
		}

		return {
			name: name.trim(),
			provider: resolvedProvider,
			baseProvider,
			endpoint: endpoint.trim(),
			apiKey: apiKey && apiKey.trim() ? apiKey.trim() : undefined,
			routing: routing && routing.trim() ? routing.trim() : undefined,
		};
	}

	// GET /llm/custom-models → { customModels: [{ id, name, provider, baseProvider, endpoint, routing }] }. Never returns keys.
	private async handleListCustomModels(req: express.Request, res: express.Response): Promise<void> {
		const customModels = await this.auth.getStore().listCustomModels(this.getUserId(req));
		res.json({ customModels });
	}

	// POST /llm/custom-models  body { name, provider?, baseProvider, endpoint, apiKey, routing? } → encrypt + store.
	private async handleCreateCustomModel(req: express.Request, res: express.Response): Promise<void> {
		const parsed = this.parseCustomModelBody(req, true);
		if ("error" in parsed) {
			res.status(400).json({ error: parsed.error });
			return;
		}
		try {
			const encryptedKey = encryptSecret(parsed.apiKey as string);
			const id = await this.auth.getStore().addCustomModel(this.getUserId(req), {
				name: parsed.name,
				provider: parsed.provider,
				baseProvider: parsed.baseProvider,
				endpoint: parsed.endpoint,
				encryptedKey,
				routing: parsed.routing,
			});
			res.json({ ok: true, id });
		} catch (err) {
			res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	// PUT /llm/custom-models/:id  body { name, provider?, baseProvider, endpoint, apiKey?, routing? } → update (key optional).
	private async handleUpdateCustomModel(req: express.Request, res: express.Response): Promise<void> {
		const id = String(req.params.id);
		const userId = this.getUserId(req);
		if (!(await this.auth.getStore().getCustomModel(userId, id))) {
			res.status(404).json({ error: "Custom model not found" });
			return;
		}
		const parsed = this.parseCustomModelBody(req, false);
		if ("error" in parsed) {
			res.status(400).json({ error: parsed.error });
			return;
		}
		try {
			const encryptedKey = parsed.apiKey ? encryptSecret(parsed.apiKey) : undefined;
			await this.auth.getStore().updateCustomModel(userId, id, {
				name: parsed.name,
				provider: parsed.provider,
				baseProvider: parsed.baseProvider,
				endpoint: parsed.endpoint,
				encryptedKey,
				routing: parsed.routing,
			});
			res.json({ ok: true });
		} catch (err) {
			res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	// DELETE /llm/custom-models/:id → forget the custom model.
	private async handleDeleteCustomModel(req: express.Request, res: express.Response): Promise<void> {
		await this.auth.getStore().deleteCustomModel(this.getUserId(req), String(req.params.id));
		res.json({ ok: true });
	}

	private safeUserId(userId: string): string {
		return safeConnectorUserId(userId);
	}

	private getUsersRoot(): string {
		return join(this.workingDir, "users");
	}

	private getConnectorEnv(userId: string, connector: ConnectorRuntime): NodeJS.ProcessEnv {
		const usersRoot = this.getUsersRoot();
		ensureConnectorHome(usersRoot, userId, connector.id);
		return {
			...process.env,
			...connector.env({ userId, usersRoot }),
		};
	}

	private resolveConnector(connectorId: string, kind?: "agent-runtime" | "business-connector"): ConnectorRuntime | undefined {
		const connector = getConnectorRuntime(connectorId);
		if (!connector) return undefined;
		if (kind && connector.kind !== kind) return undefined;
		if (!this.features.agentWorkers && connector.kind === "agent-runtime") return undefined;
		return connector;
	}

	private extractUrl(text: string): string | undefined {
		return text.match(/https?:\/\/[^\s)]+/)?.[0];
	}

	private serializeConnector(req: express.Request, connector: ConnectorRuntime) {
		const userId = this.getUserId(req);
		const usersRoot = this.getUsersRoot();
		return {
			id: connector.id,
			label: connector.label,
			kind: connector.kind,
			authMode: connector.authMode,
			loginModes: connector.loginModes,
			connected: connectorHomeHasFiles(usersRoot, userId, connector.id),
			usedByAgents: connector.usedByAgents ?? [],
			accessPolicy: connector.accessPolicy,
		};
	}

	private handleFeatures(res: express.Response): void {
		res.json({ features: { agentWorkers: this.features.agentWorkers, reminders: this.features.reminders, connection: this.features.connection, tools: this.features.tools, llmProviders: this.features.llmProviders, appTitle: this.features.appTitle, appHeader: this.features.appHeader, sapConnect: this.features.sapConnect } });
	}

	private handleConnectors(req: express.Request, res: express.Response): void {
		const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
		if (kind === "agent-runtime" && !this.features.agentWorkers) {
			res.json({ connectors: [] });
			return;
		}
		const connectors = listConnectorRuntimes(kind === "agent-runtime" || kind === "business-connector" ? kind : undefined)
			.filter((connector) => this.features.agentWorkers || connector.kind !== "agent-runtime")
			.map((connector) => this.serializeConnector(req, connector));
		res.json({ connectors });
	}

	private handleConnectorStatus(req: express.Request, res: express.Response): void {
		const connector = this.resolveConnector(String(req.params.connector));
		if (!connector) {
			res.status(404).json({ error: "Unknown connector" });
			return;
		}
		res.json(this.serializeConnector(req, connector));
	}

	private handleConnectorLogin(req: express.Request, res: express.Response): void {
		const connector = this.resolveConnector(String(req.params.connector));
		if (!connector || (!connector.loginModes?.length && (!connector.command || !connector.loginCommand))) {
			res.status(404).json({ error: "Connector login is not configured" });
			return;
		}
		this.startConnectorLogin(req, res, connector);
	}

	private handleConnectorLoginStatus(req: express.Request, res: express.Response): void {
		this.writeConnectorLoginStatus(req, res, String(req.params.connector), "connector");
	}

	private handleConnectorLoginInput(req: express.Request, res: express.Response): void {
		this.writeConnectorLoginInput(req, res, String(req.params.connector));
	}

	private handleConnectorLogout(req: express.Request, res: express.Response): void {
		const connector = this.resolveConnector(String(req.params.connector));
		if (!connector) {
			res.status(404).json({ error: "Unknown connector" });
			return;
		}
		this.logoutConnector(req, res, connector);
	}

	private handleConnectorExec(req: express.Request, res: express.Response): void {
		const connector = this.resolveConnector(String(req.params.connector), "business-connector");
		if (!connector?.command || !connector.accessPolicy.allowedInHost) {
			res.status(404).json({ error: "Connector command proxy is not configured" });
			return;
		}
		const body = req.body as { argv?: unknown; cwd?: unknown; timeoutMs?: unknown };
		const argv = Array.isArray(body.argv) ? body.argv.map(String) : [];
		const timeoutMs = Math.min(Math.max(Number(body.timeoutMs ?? 120000) || 120000, 1000), 300000);
		const cwd = this.resolveConnectorExecCwd(typeof body.cwd === "string" ? body.cwd : undefined);
		if (!cwd) {
			res.status(403).json({ error: "Connector cwd is outside the workspace root" });
			return;
		}
		const userId = this.getUserId(req);
		const child = spawn(connector.command, argv, {
			env: this.getConnectorEnv(userId, connector),
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let responded = false;
		const trim = (text: string) => text.length > 10 * 1024 * 1024 ? text.slice(-10 * 1024 * 1024) : text;
		const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => { stdout = trim(stdout + chunk.toString("utf-8")); });
		child.stderr.on("data", (chunk: Buffer) => { stderr = trim(stderr + chunk.toString("utf-8")); });
		child.on("error", (err) => {
			clearTimeout(timeout);
			responded = true;
			res.status(500).json({ stdout, stderr: stderr || err.message, exitCode: 1, error: err.message });
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			if (responded) return;
			res.json({ stdout, stderr, exitCode: code ?? 0 });
		});
	}

	private resolveConnectorExecCwd(cwd?: string): string | undefined {
		const root = resolve(this.workingDir);
		const resolved = cwd
			? resolve(cwd.startsWith("/") ? cwd : join(this.workingDir, cwd))
			: root;
		if (resolved !== root && !resolved.startsWith(`${root}/`)) return undefined;
		return resolved;
	}

	// ==========================================================================
	// SAP ADT connection management
	// ==========================================================================

	// Run the vendored adt-cli (spawned via the current Node binary + an absolute
	// path to its bin, never a bare PATH lookup). The SAP ADT connector home isolates
	// each user's adt-cli profile store; ADT_USER_JWT carries the request-scoped user
	// token for principal propagation, and ADT_PROFILE selects the connection profile.
	private runAdtCli(
		userId: string,
		argv: string[],
		opts: { userJwt?: string; cwd?: string; profileName?: string; timeoutMs?: number; destinationName?: string; routerBase?: string } = {},
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return new Promise((resolveP) => {
			const connector = this.resolveConnector("sap-adt", "business-connector");
			if (!connector) {
				resolveP({ stdout: "", stderr: "sap-adt connector is not configured", exitCode: 1 });
				return;
			}
			let adtBin: string;
			try {
				adtBin = localRequire.resolve("adt-cli/bin/adt.js");
			} catch (err) {
				resolveP({ stdout: "", stderr: `adt-cli is not installed: ${(err as Error).message}`, exitCode: 1 });
				return;
			}
			const usersRoot = this.getUsersRoot();
			const home = getConnectorHome(usersRoot, userId, connector.id);
			const env: NodeJS.ProcessEnv = {
				...process.env,
				...this.getConnectorEnv(userId, connector),
				// adt-cli persists profiles under ADT_CLI_HOME; set it explicitly because
				// os.homedir() ignores HOME on Windows, which would break local isolation.
				ADT_CLI_HOME: join(home, ".adt-cli"),
			};
			if (opts.userJwt) env.ADT_USER_JWT = opts.userJwt;
			if (opts.profileName) env.ADT_PROFILE = opts.profileName;
			if (opts.destinationName && opts.routerBase) {
				env.destinations = JSON.stringify([
					{
						name: opts.destinationName,
						url: `${opts.routerBase.replace(/\/+$/, "")}/adt-proxy/${encodeURIComponent(opts.destinationName)}`,
						forwardAuthToken: true,
					},
				]);
			}
			const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : this.workingDir;
			const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 120000, 1000), 300000);
			// Every adt-cli call is a fresh process talking to an on-prem system, so the
			// only way to tell "slow because we spawn twice" from "slow because SAP is
			// slow" is to time each one. OCTO_ADT_TRACE swaps the CLI's `-q` for `-v` so
			// its own timestamped step/HTTP lines survive into this log.
			const effectiveArgv = adtTraceEnabled() ? argv.map((arg) => (arg === "-q" ? "-v" : arg)) : argv;
			const label = adtCliLabel(effectiveArgv);
			const startedAt = Date.now();
			const child = spawn(process.execPath, [adtBin, ...effectiveArgv], { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			let settled = false;
			const cap = (text: string) => (text.length > 10 * 1024 * 1024 ? text.slice(-10 * 1024 * 1024) : text);
			const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
			const trace = (exitCode: number) => {
				log.logInfo(`[adt-cli] ${label} -> exit ${exitCode} in ${Date.now() - startedAt}ms`);
				if (adtTraceEnabled() && stderr.trim()) log.logInfo(`[adt-cli] ${label} trace:\n${cliStderr(stderr)}`);
			};
			child.stdout.on("data", (chunk: Buffer) => { stdout = cap(stdout + chunk.toString("utf-8")); });
			child.stderr.on("data", (chunk: Buffer) => { stderr = cap(stderr + chunk.toString("utf-8")); });
			child.on("error", (err) => {
				clearTimeout(timer);
				if (settled) return;
				settled = true;
				trace(1);
				resolveP({ stdout, stderr: cliStderr(stderr) || err.message, exitCode: 1 });
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				if (settled) return;
				settled = true;
				trace(code ?? 0);
				resolveP({ stdout, stderr: cliStderr(stderr), exitCode: code ?? 0 });
			});
		});
	}

	private extractUserJwt(req: express.Request): string | undefined {
		const match = req.header("Authorization")?.match(/^Bearer\s+(.+)$/i);
		return match?.[1]?.trim();
	}

	private resolveRouterBase(req: express.Request): string | undefined {
		if (process.env.ADT_ROUTER_URL) return process.env.ADT_ROUTER_URL;
		const host = req.header("x-forwarded-host") || req.header("host");
		if (!host) return undefined;
		const proto = req.header("x-forwarded-proto") || "https";
		return `${proto}://${host}`;
	}

	private getConnectionDestination(userId: string, workspaceId: string, name: string): string | undefined {
		return this.workspaceStore.getSapConnections(userId, workspaceId).find((c) => c.name === name)?.destinationName;
	}

	// Path of the adt-cli profile store for a user (the file `ADT_CLI_HOME` points at).
	private adtConfigPath(userId: string): string | undefined {
		const connector = this.resolveConnector("sap-adt", "business-connector");
		if (!connector) return undefined;
		return join(getConnectorHome(this.getUsersRoot(), userId, connector.id), ".adt-cli", "config.json");
	}

	// Which profile bare `adt` commands currently resolve to, or "" when unset.
	private readDefaultProfile(userId: string): string {
		const configPath = this.adtConfigPath(userId);
		if (!configPath || !existsSync(configPath)) return "";
		try {
			const cfg = JSON.parse(readFileSync(configPath, "utf8")) as { defaultProfile?: string };
			return typeof cfg.defaultProfile === "string" ? cfg.defaultProfile : "";
		} catch {
			return "";
		}
	}

	// Make `name` the default adt-cli profile for this user.
	//
	// Why it matters: the web IDE always passes `--name`/`ADT_PROFILE`, but the agent
	// typing `adt ...` through the bash tool does not — commands like `object list`
	// fall back to `defaultProfile`. Pointing that at whichever connection the user is
	// working in keeps the agent on the same system as the UI.
	//
	// Setting one key is done here rather than by spawning `adt auth profile use`.
	// That spawn was measured at 67s of a 79s "add package": the command touches no
	// network at all, so the whole cost was starting a Node process that loads the
	// CLI's entire module graph. Writing the key we already read back costs a rename.
	// Only the bootstrap case — no config file yet, or one we cannot parse — still
	// goes through the CLI, which is what knows how to create a config from nothing.
	private async setDefaultProfile(userId: string, name: string): Promise<void> {
		if (!name) return;
		const configPath = this.adtConfigPath(userId);
		if (configPath && existsSync(configPath)) {
			try {
				const cfg = JSON.parse(readFileSync(configPath, "utf8")) as { defaultProfile?: string; profiles?: Record<string, unknown> };
				if (cfg.defaultProfile === name) return;
				// `profile use` throws on an unknown profile; skip rather than log a failure.
				if (cfg.profiles && !cfg.profiles[name]) return;
				cfg.defaultProfile = name;
				// Write-then-rename: adt-cli processes read this file concurrently and a
				// partial write would look like a corrupt config to them.
				const tmp = `${configPath}.${process.pid}.tmp`;
				writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
				renameSync(tmp, configPath);
				return;
			} catch (err) {
				log.logWarning("[sap-adt] could not set default profile in place", `${name}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		const result = await this.runAdtCli(userId, ["-q", "auth", "profile", "use", name]);
		if (result.exitCode !== 0) {
			log.logWarning("[sap-adt] could not set default profile", `${name}: ${result.stderr.trim()}`);
		}
	}

	// adtOpts + "this connection is now the one in use". Every connection-scoped ADT
	// operation goes through here, so the invariant holds at the API level rather than
	// depending on the UI remembering to announce the switch.
	private async adtOptsFor(
		ctx: { userId: string; workspaceId: string },
		req: express.Request,
		name: string,
	): Promise<{ userJwt?: string; cwd: string; profileName: string; destinationName?: string; routerBase?: string }> {
		await this.setDefaultProfile(ctx.userId, name);
		return this.adtOpts(ctx, req, name);
	}

	// Single place that builds runAdtCli options for an existing connection, so the
	// two on-prem reach mechanisms stay on one code path: a BTP connection carries a
	// destination name (runAdtCli then routes the CLI through the approuter's
	// /adt-proxy for principal propagation), while a local SSO connection has none
	// and the CLI talks to the profile's own URL over Kerberos/SPNEGO. No handler
	// needs to branch on the auth type.
	//
	// `cwd` is the connection folder because adt-cli resolves its local config
	// layer against the process cwd: `<cwd>/.adt/pull-config.json` and
	// `<cwd>/.adt/abaplint.json`. Pointing it anywhere else silently demotes every
	// command to the global config. //IYH1HC adt-config tiers
	private adtOpts(ctx: { userId: string; workspaceId: string }, req: express.Request, name: string): { userJwt?: string; cwd: string; profileName: string; destinationName?: string; routerBase?: string } {
		return {
			userJwt: this.extractUserJwt(req),
			cwd: this.sapConnDir(ctx.workspaceId, name),
			profileName: name,
			destinationName: this.getConnectionDestination(ctx.userId, ctx.workspaceId, name),
			routerBase: this.resolveRouterBase(req),
		};
	}

	//IYH1HC SAP ADT add
	// POST /internal/adt-exec — run one adt-cli command on behalf of the user whose chat
	// turn is currently in flight.
	//
	// Why this exists: when the user clicks in the UI, runAdtCli injects ADT_USER_JWT and
	// the destination into the child process. When the agent types `adt` into the bash
	// tool, none of that code runs — the shell resolves the binary itself and the child
	// has no credentials, so adt-cli falls through to the XSUAA branch and dies. The
	// agent's skill calls this route instead, and the CLI runs here, in the process that
	// already holds the request-scoped user token.
	//
	// Unauthenticated because the caller is a script the agent spawned and it has no user
	// token to present. Two fences replace that: the caller must be on loopback (the app
	// has a public route, and the agent runs inside this same container), and it must
	// present the one-shot ticket minted for this turn. Outside a turn the map is empty,
	// so a stale ticket resolves to nothing.
	/* private async handleAdtExec(req: express.Request, res: express.Response): Promise<void> {
		const remote = req.socket.remoteAddress ?? "";
		if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) {
			res.status(403).json({ error: "Not a local caller" });
			return;
		}
		const body = req.body as { ticket?: unknown; argv?: unknown };
		const turn = typeof body.ticket === "string" ? this.adtTurns.get(body.ticket) : undefined;
		if (!turn) {
			res.status(401).json({ error: "No ADT turn is in flight for this ticket" });
			return;
		}
		const argv = Array.isArray(body.argv) ? body.argv.map(String) : [];

		// adt-cli accepts an absolute URL where a request path is expected and then sends
		// the live user JWT to it, and --output writes a response body anywhere on disk
		// with this process's rights. The agent needs neither, and its argv is composed
		// from text it read — including ABAP source — so both are refused here.
		const blockedFlags = new Set(["--output", "--user-jwt", "--iss", "--service-binding"]);
		const offending = argv.find((arg) => /^https?:\/\//i.test(arg) || blockedFlags.has(arg));
		if (offending) {
			res.status(400).json({ error: `Argument not allowed: ${offending}` });
			return;
		}

		// Which connection this runs against. The profile selector is the global
		// -p/--profile flag; --name only means a profile inside the `auth` group (on
		// `object activate` it is the ABAP object name). Everything else falls back to
		// whichever connection the user last worked in, same as a bare `adt` would.
		const flagValue = (name: string): string | undefined => {
			const index = argv.indexOf(name);
			return index >= 0 ? argv[index + 1] : undefined;
		};
		const profileName =
			flagValue("-p") ??
			flagValue("--profile") ??
			(argv[0] === "auth" ? flagValue("--name") : undefined) ??
			this.readDefaultProfile(turn.userId);

		// Same four options adtOpts() builds for the UI path, so the two cannot drift.
		const result = await this.runAdtCli(turn.userId, argv, {
			userJwt: turn.jwt,
			profileName: profileName || undefined,
			destinationName: profileName ? this.getConnectionDestination(turn.userId, turn.workspaceId, profileName) : undefined,
			routerBase: turn.routerBase,
		});
		res.json(result);
	}
 */
	// Connection name doubles as the adt-cli profile name and an on-disk folder name,
	// so it must be filesystem/profile safe. `.` and `-` are allowed inside a name,
	// which means the character filter alone still lets "." and ".." through — and
	// those resolve to the artifacts root and the workspace root. Disconnect deletes
	// the folder, so they are rejected outright; callers treat "" as a 400.
	private sanitizeConnectionName(raw: unknown): string {
		const name = String(raw ?? "").trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
		return /^\.+$/.test(name) ? "" : name;
	}

	// Resolves req.params.workspaceId against the caller's membership, or sends a
	// 404/403 and returns undefined. Used by every workspace-scoped write handler.
	private assertWorkspaceRole(req: express.Request, res: express.Response, requireWrite: boolean): { userId: string; workspaceId: string } | undefined {
		const userId = this.getUserId(req);
		const workspaceId = String(req.params.workspaceId);
		let role: WorkspaceRole;
		try {
			role = this.workspaceStore.assertWorkspaceAccess(userId, workspaceId);
		} catch {
			res.status(404).json({ error: "Workspace not found or access denied" });
			return undefined;
		}
		if (requireWrite && role === "viewer") {
			res.status(403).json({ error: "Workspace is read-only for viewers" });
			return undefined;
		}
		return { userId, workspaceId };
	}

	// GET /workspaces/:id/sap-adt/destinations
	private async handleSapListDestinations(req: express.Request, res: express.Response): Promise<void> {
		const ctx = this.assertWorkspaceRole(req, res, false);
		if (!ctx) return;
		const userJwt = this.extractUserJwt(req);
		const result = await this.runAdtCli(ctx.userId, ["-q", "auth", "destinations", "list"], { userJwt });
		if (result.exitCode !== 0) {
			res.status(502).json({ error: result.stderr || "Failed to list destinations" });
			return;
		}
		let parsed: { remote?: { error?: string; subaccount?: SapRemoteDest[]; instance?: SapRemoteDest[] } };
		try {
			parsed = JSON.parse(result.stdout);
		} catch {
			res.status(502).json({ error: "Invalid destinations output", raw: result.stdout });
			return;
		}
		const remote = parsed.remote && !parsed.remote.error ? parsed.remote : { subaccount: [], instance: [] };
		const destinations = [...(remote.subaccount ?? []), ...(remote.instance ?? [])].map((d) => ({
			name: d.Name,
			type: d.Type,
			url: d.URL,
			authentication: d.Authentication,
			proxyType: d.ProxyType,
			description: d.Description,
		}));
		res.json({ destinations });
	}

	// GET /workspaces/:id/sap-adt/local-systems → the corporate system catalogue
	// that backs the On-Premise (SSO) picklist.
	private async handleSapListLocalSystems(req: express.Request, res: express.Response): Promise<void> {
		const ctx = this.assertWorkspaceRole(req, res, false);
		if (!ctx) return;
		try {
			const systems: SapCatalogSystem[] = listSapCatalogSystems();
			res.json({ systems });
		} catch (e) {
			res.status(500).json({ error: (e as Error).message || "Failed to read the SAP system catalogue" });
		}
	}

	// Save/refresh a `basicsso` profile and ping the system. `auth login basicsso`
	// writes the profile to the user's adt-cli config.json and then verifies it
	// with GET /sap/bc/adt/discovery, so one command covers both "store the
	// profile" and "is the system reachable as me right now". The SSO ticket it
	// obtains is never written down — every adt-cli process does its own SPNEGO
	// handshake — so this verifies live reachability, not a cached credential.
	private runBasicSsoLogin(
		userId: string,
		profile: { name: string; url: string; spn: string; client?: string; language?: string },
		cwd: string,
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		// -v, not -q: adt-cli's logger drops warn/step/ok at quiet level, and the
		// SPNEGO diagnostics (which host answered, what the probe body said) are
		// warnings. Under -q a failed connect reached the user as a bare
		// "Verification failed: HTTP 403" with no host, SPN or body to act on.
		// Only exitCode and stderr are read below, so raising verbosity is safe.
		const argv = ["-v", "auth", "login", "basicsso", "--url", profile.url, "--spn", profile.spn, "--insecure", "--name", profile.name];
		if (profile.client) argv.push("--client", profile.client);
		if (profile.language) argv.push("--language", profile.language);
		return this.runAdtCli(userId, argv, { cwd, profileName: profile.name });
	}

	//IYH1HC adt-config tiers
	// Everything describing a connection goes into its `.adt/` folder: the
	// descriptor, an empty object-tree manifest, and adt-cli's two config files.
	// No object tree is materialized here — packages are added explicitly from the
	// Artifacts panel.
	//
	// The config files are seeded into both tiers, and only when absent, so a user
	// who has edited either copy keeps their edits across every reconnect:
	//   local  <conn>/.adt/            → applies to this SAP system only
	//   global <ADT_CLI_HOME>/         → applies to everything this user runs
	// adt-cli resolves them by location (local outranks global), so seeding the
	// files is the whole wiring — nothing else has to point at them.
	private writeConnectionSidecars(userId: string, workspaceId: string, connection: SapConnection): string {
		const folder = join(this.workspaceStore.getWorkspaceRoot(workspaceId), "artifacts", connection.name);
		this.writeConnectionDescriptor(folder, connection);
		if (!existsSync(manifestPath(folder))) writeManifest(folder, initialManifest());
		this.seedAdtConfigs(userId, folder);
		return folder;
	}

	//IYH1HC adt-config tiers
	// The descriptor alone. Split out because the BTP destination flow writes it
	// even when the login failed — a breadcrumb of the attempt — while the tree
	// manifest and the config seeds only appear once the system actually answered.
	private writeConnectionDescriptor(folder: string, connection: SapConnection): void {
		mkdirSync(adtDir(folder), { recursive: true });
		writeFileSync(
			connectionPath(folder),
			`${JSON.stringify(
				{
					connectionName: connection.name,
					authType: connection.authType,
					url: connection.url,
					spn: connection.spn,
					systemId: connection.systemId,
					destinationName: connection.destinationName,
					client: connection.client,
					language: connection.language,
				},
				null,
				2,
			)}\n`,
		);
	}

	//IYH1HC adt-config tiers
	// Copy the bundled adt-cli config defaults into the local and global tiers.
	// Never overwrites: an existing file is the user's, seeded or hand-edited.
	// A missing bundle is logged and skipped — a connect must not fail over it.
	private seedAdtConfigs(userId: string, connFolder: string): void {
		const bundledRoot = join(packageRoot, "templates", "sap-adt");
		const targets: Array<{ dir: string; tier: string }> = [{ dir: adtDir(connFolder), tier: "local" }];

		const connector = this.resolveConnector("sap-adt", "business-connector");
		if (connector) {
			// The global tier is the adt-cli config dir itself — the same path
			// runAdtCli hands the child process as ADT_CLI_HOME.
			targets.push({ dir: join(getConnectorHome(this.getUsersRoot(), userId, connector.id), ".adt-cli"), tier: "global" });
		}

		for (const file of [ADT_PULL_CONFIG_FILE, ADT_ABAPLINT_FILE]) {
			const source = join(bundledRoot, file);
			if (!existsSync(source)) {
				log.logWarning("[sap-adt] bundled config missing", `${source} — skipped`);
				continue;
			}
			for (const { dir, tier } of targets) {
				const target = join(dir, file);
				if (existsSync(target)) continue;
				try {
					mkdirSync(dir, { recursive: true });
					copyFileSync(source, target);
				} catch (err) {
					log.logWarning("[sap-adt] could not seed config", `${tier} ${target}: ${(err as Error).message}`);
				}
			}
		}
	}

	// Resolve the ADT URL + Kerberos SPN for an SSO connect. The browser only
	// sends a system id from the catalogue; url/spn are accepted as an override
	// so existing callers (and manual REST tests) keep working.
	private resolveSsoTarget(body: { systemId?: unknown; url?: unknown; spn?: unknown }): { systemId?: string; url: string; spn: string } | { error: string } {
		const systemId = body.systemId ? String(body.systemId).trim() : undefined;
		let url = String(body.url ?? "").trim();
		let spn = String(body.spn ?? "").trim();
		if (systemId && (!url || !spn)) {
			const sys = findSapCatalogSystem(systemId);
			if (!sys) return { error: `Unknown system "${systemId}"` };
			url = url || sys.URL;
			spn = spn || sys.spn;
		}
		if (!url || !spn) return { error: "systemId (or url + spn) is required for an SSO connection" };
		return { systemId, url, spn };
	}

	private async createLocalSsoConnection(ctx: { userId: string; workspaceId: string }, req: express.Request, res: express.Response): Promise<void> {
		const body = req.body as { url?: unknown; spn?: unknown; systemId?: unknown; name?: unknown; client?: unknown; language?: unknown };
		const target = this.resolveSsoTarget(body);
		if ("error" in target) {
			res.status(400).json({ error: target.error });
			return;
		}
		const name = this.sanitizeConnectionName(body.name || target.systemId || target.url);
		if (!name) {
			res.status(400).json({ error: "A valid connection name is required" });
			return;
		}
		const client = (body.client ? String(body.client) : "").trim() || DEFAULT_SAP_CLIENT;
		const language = (body.language ? String(body.language) : "").trim() || DEFAULT_SAP_LANGUAGE;

		const result = await this.runBasicSsoLogin(
			ctx.userId,
			{ name, url: target.url, spn: target.spn, client, language },
			this.workspaceStore.getWorkspaceRoot(ctx.workspaceId),
		);
		if (result.exitCode !== 0) {
			// Nothing is persisted on a failed ping: no artifacts folder, no entry in
			// the workspace settings. The profile adt-cli just wrote is left in place
			// so the user can retry without re-entering anything.
			//
			// Keep the whole CLI trace in the server log, but hand the browser only
			// the diagnostic lines: the full -v output is mostly step/http noise that
			// would bury the one line saying what SAP actually answered.
			log.logWarning(`[sap-adt] SSO connect to ${target.url} (${target.spn}) failed`, result.stderr);
			const diagnostics = result.stderr
				.split(/\r?\n/)
				.filter((line) => /\b(ERR|WARN)\b/.test(line))
				.join("\n")
				.trim();
			res.status(502).json({ error: diagnostics || result.stderr || "SSO connection verification failed" });
			return;
		}

		const connection: SapConnection = {
			name,
			authType: "sso",
			url: target.url,
			spn: target.spn,
			systemId: target.systemId,
			client,
			language,
			status: "connected",
			createdAt: new Date().toISOString(),
		};
		await this.setDefaultProfile(ctx.userId, name);
		this.writeConnectionSidecars(ctx.userId, ctx.workspaceId, connection);

		const next = this.workspaceStore.getSapConnections(ctx.userId, ctx.workspaceId).filter((c) => c.name !== name);
		next.push(connection);
		this.workspaceStore.setSapConnections(ctx.userId, ctx.workspaceId, next);
		res.json({ connection, defaultProfile: this.readDefaultProfile(ctx.userId) });
	}

	// POST /workspaces/:id/sap-adt/connections
	private async handleSapCreateConnection(req: express.Request, res: express.Response): Promise<void> {
		const ctx = this.assertWorkspaceRole(req, res, true);
		if (!ctx) return;
		if (["local", "sso"].includes(String((req.body as { mode?: unknown }).mode ?? "").trim().toLowerCase())) {
			await this.createLocalSsoConnection(ctx, req, res);
			return;
		}
		const body = req.body as { destination?: unknown; name?: unknown; client?: unknown; language?: unknown };
		const destination = String(body.destination ?? "").trim();
		if (!destination) {
			res.status(400).json({ error: "destination is required" });
			return;
		}
		const name = this.sanitizeConnectionName(body.name || destination);
		if (!name) {
			res.status(400).json({ error: "A valid connection name is required" });
			return;
		}
		const client = body.client ? String(body.client) : undefined;
		const language = body.language ? String(body.language) : undefined;
		const userJwt = this.extractUserJwt(req);

		const folder = join(this.workspaceStore.getWorkspaceRoot(ctx.workspaceId), "artifacts", name);
		mkdirSync(folder, { recursive: true });

		const argv = ["-q", "auth", "login", "destination", "--destination", destination, "--name", name];
		if (client) argv.push("--client", client);
		if (language) argv.push("--language", language);
		// The JWT deliberately stays out of argv: adt-cli would have written it to
		// its profile file, where any process of this user could read it back. It
		// travels as ADT_USER_JWT instead (see runAdtCli), which auth.js reads
		// first anyway. //IYH1HC no-secret-on-disk
		const result = await this.runAdtCli(ctx.userId, argv, { userJwt, cwd: folder, profileName: name, destinationName: destination, routerBase: this.resolveRouterBase(req) });
		const connected = result.exitCode === 0;

		const connection: SapConnection = {
			name,
			destinationName: destination,
			client,
			language,
			status: connected ? "connected" : "error",
			createdAt: new Date().toISOString(),
		};

		//IYH1HC adt-config tiers
		// Was an inline sidecar write that bypassed writeConnectionSidecars, so this
		// flow would have been the one connection type that never got the config
		// seeds. Same split as before: descriptor always, tree + seeds on success.
		if (connected) {
			this.writeConnectionSidecars(ctx.userId, ctx.workspaceId, connection);
			await this.setDefaultProfile(ctx.userId, name);
		} else {
			this.writeConnectionDescriptor(folder, connection);
		}
		const next = this.workspaceStore.getSapConnections(ctx.userId, ctx.workspaceId).filter((c) => c.name !== name);
		next.push(connection);
		this.workspaceStore.setSapConnections(ctx.userId, ctx.workspaceId, next);

		if (!connected) {
			res.status(502).json({ connection, error: result.stderr || "Connection verification failed" });
			return;
		}
		res.json({ connection, defaultProfile: this.readDefaultProfile(ctx.userId) });
	}

	// DELETE /workspaces/:id/sap-adt/connections/:name
	private async handleSapDeleteConnection(req: express.Request, res: express.Response): Promise<void> {
		const ctx = this.assertWorkspaceRole(req, res, true);
		if (!ctx) return;
		const name = this.sanitizeConnectionName(req.params.name);
		if (!name) {
			res.status(400).json({ error: "A valid connection name is required" });
			return;
		}
		const userJwt = this.extractUserJwt(req);
		// Best-effort profile removal; ignore failures (profile may already be gone).
		await this.runAdtCli(ctx.userId, ["-q", "auth", "profile", "delete", name], { userJwt });
		const next = this.workspaceStore.getSapConnections(ctx.userId, ctx.workspaceId).filter((c) => c.name !== name);
		this.workspaceStore.setSapConnections(ctx.userId, ctx.workspaceId, next);
		// Disconnecting also drops the mirrored object tree: everything under the
		// connection folder is a projection of the SAP system and is re-fetchable,
		// so leaving it behind would only strand a folder no longer backed by a profile.
		// `name` is sanitized above, so this can only ever target artifacts/<name>.
		rmSync(this.sapConnDir(ctx.workspaceId, name), { recursive: true, force: true });
		// adt-cli nulls defaultProfile when the deleted profile was the default, so this
		// reports "" rather than a dangling name.
		res.json({ ok: true, defaultProfile: this.readDefaultProfile(ctx.userId) });
	}

	// POST /workspaces/:id/sap-adt/connections/:name/refresh
	// Re-runs the discovery ping for a saved connection and rewrites its adt-cli
	// profile (fresh SSO ticket) plus its on-disk descriptor.
	private async handleSapRefreshConnection(req: express.Request, res: express.Response): Promise<void> {
		const ctx = this.assertWorkspaceRole(req, res, true);
		if (!ctx) return;
		const name = this.sanitizeConnectionName(req.params.name);
		const connections = this.workspaceStore.getSapConnections(ctx.userId, ctx.workspaceId);
		const existing = connections.find((c) => c.name === name);
		if (!existing) {
			res.status(404).json({ error: `Connection "${name}" not found` });
			return;
		}

		let result: { stdout: string; stderr: string; exitCode: number };
		if (existing.authType === "sso") {
			const target = this.resolveSsoTarget({ systemId: existing.systemId, url: existing.url, spn: existing.spn });
			if ("error" in target) {
				res.status(400).json({ error: target.error });
				return;
			}
			result = await this.runBasicSsoLogin(
				ctx.userId,
				{ name, url: target.url, spn: target.spn, client: existing.client, language: existing.language },
				// The connection folder, not the workspace root: every other ADT call
				// runs there, and consistency is what keeps the local config layer
				// predictable. //IYH1HC adt-config tiers
				this.sapConnDir(ctx.workspaceId, name),
			);
		} else {
			// BTP destination connections re-verify through the shared adtOpts path.
			result = await this.runAdtCli(ctx.userId, ["-q", "auth", "login", "test", "--name", name], await this.adtOptsFor(ctx, req, name));
		}

		const ok = result.exitCode === 0;
		if (ok) await this.setDefaultProfile(ctx.userId, name);
		const connection: SapConnection = { ...existing, status: ok ? "connected" : "error" };
		this.writeConnectionSidecars(ctx.userId, ctx.workspaceId, connection);
		this.workspaceStore.setSapConnections(
			ctx.userId,
			ctx.workspaceId,
			connections.map((c) => (c.name === name ? connection : c)),
		);
		if (!ok) {
			res.status(502).json({ connection, error: result.stderr || "Refresh failed" });
			return;
		}
		res.json({ ok: true, connection, defaultProfile: this.readDefaultProfile(ctx.userId) });
	}

	// POST /workspaces/:id/sap-adt/connections/:name/activate
	//
	// "The user is now working inside this connection." Called by the UI for actions
	// that touch a connection folder without otherwise reaching SAP — expanding an
	// already-materialized folder, opening an already-hydrated file — so the agent's
	// bare `adt` commands follow the user around. Cheap and idempotent: it no-ops
	// when the profile is already the default.
	private async handleSapActivateConnection(req: express.Request, res: express.Response): Promise<void> {
		const ctx = this.assertWorkspaceRole(req, res, false);
		if (!ctx) return;
		const name = this.sanitizeConnectionName(req.params.name);
		// Only a folder that carries the connection descriptor may claim the default.
		if (!name || !existsSync(connectionPath(this.sapConnDir(ctx.workspaceId, name)))) {
			res.status(404).json({ error: `Connection "${name}" not found` });
			return;
		}
		await this.setDefaultProfile(ctx.userId, name);
		res.json({ ok: true, defaultProfile: name });
	}

	// POST /workspaces/:id/sap-adt/connections/:name/test
	private async handleSapTestConnection(req: express.Request, res: express.Response): Promise<void> {
		const ctx = this.assertWorkspaceRole(req, res, false);
		if (!ctx) return;
		const name = this.sanitizeConnectionName(req.params.name);
		const result = await this.runAdtCli(ctx.userId, ["-q", "auth", "login", "test", "--name", name], await this.adtOptsFor(ctx, req, name));
		const ok = result.exitCode === 0;
		const connections = this.workspaceStore.getSapConnections(ctx.userId, ctx.workspaceId);
		const conn = connections.find((c) => c.name === name);
		if (conn) {
			conn.status = ok ? "connected" : "error";
			this.workspaceStore.setSapConnections(ctx.userId, ctx.workspaceId, connections);
		}
		res.status(ok ? 200 : 502).json({ ok, status: ok ? "connected" : "error", error: ok ? undefined : result.stderr });
	}

	// GET /workspaces/:id/sap-adt/connections/:name/nodes?package=$TMP[&parentType=][&parentName=]
	private async handleSapListNodes(req: express.Request, res: express.Response): Promise<void> {
		const ctx = this.assertWorkspaceRole(req, res, false);
		if (!ctx) return;
		const name = this.sanitizeConnectionName(req.params.name);
		const pkg = String(req.query.package ?? "$TMP");
		const argv = ["-q", "object", "list", "--package", pkg, "--json"];
		if (typeof req.query.parentType === "string" && req.query.parentType) argv.push("--parent-type", req.query.parentType);
		if (typeof req.query.parentName === "string" && req.query.parentName) argv.push("--parent-name", req.query.parentName);
		const result = await this.runAdtCli(ctx.userId, argv, await this.adtOptsFor(ctx, req, name));
		if (result.exitCode !== 0) {
			res.status(502).json({ error: result.stderr || "Failed to list nodes" });
			return;
		}
		let nodes: unknown;
		try {
			nodes = JSON.parse(result.stdout);
		} catch {
			res.status(502).json({ error: "Invalid nodes output", raw: result.stdout });
			return;
		}
		res.json({ nodes });
	}

	// GET /workspaces/:id/sap-adt/connections/:name/source?uri=...
	private async handleSapGetSource(req: express.Request, res: express.Response): Promise<void> {
		const ctx = this.assertWorkspaceRole(req, res, false);
		if (!ctx) return;
		const name = this.sanitizeConnectionName(req.params.name);
		const uri = String(req.query.uri ?? "");
		if (!uri) {
			res.status(400).json({ error: "uri is required" });
			return;
		}
		const result = await this.runAdtCli(ctx.userId, ["-q", "object", "source", uri], await this.adtOptsFor(ctx, req, name));
		if (result.exitCode !== 0) {
			res.status(502).json({ error: result.stderr || "Failed to read source" });
			return;
		}
		res.json({ source: result.stdout });
	}

	private resolveSapTreeRelKey(workspaceId: string, connName: string, inputPath: string): string | null {
		if (!inputPath) return null;
		let p = String(inputPath).replace(/\\/g, "/").replace(/^\/+/, "");
		const fullPrefix = `workspaces/${workspaceId}/artifacts/`;
		if (p.startsWith(fullPrefix)) p = p.slice(fullPrefix.length);
		else if (p.startsWith("artifacts/")) p = p.slice("artifacts/".length);
		if (p === connName) return "";
		const connPrefix = `${connName}/`;
		if (!p.startsWith(connPrefix)) return null;
		const relKey = p.slice(connPrefix.length);
		if (!relKey || relKey.split("/").some((seg) => seg === "." || seg === "..")) return null;
		return relKey;
	}

	private sapConnDir(workspaceId: string, connName: string): string {
		return join(this.workspaceStore.getWorkspaceRoot(workspaceId), "artifacts", connName);
	}

	// POST /workspaces/:id/sap-adt/connections/:name/tree/expand  body { path }
	private async handleSapExpandTree(req: express.Request, res: express.Response): Promise<void> {
		const ctx = this.assertWorkspaceRole(req, res, false);
		if (!ctx) return;
		const name = this.sanitizeConnectionName(req.params.name);
		const connDir = this.sapConnDir(ctx.workspaceId, name);
		const relKey = this.resolveSapTreeRelKey(ctx.workspaceId, name, String((req.body as { path?: unknown })?.path ?? ""));
		if (relKey == null) {
			res.status(400).json({ error: "Invalid path" });
			return;
		}
		const manifest = readManifest(connDir);
		const entry = manifest.entries[relKey];
		if (!entry || entry.kind !== "package" || !entry.adtParentType || !entry.adtParentName) {
			res.status(404).json({ error: "Not an expandable ADT node" });
			return;
		}
		if (entry.loaded) {
			res.json({ ok: true, alreadyLoaded: true });
			return;
		}
		const argv = ["-q", "object", "list", "--parent-type", entry.adtParentType, "--parent-name", entry.adtParentName, "--json"];
		const result = await this.runAdtCli(ctx.userId, argv, await this.adtOptsFor(ctx, req, name));
		if (result.exitCode !== 0) {
			res.status(502).json({ error: result.stderr || "Failed to expand node" });
			return;
		}
		let listed: AdtListResult;
		try {
			listed = JSON.parse(result.stdout) as AdtListResult;
		} catch {
			res.status(502).json({ error: "Invalid object list output", raw: result.stdout });
			return;
		}
		const plan = planChildren(listed);
		applyPlan(connDir, relKey, plan, manifest);
		entry.loaded = true;
		writeManifest(connDir, manifest);
		res.json({ ok: true, count: plan.length });
	}

	// Does this ABAP package exist on the connected system? Answered by the repository
	// information system, which is the one lookup that behaves the same on every ADT
	// release. Returns a verdict rather than writing the response so the caller keeps
	// one place where the request is answered.
	private async verifyPackageExists(
		userId: string,
		pkg: string,
		opts: { userJwt?: string; cwd?: string; profileName?: string; destinationName?: string; routerBase?: string },
	): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
		const probe = await this.runAdtCli(userId, ["-q", "object", "search", pkg, "--type", "DEVC/K", "--max", "10", "--json"], opts);
		if (probe.exitCode !== 0) {
			// A missing package is an empty result set, not a failure, so anything
			// that fails here is real (auth, network) and is reported verbatim.
			return { ok: false, status: 502, error: probe.stderr || "Failed to look up the package" };
		}
		let found: boolean;
		try {
			// The search is exact-match, but compare the name anyway so a fuzzier
			// backend could never satisfy "Z001" with "Z0011".
			const { results } = JSON.parse(probe.stdout) as { results?: { name?: string }[] };
			found = (results ?? []).some((r) => String(r.name ?? "").toUpperCase() === pkg);
		} catch {
			return { ok: false, status: 502, error: "Invalid object search output" };
		}
		return found ? { ok: true } : { ok: false, status: 404, error: `Package ${pkg} was not found on this system` };
	}

	// POST /workspaces/:id/sap-adt/connections/:name/tree/package  body { package }
	//
	// Adds an ABAP package as a root of the connection's object tree. Connecting
	// materializes nothing, so this is the only way objects get into the tree.
	//
	// A nodestructure call for an unknown package succeeds with an empty node list,
	// so an empty listing still has to be told apart from a typo before a folder is
	// created. That check runs only when the listing IS empty: every adt-cli call is
	// a fresh process with its own SPNEGO handshake, so ordering it the other way
	// round made the common case pay for a second one it never needed.
	//
	// The check is deliberately not a GET on /sap/bc/adt/packages/<name>: that
	// resource only exists on newer ADT backends. An R/3 system answers it with
	// 404 "No suitable resource found" for every package, which made this handler
	// report every package on such a system as missing.
	private async handleSapAddPackage(req: express.Request, res: express.Response): Promise<void> {
		const ctx = this.assertWorkspaceRole(req, res, true);
		if (!ctx) return;
		const name = this.sanitizeConnectionName(req.params.name);
		const connDir = this.sapConnDir(ctx.workspaceId, name);
		if (!existsSync(manifestPath(connDir))) {
			res.status(404).json({ error: "Connection is not connected" });
			return;
		}
		const pkg = String((req.body as { package?: unknown })?.package ?? "").trim().toUpperCase();
		if (!pkg || !/^[A-Z0-9_$/]{1,60}$/.test(pkg)) {
			res.status(400).json({ error: "A valid ABAP package name is required" });
			return;
		}
		// Timed end to end so the total can be reconciled against the per-spawn
		// [adt-cli] lines: whatever the two do not account for is our own overhead.
		const startedAt = Date.now();
		const opts = await this.adtOptsFor(ctx, req, name);
		log.logInfo(`[add-package] ${name}/${pkg}: setup took ${Date.now() - startedAt}ms`);
		const listed = await this.runAdtCli(ctx.userId, ["-q", "object", "list", "--parent-type", "DEVC/K", "--parent-name", pkg, "--json"], opts);
		if (listed.exitCode !== 0) {
			res.status(502).json({ error: listed.stderr || "Failed to list the package contents" });
			return;
		}
		let contents: AdtListResult;
		try {
			contents = JSON.parse(listed.stdout) as AdtListResult;
		} catch {
			res.status(502).json({ error: "Invalid object list output", raw: listed.stdout });
			return;
		}
		// An empty listing is either a genuinely empty package or a name that does not
		// exist; only the second must not leave a folder behind.
		if ((contents.nodes ?? []).length === 0) {
			const verdict = await this.verifyPackageExists(ctx.userId, pkg, opts);
			if (!verdict.ok) {
				res.status(verdict.status).json({ error: verdict.error });
				return;
			}
		}
		const materializeStartedAt = Date.now();
		const folder = sanitizeFolderName(pkg, pkg);
		const manifest = readManifest(connDir);
		manifest.entries[folder] = { kind: "package", adtParentType: "DEVC/K", adtParentName: pkg, loaded: true };
		mkdirSync(join(connDir, folder), { recursive: true });
		const plan = planChildren(contents);
		applyPlan(connDir, folder, plan, manifest);
		writeManifest(connDir, manifest);
		log.logInfo(
			`[add-package] ${name}/${pkg}: ${plan.length} nodes, materialize ${Date.now() - materializeStartedAt}ms, total ${Date.now() - startedAt}ms`,
		);
		res.json({ ok: true, folder, count: plan.length });
	}

	// POST /workspaces/:id/sap-adt/connections/:name/tree/hydrate  body { path }
	private async handleSapHydrateFile(req: express.Request, res: express.Response): Promise<void> {
		const ctx = this.assertWorkspaceRole(req, res, false);
		if (!ctx) return;
		const name = this.sanitizeConnectionName(req.params.name);
		const connDir = this.sapConnDir(ctx.workspaceId, name);
		const relKey = this.resolveSapTreeRelKey(ctx.workspaceId, name, String((req.body as { path?: unknown })?.path ?? ""));
		if (!relKey) {
			res.status(400).json({ error: "Invalid path" });
			return;
		}
		const manifest = readManifest(connDir);
		const entry = manifest.entries[relKey];
		if (!entry || entry.kind !== "object" || !entry.adtUri) {
			res.status(404).json({ error: "Not an ADT-backed file" });
			return;
		}
		const abs = join(connDir, relKey);
		const existing = existsSync(abs) ? readFileSync(abs, "utf8") : "";
		if (existing.length > 0) {
			res.json({ source: existing, cached: true });
			return;
		}
		const opts = await this.adtOptsFor(ctx, req, name);
		const result = await this.runAdtCli(ctx.userId, ["-q", "object", "source", entry.adtUri], opts);
		if (result.exitCode === 0) {
			writeFileSync(abs, result.stdout);
			res.json({ source: result.stdout });
			return;
		}
		// Objects without a text source (DDIC elements, views, transactions, message
		// classes, authorization objects) have no `/source/main` sub-resource, so the
		// read above 404s. Their content is the ADT object XML itself — fetch it raw,
		// which is what the .xml file name the tree gave them already implies. Only a
		// genuine "not found" falls back; any other failure is reported as-is.
		if (!/\b404\b/.test(result.stderr)) {
			res.status(502).json({ error: result.stderr || "Failed to read source" });
			return;
		}
		const metadata = await this.runAdtCli(ctx.userId, ["-q", "--raw", "http", "request", "GET", entry.adtUri], opts);
		if (metadata.exitCode !== 0) {
			res.status(502).json({ error: result.stderr || "Failed to read source" });
			return;
		}
		writeFileSync(abs, metadata.stdout);
		res.json({ source: metadata.stdout, kind: "metadata" });
	}

	// GET /workspaces/:id/sap-adt/connections/:name/tree/manifest
	private handleSapTreeManifest(req: express.Request, res: express.Response): void {
		const ctx = this.assertWorkspaceRole(req, res, false);
		if (!ctx) return;
		const name = this.sanitizeConnectionName(req.params.name);
		const connDir = this.sapConnDir(ctx.workspaceId, name);
		res.json({ manifest: manifestView(readManifest(connDir)) });
	}

	private handleAgentWorkers(req: express.Request, res: express.Response): void {
		if (!this.features.agentWorkers) {
			res.json({ agents: [] });
			return;
		}
		res.json({
			agents: listConnectorRuntimes("agent-runtime").map((connector) => this.serializeConnector(req, connector)),
		});
	}

	private handleAgentWorkerStatus(req: express.Request, res: express.Response): void {
		if (!this.features.agentWorkers) {
			res.status(404).json({ error: "Agent workers are disabled" });
			return;
		}
		const agent = String(req.params.agent);
		const connector = this.resolveConnector(agent, "agent-runtime");
		if (!connector) {
			res.status(404).json({ error: "Unknown agent worker" });
			return;
		}
		res.json(this.serializeConnector(req, connector));
	}

	private isJsonObject(value: unknown): value is JsonObject {
		return Boolean(value) && typeof value === "object" && !Array.isArray(value);
	}

	private writeGeminiAuthSettings(home: string, authType: "oauth-personal" | "vertex-ai"): void {
		const settingsDir = join(home, ".gemini");
		const settingsPath = join(settingsDir, "settings.json");
		mkdirSync(settingsDir, { recursive: true });

		let settings: JsonObject = {};
		if (existsSync(settingsPath)) {
			try {
				const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
				if (this.isJsonObject(parsed)) settings = parsed;
			} catch {
				settings = {};
			}
		}

		const security = this.isJsonObject(settings.security) ? settings.security : {};
		const auth = this.isJsonObject(security.auth) ? security.auth : {};

		settings.selectedAuthType = authType;
		settings.security = {
			...security,
			auth: {
				...auth,
				selectedType: authType,
			},
		};

		writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
	}

	private prepareConnectorLogin(
		userId: string,
		connector: ConnectorRuntime,
		selectedMode: ConnectorLoginMode | undefined,
		home: string,
	): NodeJS.ProcessEnv {
		const env = this.getConnectorEnv(userId, connector);
		if (connector.id !== "gemini") return env;

		const authType = selectedMode?.id === "gcloud-adc" ? "vertex-ai" : "oauth-personal";
		this.writeGeminiAuthSettings(home, authType);

		if (authType === "vertex-ai") {
			delete env.GEMINI_API_KEY;
			delete env.GOOGLE_API_KEY;
			env.GOOGLE_GENAI_USE_VERTEXAI = "true";
			return env;
		}

		delete env.GEMINI_API_KEY;
		delete env.GOOGLE_API_KEY;
		delete env.GOOGLE_GENAI_USE_VERTEXAI;
		delete env.GOOGLE_GENAI_USE_GCA;
		return env;
	}

	private maybeAutoConfirmConnectorLogin(
		entry: PendingAgentWorkerLogin,
		connector: ConnectorRuntime,
		selectedMode: ConnectorLoginMode | undefined,
	): void {
		if (
			entry.autoConfirmed ||
			!entry.child ||
			connector.id !== "gemini" ||
			selectedMode?.id !== "gemini-cli"
		) return;

		if (!/Opening authentication page in your browser\.\s*Do you want to continue\?\s*\[Y\/n\]:/i.test(entry.output)) {
			return;
		}

		entry.autoConfirmed = true;
		entry.child.stdin.write("Y\n");
	}

	private startConnectorLogin(req: express.Request, res: express.Response, connector: ConnectorRuntime): void {
		const userId = this.getUserId(req);
		const loginId = this.createLoginId();

		const { loginMode } = req.body as { loginMode?: string };
		const selectedMode =
			connector.loginModes?.find((mode) => mode.id === loginMode) ??
			connector.loginModes?.[0];

		const command = selectedMode?.command ?? connector.command;
		const args = selectedMode?.args ?? connector.loginCommand;

		if (!command || !args) {
			res.status(404).json({ error: "Connector login is not configured" });
			return;
		}

		const entry: PendingAgentWorkerLogin = {
			userId,
			connectorId: connector.id,
			status: "pending",
			createdAt: Date.now(),
			output: "",
		};
		this.pendingAgentWorkerLogins.set(loginId, entry);

		const home = ensureConnectorHome(this.getUsersRoot(), userId, connector.id);
		const env = this.prepareConnectorLogin(userId, connector, selectedMode, home);

		const child = spawn(command, args, {
			env,
			cwd: home,
			stdio: ["pipe", "pipe", "pipe"],
		});
		entry.child = child;
		const onData = (chunk: Buffer) => {
			entry.output += chunk.toString("utf-8");
			if (entry.output.length > 20000) entry.output = entry.output.slice(-20000);
			entry.url = entry.url ?? this.extractUrl(entry.output);
			this.maybeAutoConfirmConnectorLogin(entry, connector, selectedMode);
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("error", (err) => {
			entry.status = "error";
			entry.error = err.message;
		});
		child.on("exit", (code) => {
			entry.status = code === 0 ? "complete" : "error";
			if (code !== 0) entry.error = `Login exited with code ${code}`;
			entry.child = undefined;
		});

		res.status(201).json({
			loginId,
			loginMode: selectedMode?.id,
			agent: connector.id,
			connector: connector.id,
			label: connector.label,
			status: entry.status,
			url: entry.url,
			output: entry.output,
			statusUrl: `/auth/connectors/${encodeURIComponent(connector.id)}/login/${encodeURIComponent(loginId)}`,
			inputUrl: `/auth/connectors/${encodeURIComponent(connector.id)}/login/${encodeURIComponent(loginId)}/input`,
		});
	}

	private handleAgentWorkerLogin(req: express.Request, res: express.Response): void {
		if (!this.features.agentWorkers) {
			res.status(404).json({ error: "Agent workers are disabled" });
			return;
		}
		const agent = String(req.params.agent);
		const connector = this.resolveConnector(agent, "agent-runtime");
		if (!connector || (!connector.loginModes?.length && (!connector.command || !connector.loginCommand))) {
			res.status(404).json({ error: "Unknown agent worker" });
			return;
		}
		this.startConnectorLogin(req, res, connector);
	}

	private writeConnectorLoginStatus(req: express.Request, res: express.Response, connectorId: string, fieldName: "agent" | "connector"): void {
		const entry = this.pendingAgentWorkerLogins.get(String(req.params.loginId));
		if (!entry || entry.connectorId !== connectorId) {
			res.status(404).json({ error: "Login not found" });
			return;
		}
		res.json({
			status: entry.status,
			[fieldName]: entry.connectorId,
			loginMode: (entry as any).loginMode,
			url: entry.url,
			output: entry.output,
			error: entry.error,
			createdAt: entry.createdAt,
		});
	}

	private handleAgentWorkerLoginStatus(req: express.Request, res: express.Response): void {
		if (!this.features.agentWorkers) {
			res.status(404).json({ error: "Agent workers are disabled" });
			return;
		}
		this.writeConnectorLoginStatus(req, res, String(req.params.agent), "agent");
	}

	private writeConnectorLoginInput(req: express.Request, res: express.Response, connectorId: string): void {
		const entry = this.pendingAgentWorkerLogins.get(String(req.params.loginId));
		if (!entry || entry.connectorId !== connectorId) {
			res.status(404).json({ error: "Login not found" });
			return;
		}
		const { input } = req.body as { input?: string };
		if (entry.status !== "pending" || !entry.child || input === undefined) {
			res.status(409).json({ error: `Login is ${entry.status}` });
			return;
		}
		entry.child.stdin.write(`${input}\n`);
		res.json({ ok: true, status: entry.status });
	}

	private handleAgentWorkerLoginInput(req: express.Request, res: express.Response): void {
		if (!this.features.agentWorkers) {
			res.status(404).json({ error: "Agent workers are disabled" });
			return;
		}
		this.writeConnectorLoginInput(req, res, String(req.params.agent));
	}

	private logoutConnector(req: express.Request, res: express.Response, connector: ConnectorRuntime): void {
		const userId = this.getUserId(req);
		const home = getConnectorHome(this.getUsersRoot(), userId, connector.id);

		const removeHome = () => {
			try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
		};

		if (connector.command && connector.logoutCommand) {
			const child = spawn(connector.command, connector.logoutCommand, {
				env: this.getConnectorEnv(userId, connector),
				cwd: home,
				stdio: ["ignore", "ignore", "ignore"],
			});
			child.once("exit", removeHome);
			child.once("error", removeHome);
			res.json({ ok: true });
		} else {
			removeHome();
			res.json({ ok: true });
		}
	}

	private handleAgentWorkerLogout(req: express.Request, res: express.Response): void {
		if (!this.features.agentWorkers) {
			res.status(404).json({ error: "Agent workers are disabled" });
			return;
		}
		const agent = String(req.params.agent);
		const connector = this.resolveConnector(agent, "agent-runtime");
		if (!connector) {
			res.status(404).json({ error: "Unknown agent worker" });
			return;
		}
		this.logoutConnector(req, res, connector);
	}

	private handleWorkspaces(req: express.Request, res: express.Response): void {
		const userId = this.getUserId(req);
		this.workspaceStore.ensureDefaultWorkspace(userId);
		res.json(this.workspaceStore.listWorkspaces(userId));
	}

	private handleCreateWorkspace(req: express.Request, res: express.Response): void {
		const { name, userName, templateId, type } = req.body as { name?: string; userName?: string; templateId?: string; type?: string };
		const userId = this.getUserId(req, userName);
		const workspace = this.workspaceStore.createWorkspace({ name: name || "New workspace", userId, templateId: templateId ?? type });
		res.status(201).json(workspace);
	}

	/**
	 * The primitive tool catalog for the workspace settings Tools tab. Global,
	 * not workspace-scoped — a workspace stores only which of these it enables.
	 * `available` is false for a tool whose backing capability is not configured,
	 * so the UI can stop the user enabling something that will never register.
	 */
	private handleToolCatalog(_req: express.Request, res: express.Response): void {
		const webSearchConfigured = resolveWebSearchConfig() !== undefined;
		res.json({
			// `promptGuidance` is prose for the model, not the UI; drop it.
			tools: TOOL_CATALOG.map(({ promptGuidance: _promptGuidance, ...entry }) => ({
				...entry,
				available: entry.name === "web_search" ? webSearchConfigured : true,
				unavailableReason:
					entry.name === "web_search" && !webSearchConfigured
						? "Set WEB_SEARCH_PROVIDER and WEB_SEARCH_API_KEY to enable web search."
						: undefined,
			})),
		});
	}

	private handleWorkspaceSettings(req: express.Request, res: express.Response): void {
		try {
			res.json(this.workspaceStore.getWorkspaceSettings(this.getUserId(req), String(req.params.workspaceId)));
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	private handleUpdateWorkspaceSettings(req: express.Request, res: express.Response): void {
		try {
			res.json(this.workspaceStore.updateWorkspaceSettings(this.getUserId(req), String(req.params.workspaceId), req.body ?? {}));
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	private async handleWorkspaceSandbox(req: express.Request, res: express.Response): Promise<void> {
		try {
			const userId = this.getUserId(req);
			const workspaceId = String(req.params.workspaceId);
			this.workspaceStore.assertWorkspaceAccess(userId, workspaceId);
			const workspaceRoot = this.workspaceStore.getWorkspaceRoot(workspaceId);
			res.json(await getWorkspaceSandboxStatus(this.sandboxConfig, {
				workspaceId,
				workspaceRoot,
				dataRoot: this.workingDir,
				usersRoot: join(this.workingDir, "users"),
				memberUserIds: this.workspaceStore.getWorkspaceMembers(workspaceId).map((member) => member.userId),
				image: this.workspaceStore.getWorkspaceSandboxImage(workspaceId),
			}));
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	private handleWorkspaceEvents(req: express.Request, res: express.Response): void {
		if (!this.features.reminders) {
			res.json({ events: [] });
			return;
		}
		try {
			const userId = this.getUserId(req);
			const workspaceId = String(req.params.workspaceId);
			this.workspaceStore.assertWorkspaceAccess(userId, workspaceId);
			const eventsDir = join(this.workspaceStore.getWorkspaceRoot(workspaceId), "events");
			if (!existsSync(eventsDir)) {
				res.json({ events: [] });
				return;
			}

			const events = readdirSync(eventsDir, { withFileTypes: true })
				.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
				.map((entry) => {
					const filePath = join(eventsDir, entry.name);
					const content = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
					let data: Record<string, unknown> = {};
					let valid = true;
					let error: string | undefined;
					try {
						data = JSON.parse(content) as Record<string, unknown>;
					} catch (err) {
						valid = false;
						error = err instanceof Error ? err.message : String(err);
					}
					return {
						filename: entry.name,
						type: typeof data.type === "string" ? data.type : "unknown",
						channelId: typeof data.channelId === "string" ? data.channelId : "",
						text: typeof data.text === "string" ? data.text : "",
						at: typeof data.at === "string" ? data.at : undefined,
						schedule: typeof data.schedule === "string" ? data.schedule : undefined,
						timezone: typeof data.timezone === "string" ? data.timezone : undefined,
						modifiedAt: existsSync(filePath) ? Math.round(statSync(filePath).mtimeMs) : 0,
						valid,
						error,
					};
				})
				.sort((a, b) => a.filename.localeCompare(b.filename));
			res.json({ events });
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	private handleDeleteWorkspaceEvent(req: express.Request, res: express.Response): void {
		if (!this.features.reminders) {
			res.status(403).json({ error: "Reminders are disabled" });
			return;
		}
		try {
			const userId = this.getUserId(req);
			const workspaceId = String(req.params.workspaceId);
			const filename = basename(decodeURIComponent(String(req.params.filename)));
			if (!filename || filename !== decodeURIComponent(String(req.params.filename)) || !filename.endsWith(".json")) {
				res.status(400).json({ error: "Invalid event filename" });
				return;
			}
			this.workspaceStore.assertWorkspaceAccess(userId, workspaceId);
			const filePath = join(this.workspaceStore.getWorkspaceRoot(workspaceId), "events", filename);
			if (existsSync(filePath)) rmSync(filePath, { force: true });
			res.json({ ok: true });
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	private getDatabaseFromFile(req: express.Request, res: express.Response): WorkspaceDatabase | undefined {
		const dbPath = String(req.query.path ?? "");
		const resolved = this.resolveReadableWorkspaceFile(req, dbPath, res);
		if (!resolved) return undefined;
		if (!resolved.toLowerCase().endsWith(".duckdb")) {
			res.status(400).json({ error: "Not a DuckDB file" });
			return undefined;
		}
		return new WorkspaceDatabase(resolved);
	}

	private handleDatabaseTables(req: express.Request, res: express.Response): void {
		const db = this.getDatabaseFromFile(req, res);
		if (!db) return;
		res.json({
			database: db.filename,
			available: db.exists,
			tables: db.listTables(),
		});
	}

	private handleDatabaseRows(req: express.Request, res: express.Response): void {
		const db = this.getDatabaseFromFile(req, res);
		if (!db) return;
		const tableName = decodeURIComponent(String(req.params.tableName));
		const table = db.getTableRows(tableName, {
			limit: Number(req.query.limit ?? 100),
			offset: Number(req.query.offset ?? 0),
		});
		if (!table) {
			res.status(404).json({ error: "Table not found" });
			return;
		}
		res.json(table);
	}

	private handleWorkspaceSessions(req: express.Request, res: express.Response): void {
		const userId = this.getUserId(req);
		const workspaceId = String(req.params.workspaceId);
		try {
			res.json(this.workspaceStore.listSessions(userId, workspaceId));
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	private handleListWorks(req: express.Request, res: express.Response): void {
		const userId = this.getUserId(req);
		const workspaceId = String(req.params.workspaceId);
		try {
			res.json(this.workspaceStore.listWorks(userId, workspaceId));
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	private handleCreateWorkOrder(req: express.Request, res: express.Response): void {
		const userId = this.getUserId(req);
		const workspaceId = String(req.params.workspaceId);
		const { title, description } = req.body as { title?: string; description?: string };
		if (!title) {
			res.status(400).json({ error: "Missing title" });
			return;
		}
		try {
			const workOrder = this.workspaceStore.createWorkOrder({ workspaceId, userId, title, description });
			res.status(201).json(workOrder);
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	private handleCreateWorkItem(req: express.Request, res: express.Response): void {
		const userId = this.getUserId(req);
		const workspaceId = String(req.params.workspaceId);
		const { workOrderId, title, description } = req.body as { workOrderId?: string; title?: string; description?: string };
		if (!workOrderId || !title) {
			res.status(400).json({ error: "Missing workOrderId or title" });
			return;
		}
		try {
			const workItem = this.workspaceStore.createWorkItem({ workspaceId, userId, workOrderId, title, description });
			res.status(201).json(workItem);
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	// Permanently delete a session: abort any active run, evict in-memory state,
	// remove the session dir, and propagate the delete to the object-store mirror
	// (a workspace-scoped snapshot alone would restore it on next boot).
	private async handleDeleteSession(req: express.Request, sessionId: string, res: express.Response): Promise<void> {
		const userId = this.getUserId(req);
		const session = this.workspaceStore.findSession(sessionId);
		if (!session) {
			res.status(404).json({ error: "Session not found" });
			return;
		}
		try {
			this.workspaceStore.assertWorkspaceAccess(userId, session.workspaceId);
			await this.handler.disposeSession?.(sessionId);
			const result = this.workspaceStore.deleteSession(userId, sessionId);
			if (!result) {
				res.status(404).json({ error: "Session not found" });
				return;
			}
			void this.objectStore?.deleteObjectsUnder(result.sessionRoot)
				.catch((err) => log.logWarning("[object-store] delete propagation error", err instanceof Error ? err.message : String(err)));
			res.json({ ok: true });
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	private handleCreateSession(req: express.Request, res: express.Response): void {
		const { title, userName, workOrderId, workItemId, workOrder, workItem } = req.body as {
			title?: string;
			userName?: string;
			workOrderId?: string;
			workItemId?: string;
			workOrder?: string;
			workItem?: string;
		};
		const userId = this.getUserId(req, userName);
		const workspaceId = String(req.params.workspaceId);
		try {
			const session = this.workspaceStore.createSession({
				workspaceId,
				userId,
				title,
				workOrderId: workOrderId ?? workOrder,
				workItemId: workItemId ?? workItem,
			});
			res.status(201).json(session);
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	private async handleChat(req: express.Request, res: express.Response, routeSessionId?: string): Promise<void> {
		type AttachmentPayload = { fileName: string; mimeType: string; content: string };
		const { channelId, sessionId: bodySessionId, workspaceId, text, userName = "user", attachments = [], mentions = [], skills = [], model: modelSel, structured = false, workOrderId, workItemId, workOrder, workItem, activityId, activity } = req.body as {
			channelId?: string; sessionId?: string; workspaceId?: string; text?: string; userName?: string; attachments?: AttachmentPayload[];
			mentions?: MentionPayload[];
			/** Skill names the user invoked with `/name`. */
			skills?: string[];
			model?: { provider?: string; modelId?: string };
			structured?: boolean;
			workOrderId?: string;
			workItemId?: string;
			workOrder?: string;
			workItem?: string;
			activityId?: string;
			activity?: string;
		};
		const sessionId = routeSessionId || bodySessionId || channelId;
		const userId = this.getUserId(req, userName);
		const resolvedUserName = this.getUserName(req, userName);

		let resolvedModel: BotContext["model"];
		if (modelSel?.provider && modelSel?.modelId && this.isAllowedLlmProvider(modelSel.provider)) {
			const encrypted = await this.auth.getStore().getProviderKey(userId, modelSel.provider);
			let apiKey: string | undefined;
			if (encrypted) {
				try {
					apiKey = decryptSecret(encrypted);
				} catch (err) {
					log.logWarning("[llm] failed to decrypt provider key", err instanceof Error ? err.message : String(err));
				}
			}
			resolvedModel = { provider: modelSel.provider, modelId: modelSel.modelId, apiKey };
		} else if ((modelSel?.provider === "custom" || modelSel?.provider === "octo-router" || modelSel?.provider === "bosch-genai") && modelSel?.modelId) {
			const cm = await this.auth.getStore().getCustomModel(userId, modelSel.modelId);
			if (cm) {
				let apiKey: string | undefined;
				try {
					apiKey = decryptSecret(cm.encryptedKey);
				} catch (err) {
					log.logWarning("[llm] failed to decrypt custom model key", err instanceof Error ? err.message : String(err));
				}
				// For an OpenAI base provider, use the classic Chat Completions API and normalise
				// the endpoint. The OpenAI client appends /chat/completions and drops any query, so
				// the user's full Azure URL (…/deployments/<dep>/chat/completions?api-version=…) is
				// reduced to its deployment base here; the bosch-genai fetch adapter re-attaches the
				// api-version query + api-key header at request time. The Responses API default
				// ({endpoint}/responses) is not exposed by these gateways → 404.
				// google/anthropic ride the farm's Vertex publisher endpoint
				// (api/google/v1/publishers/{pub}/models/{id}:{method}); the adapter splits the
				// pasted URL into the SDK baseUrl + real model id and bridges auth/body at fetch
				// time. Falls back to cm.name when the URL carries no model segment.
				const isOpenAiBase = cm.baseProvider === "openai";
				let baseUrl: string;
				let modelId = cm.name;
				const isOcto = modelSel.provider === "octo-router";
				if (isOpenAiBase) {
					baseUrl = isOcto ? prepareOctoRouterOpenAIEndpoint(cm.endpoint) : prepareBoschOpenAIEndpoint(cm.endpoint);
				} else if (cm.baseProvider === "google") {
					if (isOcto) {
						baseUrl = prepareOctoRouterGoogleEndpoint(cm.endpoint);
					} else {
						const g = prepareBoschGoogleEndpoint(cm.endpoint);
						baseUrl = g.baseUrl;
						modelId = g.modelId ?? modelId;
					}
				} else {
					if (isOcto) {
						baseUrl = prepareOctoRouterAnthropicEndpoint(cm.endpoint, cm.routing);
					} else {
						const a = prepareBoschAnthropicEndpoint(cm.endpoint);
						baseUrl = a.baseUrl;
						modelId = a.modelId ?? modelId;
					}
				}
				resolvedModel = {
					provider: cm.baseProvider,   // openai|google|anthropic → drives header/body format
					modelId,
					apiKey,
					baseUrl,
					apiType: isOpenAiBase ? "openai-completions" : undefined,
				};
			}
		}
		// make the per-run model resolution visible in the server log so users
		// can verify the picker selection drives the outbound call (model self-reports lie).
		// A selection that cannot be resolved silently falls back to the default env model —
		// surface that as a warning instead of leaving it invisible.
		if (modelSel?.provider && modelSel?.modelId) {
			if (resolvedModel) {
				log.logInfo(
					`[llm] run model: ${resolvedModel.provider}/${resolvedModel.modelId}` +
					(resolvedModel.baseUrl ? ` @ ${resolvedModel.baseUrl}` : ""),
				);
			} else {
				log.logWarning(
					`[llm] model selection ${modelSel.provider}/${modelSel.modelId} could not be resolved; falling back to the default model`,
				);
			}
		}

		if (!sessionId || !text) {
			res.status(400).json({ error: "Missing sessionId or text" });
			return;
		}

		const session = this.workspaceStore.ensureSession({
			sessionId,
			workspaceId,
			userId,
			workOrderId: workOrderId ?? workOrder,
			workItemId: workItemId ?? workItem,
		});
		try {
			this.workspaceStore.assertWorkspaceAccess(userId, session.workspaceId);
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
			return;
		}
		const workspaceRoot = this.workspaceStore.getWorkspaceRoot(session.workspaceId);

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		res.flushHeaders();
		res.write(":ok\n\n");

		const send: SseEmitter = (event) => {
			if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
		};

		const ts = (Date.now() / 1000).toFixed(6);
		const channelDir = join(workspaceRoot, "sessions", sessionId);
		if (!existsSync(channelDir)) mkdirSync(channelDir, { recursive: true });

		const savedAttachments: Array<{ local: string }> = [];
		if (attachments.length > 0) {
			const attachDir = join(channelDir, "attachments");
			if (!existsSync(attachDir)) mkdirSync(attachDir, { recursive: true });
			// One stamp for the whole batch: a picked folder keeps its files together under
			// a single stamped root instead of scattering them across per-file directories.
			const stamp = Date.now();
			for (const att of attachments) {
				const stored = this.storeAttachment(attachDir, att.fileName, att.content, stamp);
				if (!stored) {
					log.logWarning("[attachments] dropped", String(att.fileName));
					continue;
				}
				savedAttachments.push({ local: `sessions/${sessionId}/attachments/${stored}` });
			}
		}

		const resolvedMentions = mentions.length > 0 ? this.resolveMentions(req, mentions, workspaceRoot, sessionId) : [];
		const resolvedSkills = skills.length > 0 ? this.resolveSkills(skills, workspaceRoot, sessionId) : [];

		const ctx = createHttpContext({
			channelId: sessionId,
			userName: resolvedUserName,
			text,
			ts,
			send,
			workingDir: workspaceRoot,
			attachments: savedAttachments,
			mentions: resolvedMentions,
			skills: resolvedSkills,
			userId,
			authFilePath: this.getUserAuthFilePath(userId),
			model: resolvedModel,
			structured,
			//IYH1HC capability tool add
			// The native `adt` tool reads these off the turn's context. Same two values
			// the ticket registry below stores; kept separate so neither path depends on
			// the other while both are running.
			sap: { userJwt: this.extractUserJwt(req), routerBase: this.resolveRouterBase(req) },
		});
		ctx.activityId = activityId ?? activity;

		appendFileSync(
			join(channelDir, "log.jsonl"),
			`${JSON.stringify({ date: new Date().toISOString(), ts, user: userId, userName: resolvedUserName, text, attachments: savedAttachments, mentions: resolvedMentions, skills: resolvedSkills, isBot: false })}\n`,
		);

		log.logInfo(`[${sessionId}] HTTP: Starting run: ${text.substring(0, 50)}`);

		//IYH1HC SAP ADT add
		// Lend this turn's ADT capability to the agent for as long as the turn runs. This
		// is the only place that has both the request (so the user token and the router
		// base) and the whole span of the agent run. The ticket travels through a file
		// rather than the environment because the agent's env is captured once when its
		// runner is built and reused for every later turn, while a token is not.
		/* const adtTicket = randomBytes(32).toString("hex");
		const adtBrokerFile = join(workspaceRoot, ".octo", "adt-broker.json");
		this.adtTurns.set(adtTicket, {
			userId,
			workspaceId: session.workspaceId,
			jwt: this.extractUserJwt(req),
			routerBase: this.resolveRouterBase(req),
		});
		mkdirSync(dirname(adtBrokerFile), { recursive: true });
		writeFileSync(
			adtBrokerFile,
			JSON.stringify({ url: `http://127.0.0.1:${this.port}/internal/adt-exec`, ticket: adtTicket }),
		); */

		try {
			await this.handler.handleEvent(sessionId, ctx);
			ctx.flushAgentEvents?.();
			send({ type: "done" });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.logWarning(`[${sessionId}] HTTP run error`, msg);
			send({ type: "error", message: msg });
		} finally {
			//IYH1HC SAP ADT add
			// The capability dies with the turn: the ticket stops resolving and the file
			// the script reads it from is gone.
			//this.adtTurns.delete(adtTicket);
			//rmSync(adtBrokerFile, { force: true });
			ctx.flushAgentEvents?.();
			res.end();
		}
	}

	private async handleStop(req: express.Request, res: express.Response): Promise<void> {
		const { channelId } = req.body as { channelId?: string };
		if (!channelId) {
			res.status(400).json({ error: "Missing channelId" });
			return;
		}
		const session = this.workspaceStore.findSession(channelId);
		if (!session) {
			res.status(404).json({ error: "Session not found" });
			return;
		}
		try {
			this.workspaceStore.assertWorkspaceAccess(this.getUserId(req), session.workspaceId);
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
			return;
		}

		if (this.handler.isRunning(channelId)) {
			await this.handler.handleStop(channelId, async () => {}, async () => {});
			res.json({ ok: true, message: "Stopping..." });
		} else {
			res.json({ ok: false, message: "Nothing running" });
		}
	}

	private handleStatus(req: express.Request, channelId: string, res: express.Response): void {
		const session = this.workspaceStore.findSession(channelId);
		if (!session) {
			res.status(404).json({ error: "Session not found" });
			return;
		}
		try {
			this.workspaceStore.assertWorkspaceAccess(this.getUserId(req), session.workspaceId);
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
			return;
		}
		res.json({ running: this.handler.isRunning(channelId) });
	}

	private getAuthorizedSession(req: express.Request, channelId: string, res: express.Response) {
		const session = this.workspaceStore.findSession(channelId);
		if (!session) {
			res.status(404).json({ error: "Session not found" });
			return undefined;
		}
		try {
			this.workspaceStore.assertWorkspaceAccess(this.getUserId(req), session.workspaceId);
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
			return undefined;
		}
		return session;
	}

	/** Resolves the session-state store for a session, or null when unauthorized. */
	private getSessionStateStore(
		req: express.Request,
		channelId: string,
		res: express.Response,
	): SessionStateStore | null {
		const session = this.getAuthorizedSession(req, channelId, res);
		if (!session) return null;
		const workspaceRoot = this.workspaceStore.getWorkspaceRoot(session.workspaceId);
		return new SessionStateStore(channelId, join(workspaceRoot, "sessions", channelId));
	}

	private handleSessionMode(req: express.Request, channelId: string, res: express.Response): void {
		const store = this.getSessionStateStore(req, channelId, res);
		if (!store) return;
		res.json({ mode: store.getMode(), todos: store.getTodos() });
	}

	/**
	 * Switches a session between normal and plan mode. In plan mode the agent is
	 * restricted to read-only tools until it calls `exit_plan_mode`.
	 */
	private handleSetSessionMode(req: express.Request, channelId: string, res: express.Response): void {
		const requested = (req.body as { mode?: unknown } | undefined)?.mode;
		if (requested !== "plan" && requested !== "default") {
			res.status(400).json({ ok: false, error: 'mode must be "plan" or "default"' });
			return;
		}
		const store = this.getSessionStateStore(req, channelId, res);
		if (!store) return;
		store.setMode(requested);
		res.json({ ok: true, mode: store.getMode() });
	}

	private handleAcpJobs(req: express.Request, channelId: string, res: express.Response): void {
		const session = this.getAuthorizedSession(req, channelId, res);
		if (!session) return;
		if (!this.features.agentWorkers) {
			res.json({ jobs: [] });
			return;
		}
		const workspaceRoot = this.workspaceStore.getWorkspaceRoot(session.workspaceId);
		res.json({ jobs: listAcpJobs(workspaceRoot, channelId) });
	}

	private handleCancelAcpJob(req: express.Request, channelId: string, jobId: string, res: express.Response): void {
		const session = this.getAuthorizedSession(req, channelId, res);
		if (!session) return;
		if (!this.features.agentWorkers) {
			res.status(403).json({ ok: false, error: "Agent workers are disabled" });
			return;
		}
		const workspaceRoot = this.workspaceStore.getWorkspaceRoot(session.workspaceId);
		const ok = cancelAcpJob(workspaceRoot, jobId);
		res.json({ ok });
	}

	private handleArtifactUrl(req: express.Request, filePath: string, res: express.Response): void {
		const resolved = this.resolveReadableWorkspaceFile(req, filePath, res);
		if (!resolved) {
			return;
		}
		let url: string | null = null;

		const tunnelUrlFile = "/tmp/artifacts-url.txt";
		if (existsSync(tunnelUrlFile)) {
			try {
				const tunnelUrl = readFileSync(tunnelUrlFile, "utf-8").trim();
				if (tunnelUrl && !tunnelUrl.includes("localhost") && !tunnelUrl.includes("127.0.0.1")) {
					url = `${tunnelUrl}/file?path=${encodeURIComponent(resolved)}`;
				}
			} catch { /* use local fallback */ }
		}

		res.json({ url });
	}

	private handleWorkspace(req: express.Request, channelId: string, res: express.Response): void {
		// `sapConnection` tags the folder of a SAP ADT connection, which the frontend
		// would otherwise only recognize after separately loading the workspace
		// settings — the reason such folders rendered as ordinary ones on a plain
		// reload. The descriptor now lives inside `.adt/`, which is listed like any
		// other folder: the two config files in it are meant to be opened and edited
		// from the Artifacts panel. //IYH1HC adt-config tiers
		type WorkspaceNode = { name: string; path: string; type: "file" | "directory"; sapConnection?: true; children?: WorkspaceNode[] };

		const makeTree = (rootPath: string, relativeBase: string): WorkspaceNode[] => {
			if (!existsSync(rootPath)) return [];
			const walk = (absDir: string, relDir: string): WorkspaceNode[] => {
				const entries = readdirSync(absDir, { withFileTypes: true })
					.sort((a: Dirent, b: Dirent) => {
						if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
						return a.name.localeCompare(b.name);
					});
				return entries.map((entry) => {
					const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
					const normalizedPath = relativeBase ? `${relativeBase}/${relPath}` : relPath;
					if (entry.isDirectory()) {
						const abs = join(absDir, entry.name);
						const node: WorkspaceNode = {
							name: entry.name,
							path: normalizedPath,
							type: "directory" as const,
							children: walk(abs, relPath),
						};
						if (existsSync(connectionPath(abs))) node.sapConnection = true;
						return node;
					}
					return { name: entry.name, path: normalizedPath, type: "file" as const };
				});
			};
			return walk(rootPath, "");
		};

		const userId = this.getUserId(req);
		const session = this.workspaceStore.findSession(channelId) ?? this.workspaceStore.ensureSession({ sessionId: channelId, userId });
		try {
			this.workspaceStore.assertWorkspaceAccess(userId, session.workspaceId);
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
			return;
		}
		void this.objectStore?.snapshot({ workspaceId: session.workspaceId, sessionId: channelId })
			.catch((err) => log.logWarning("[object-store] workspace snapshot error", err instanceof Error ? err.message : String(err)));
		const workspaceRoot = this.workspaceStore.getWorkspaceRoot(session.workspaceId);
		const artifactsRoot = join(workspaceRoot, "artifacts");
		const workspaceSkillsRoot = join(workspaceRoot, "skills");
		// This session's uploads. Not rendered in the sidebar, but the @-mention
		// picker needs them: a file uploaded earlier in the conversation is exactly
		// the kind of thing a user wants to point at again.
		const attachmentsRoot = join(workspaceRoot, "sessions", channelId, "attachments");

		res.json({
			artifacts: makeTree(artifactsRoot, `workspaces/${session.workspaceId}/artifacts`),
			skills: makeTree(workspaceSkillsRoot, `workspaces/${session.workspaceId}/skills`),
			attachments: makeTree(attachmentsRoot, `workspaces/${session.workspaceId}/sessions/${channelId}/attachments`),
			// Rides along with the tree so the UI can label which connection bare `adt`
			// commands resolve to, without a second round-trip on every reload.
			sapDefaultProfile: this.readDefaultProfile(userId),
		});
	}

	private handleFile(req: express.Request, filePath: string, res: express.Response): void {
		const resolved = this.resolveReadableWorkspaceFile(req, filePath, res);
		if (!resolved) {
			return;
		}

		if (!existsSync(resolved)) {
			res.status(404).json({ error: "Not found" });
			return;
		}

		if (statSync(resolved).isDirectory()) {
			if (req.query.download === "1") {
				void this.sendFolderZip(resolved, res);
			} else {
				res.status(400).json({ error: "Path is a directory" });
			}
			return;
		}

		const ext = extname(resolved).slice(1).toLowerCase();
		const mimeType = BINARY_MIME_TYPES[ext];
		if (mimeType) {
			res.type(mimeType);
		} else if (["abap", "cds", "csn"].includes(ext)) {
			res.type("text/plain");
		}
		if (req.query.download === "1") {
			res.attachment(basename(resolved));
		}

		res.sendFile(resolved);
	}

	// Send a folder to the client as a .zip archive. Artifact folders are small,
	// so the archive is built in memory rather than streamed.
	private async sendFolderZip(dir: string, res: express.Response): Promise<void> {
		try {
			const zip = new JSZip();
			const addDir = (absDir: string, relDir: string) => {
				for (const entry of readdirSync(absDir, { withFileTypes: true })) {
					const abs = join(absDir, entry.name);
					const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
					if (entry.isDirectory()) {
						addDir(abs, rel);
					} else if (entry.isFile()) {
						zip.file(rel, readFileSync(abs));
					}
				}
			};
			addDir(dir, "");
			const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
			res.type("application/zip");
			res.attachment(`${basename(dir)}.zip`);
			res.send(buffer);
		} catch (err) {
			res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	// Delete a workspace file or folder (recursive) and propagate the delete to the
	// object-store mirror (a workspace-scoped snapshot alone would restore it on next boot).
	private handleDeleteFile(req: express.Request, filePath: string, res: express.Response): void {
		const resolved = this.resolveReadableWorkspaceFile(req, filePath, res);
		if (!resolved) {
			return;
		}

		if (!existsSync(resolved)) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		const isDirectory = statSync(resolved).isDirectory();

		try {
			rmSync(resolved, isDirectory ? { recursive: true, force: true } : {});
		} catch (err) {
			res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
			return;
		}
		const propagate = isDirectory
			? this.objectStore?.deleteObjectsUnder(resolved)
			: this.objectStore?.deleteObject(resolved);
		void propagate?.catch((err) => log.logWarning("[object-store] delete propagation error", err instanceof Error ? err.message : String(err)));
		res.json({ ok: true });
	}

	// POST /workspaces/:workspaceId/skills
	// Writes an uploaded skill folder into workspaces/<id>/skills/<name>/, preserving the
	// client's relative paths. Bytes arrive base64-encoded in the JSON body, matching the
	// chat attachment convention (there is no multipart parser in this service).
	private handleUploadSkill(req: express.Request, res: express.Response): void {
		const ctx = this.assertWorkspaceRole(req, res, true);
		if (!ctx) return;

		const { folderName, overwrite = false, files } = req.body as {
			folderName?: unknown;
			overwrite?: boolean;
			files?: Array<{ path?: unknown; content?: unknown }>;
		};

		if (!Array.isArray(files) || files.length === 0) {
			res.status(400).json({ error: "No files to upload" });
			return;
		}
		if (files.length > MAX_SKILL_UPLOAD_FILES) {
			res.status(413).json({ error: `Too many files (${files.length}); the limit is ${MAX_SKILL_UPLOAD_FILES}` });
			return;
		}

		const skillName = this.sanitizeConnectionName(folderName);
		if (!skillName || skillName === "." || skillName === "..") {
			res.status(400).json({ error: "Invalid skill folder name" });
			return;
		}

		const skillRoot = join(this.workspaceStore.getWorkspaceRoot(ctx.workspaceId), "skills", skillName);

		// Validate and decode everything up front so a bad payload cannot leave a
		// half-written skill behind. Paths are relative to the picked folder: absolute
		// paths, drive letters and "." / ".." segments are all rejected rather than
		// normalized away.
		const planned: Array<{ abs: string; bytes: Buffer }> = [];
		const skipped: string[] = [];
		let totalBytes = 0;
		for (const file of files) {
			const raw = String(file?.path ?? "").replace(/\\/g, "/");
			const segments = raw.split("/");
			// Folder pickers prefix every path with the picked folder itself.
			if (segments.length > 1 && this.sanitizeConnectionName(segments[0]) === skillName) segments.shift();
			if (segments.length === 0 || segments.some((seg) => seg === "" || seg === "." || seg === ".." || seg.includes(":"))) {
				res.status(400).json({ error: `Invalid file path: ${raw}` });
				return;
			}
			if (SKILL_UPLOAD_SKIP_NAMES.has(segments[segments.length - 1]) || segments.some((seg) => SKILL_UPLOAD_SKIP_DIRS.has(seg))) {
				skipped.push(segments.join("/"));
				continue;
			}
			const abs = resolve(join(skillRoot, ...segments));
			const rel = relative(skillRoot, abs);
			if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
				res.status(400).json({ error: `Invalid file path: ${raw}` });
				return;
			}
			const bytes = Buffer.from(String(file?.content ?? ""), "base64");
			totalBytes += bytes.byteLength;
			if (totalBytes > MAX_SKILL_UPLOAD_BYTES) {
				res.status(413).json({ error: `Skill folder is too large; the limit is ${Math.floor(MAX_SKILL_UPLOAD_BYTES / (1024 * 1024))} MB` });
				return;
			}
			planned.push({ abs, bytes });
		}

		if (planned.length === 0) {
			res.status(400).json({ error: "No files to upload" });
			return;
		}

		// Checked after validation so a malformed payload reports the real problem
		// instead of a conflict on a name it was never allowed to write.
		if (existsSync(skillRoot) && !overwrite) {
			res.status(409).json({ error: `Skill "${skillName}" already exists`, code: "exists", skillName });
			return;
		}

		try {
			// Replace rather than merge, so files dropped from the new version do not
			// linger. The mirror delete matters too: a workspace snapshot alone would
			// restore the stale files on the next boot.
			if (existsSync(skillRoot)) {
				rmSync(skillRoot, { recursive: true, force: true });
				void this.objectStore
					?.deleteObjectsUnder(skillRoot)
					.catch((err) => log.logWarning("[object-store] skill replace propagation error", err instanceof Error ? err.message : String(err)));
			}
			for (const entry of planned) {
				mkdirSync(dirname(entry.abs), { recursive: true });
				writeFileSync(entry.abs, entry.bytes);
			}
		} catch (err) {
			res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
			return;
		}

		void this.objectStore
			?.snapshot({ workspaceId: ctx.workspaceId })
			.catch((err) => log.logWarning("[object-store] skill upload propagation error", err instanceof Error ? err.message : String(err)));

		res.json({
			ok: true,
			skillName,
			path: `workspaces/${ctx.workspaceId}/skills/${skillName}`,
			fileCount: planned.length,
			skipped,
		});
	}

	private handleMessages(req: express.Request, channelId: string, res: express.Response): void {
		type ContextEntry = { type: string; timestamp?: string; message?: Record<string, any> };
		type ReplayBlock =
			| { kind: "thinking"; content: string }
			| { kind: "text"; content: string }
			| {
				kind: "tool";
				toolCallId: string;
				toolName: string;
				label?: string;
				args: Record<string, any>;
				result?: string;
				resultTruncated?: boolean;
				isError?: boolean;
				durationMs?: number;
				skill?: { name: string; path: string };
			};
		type ChatMessage = {
			role: "user" | "assistant";
			text: string;
			attachments?: string[];
			/** Basenames of files/folders the user tagged with @ on this turn. */
			mentions?: string[];
			thread?: string;
			files?: Array<{ path: string; title?: string }>;
			blocks?: ReplayBlock[];
			usage?: AgentUsage;
			model?: string;
		};

		const formatArgs = (args: Record<string, any>): string => {
			const lines: string[] = [];
			for (const [key, value] of Object.entries(args)) {
				if (key === "label") continue;
				if (key === "path" && typeof value === "string") {
					const range = args.offset !== undefined && args.limit !== undefined
						? `:${args.offset}-${args.offset + args.limit}` : "";
					lines.push(value + range);
					continue;
				}
				if (key === "offset" || key === "limit") continue;
				const str = typeof value === "string" ? value : JSON.stringify(value);
				lines.push(str.length > 300 ? str.slice(0, 300) + "…" : str);
			}
			return lines.join("\n");
		};

		const userId = this.getUserId(req);
		const session = this.workspaceStore.findSession(channelId) ?? this.workspaceStore.ensureSession({ sessionId: channelId, userId });
		try {
			this.workspaceStore.assertWorkspaceAccess(userId, session.workspaceId);
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
			return;
		}
		const workspaceRoot = this.workspaceStore.getWorkspaceRoot(session.workspaceId);
		const contextFile = join(workspaceRoot, "sessions", channelId, "context.jsonl");
		const messages: ChatMessage[] = [];

		const trailDurations = new Map<string, number>();
		const trailSkills = new Map<string, { name: string; path: string }>();
		for (const record of readTrail(join(workspaceRoot, "sessions", channelId))) {
			const ev = record.event;
			if (ev.type === "tool" && ev.phase === "end") trailDurations.set(ev.toolCallId, ev.durationMs);
			else if (ev.type === "skill") trailSkills.set(ev.toolCallId, { name: ev.name, path: ev.path });
		}

		if (existsSync(contextFile)) {
			try {
				const lines = readFileSync(contextFile, "utf-8").trim().split("\n").filter(Boolean);
				const entries: ContextEntry[] = [];
				for (const line of lines) {
					try { entries.push(JSON.parse(line)); } catch { /* skip */ }
				}

				type ToolCall = { id: string; name: string; label?: string; args: Record<string, any> };
				type ToolResult = { toolCallId: string; toolName: string; text: string; isError: boolean };
				type Turn = { userText: string; attachments: string[]; mentions: string[]; toolCalls: ToolCall[]; toolResults: ToolResult[]; assistantTexts: string[]; blocks: ReplayBlock[]; usage?: AgentUsage; model?: string };
				const normalizeAttachedFilePath = (rawPath: string): string => {
					const dockerWorkspacePrefix = `/workspace/workspaces/${session.workspaceId}/`;
					if (rawPath === `/workspace/workspaces/${session.workspaceId}`) return workspaceRoot;
					if (rawPath.startsWith(dockerWorkspacePrefix)) return join(workspaceRoot, rawPath.slice(dockerWorkspacePrefix.length));
					if (rawPath === "/workspace") return workspaceRoot;
					if (rawPath.startsWith("/workspace/")) return join(workspaceRoot, rawPath.slice("/workspace/".length));
					if (isAbsolute(rawPath)) return rawPath;
					if (rawPath.startsWith("workspaces/")) return rawPath;
					if (rawPath.startsWith("artifacts/") || rawPath.startsWith("sessions/") || rawPath.startsWith("skills/")) {
						return join(workspaceRoot, rawPath);
					}
					return join(workspaceRoot, "artifacts", rawPath);
				};

				const stripPrefix = (text: string) =>
					text.replace(/^(?:\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] )?\[[^\]]+\]: /, "");

				const basenameOf = (p: string) => p.split(/[/\\]/).pop() ?? p;

				/**
				 * Both trailing blocks are appended to the user message by the agent, so
				 * they must be lifted back out here or they render as message text.
				 * Mention lines carry a `file:`/`dir:` tag that is stripped for display.
				 */
				const extractAttachments = (text: string): { text: string; attachments: string[]; mentions: string[] } => {
					let rest = text;
					let attachments: string[] = [];
					let mentions: string[] = [];

					const attachMatch = rest.match(/<attachments>\n([\s\S]*?)\n<\/attachments>/);
					if (attachMatch) {
						attachments = attachMatch[1].split("\n").filter(Boolean).map(basenameOf);
						rest = rest.replace(/\n\n<attachments>[\s\S]*?<\/attachments>/, "");
					}

					const mentionMatch = rest.match(/<mentions>\n([\s\S]*?)\n<\/mentions>/);
					if (mentionMatch) {
						mentions = mentionMatch[1]
							.split("\n")
							.filter(Boolean)
							.map((line) => basenameOf(line.replace(/^(?:file|dir):\s*/, "")));
						rest = rest.replace(/\n\n<mentions>[\s\S]*?<\/mentions>/, "");
					}

					// Skills need no chips of their own: the `/name` the user typed is still
					// in the text. Only the appended block has to go.
					rest = rest.replace(/\n\n<skills>[\s\S]*?<\/skills>/, "");

					return { text: rest.trim(), attachments, mentions };
				};

				const turns: Turn[] = [];

				for (const entry of entries) {
					if (entry.type !== "message" || !entry.message) continue;
					const msg = entry.message;

					if (msg.role === "user") {
						const textPart = (msg.content as any[])?.find((c: any) => c.type === "text");
						if (!textPart?.text) continue;
						const { text: cleanText, attachments, mentions: turnMentions } = extractAttachments(stripPrefix(textPart.text));
						turns.push({ userText: cleanText, attachments, mentions: turnMentions, toolCalls: [], toolResults: [], assistantTexts: [], blocks: [] });
					} else if (msg.role === "assistant") {
						if (turns.length === 0) continue;
						const turn = turns[turns.length - 1];
						for (const part of (msg.content as any[]) || []) {
							if (part.type === "toolCall") {
								turn.toolCalls.push({ id: part.id, name: part.name, label: part.arguments?.label, args: part.arguments ?? {} });
								turn.blocks.push({
									kind: "tool",
									toolCallId: part.id,
									toolName: part.name,
									label: part.arguments?.label,
									args: part.arguments ?? {},
									durationMs: trailDurations.get(part.id),
									skill: trailSkills.get(part.id),
								});
							} else if (part.type === "text" && part.text?.trim()) {
								turn.assistantTexts.push(part.text.trim());
								turn.blocks.push({ kind: "text", content: part.text.trim() });
							} else if (part.type === "thinking" && part.thinking?.trim()) {
								turn.blocks.push({ kind: "thinking", content: part.thinking.trim() });
							}
						}
						if (msg.model) {
							turn.model = msg.provider ? `${msg.provider}/${msg.responseModel || msg.model}` : String(msg.responseModel || msg.model);
						}
						if (msg.usage) {
							const u = msg.usage as AgentUsage;
							if (!turn.usage) {
								turn.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
							}
							turn.usage.input += u.input ?? 0;
							turn.usage.output += u.output ?? 0;
							turn.usage.cacheRead += u.cacheRead ?? 0;
							turn.usage.cacheWrite += u.cacheWrite ?? 0;
							if (u.cost) {
								turn.usage.cost.input += u.cost.input ?? 0;
								turn.usage.cost.output += u.cost.output ?? 0;
								turn.usage.cost.cacheRead += u.cost.cacheRead ?? 0;
								turn.usage.cost.cacheWrite += u.cost.cacheWrite ?? 0;
								turn.usage.cost.total += u.cost.total ?? 0;
							}
						}
					} else if (msg.role === "toolResult") {
						if (turns.length === 0) continue;
						const turn = turns[turns.length - 1];
						const text = (msg.content as any[])?.find((c: any) => c.type === "text")?.text ?? "";
						turn.toolResults.push({ toolCallId: msg.toolCallId, toolName: msg.toolName, text, isError: msg.isError });
						const toolBlock = turn.blocks.find(
							(b) => b.kind === "tool" && b.toolCallId === msg.toolCallId && b.result === undefined,
						) as Extract<ReplayBlock, { kind: "tool" }> | undefined;
						if (toolBlock) {
							const { text: truncatedResult, truncated } = truncateToolResult(text);
							toolBlock.result = truncatedResult;
							toolBlock.resultTruncated = truncated;
							toolBlock.isError = msg.isError;
						}
					}
				}

				for (const turn of turns) {
					messages.push({
						role: "user",
						text: turn.userText,
						attachments: turn.attachments.length > 0 ? turn.attachments : undefined,
						mentions: turn.mentions.length > 0 ? turn.mentions : undefined,
					});

					const mainText = turn.assistantTexts[turn.assistantTexts.length - 1] ?? "";
					const threadParts: string[] = [];
					const files: Array<{ path: string; title?: string }> = [];

					for (const tc of turn.toolCalls) {
						const result = turn.toolResults.find((r) => r.toolCallId === tc.id);
						let block = `**${result?.isError ? "✗" : "✓"} ${tc.name}**`;
						if (tc.label) block += `: ${tc.label}`;
						const argsStr = formatArgs(tc.args);
						if (argsStr) block += `\n\`\`\`\n${argsStr}\n\`\`\``;
						if (result) {
							const resultStr = result.text;
							block += `\n**Result:**\n\`\`\`\n${resultStr.slice(0, 500)}${resultStr.length > 500 ? "\n…" : ""}\n\`\`\``;
						}
						threadParts.push(block);
						if (tc.name === "attach" && tc.args.path) {
							files.push({
								path: normalizeAttachedFilePath(tc.args.path as string),
								title: tc.args.title as string | undefined,
							});
						}
					}

					const thread = threadParts.length > 0 ? threadParts.join("\n\n") : undefined;
					if (mainText || thread || turn.blocks.length > 0) {
						messages.push({
							role: "assistant",
							text: mainText,
							thread,
							files: files.length > 0 ? files : undefined,
							blocks: turn.blocks.length > 0 ? turn.blocks : undefined,
							usage: turn.usage,
							model: turn.model,
						});
					}
				}
			} catch { /* unreadable file */ }
		}

		res.json(messages);
	}

	private handleSessions(req: express.Request, res: express.Response): void {
		const userId = this.getUserId(req);
		const workspaceId = String(req.query.workspaceId || this.workspaceStore.ensureDefaultWorkspace(userId).id);
		try {
			res.json(this.workspaceStore.listSessions(userId, workspaceId));
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}
}
