/**
 * Runs a subagent as a nested `Agent` inside the current process.
 *
 * The nested agent shares the parent's executor, sandbox, model and credentials,
 * so it sees exactly the same filesystem the parent does — including inside a
 * container — but it gets its own message list. That isolation is the point:
 * token-heavy exploration happens in a separate context and only the final
 * report comes back to the parent.
 */

import type { Agent, AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { SubagentDefinition } from "./definitions.js";

/** Safety net: a subagent that has not finished by here is unlikely to. */
const DEFAULT_MAX_TURNS = 30;

export interface SubagentRuntime {
	/** Host path of the workspace, used to discover agent definitions. */
	hostWorkspacePath: string;
	/** Session directory, used to discover session-scoped agent definitions. */
	channelDir: string;
	/**
	 * Builds a nested agent using the parent's model, credentials and LLM
	 * transport. Implemented by CoreAgent so model resolution stays in one place.
	 */
	createAgent(systemPrompt: string, tools: AgentTool<any>[]): Agent;
}

export interface SubagentProgress {
	turns: number;
	toolCalls: number;
	/** Most recent activity, suitable for a one-line status update. */
	lastActivity: string;
}

export interface SubagentResult {
	text: string;
	turns: number;
	toolCalls: number;
	stopReason: string;
	/** True when the turn cap stopped the agent before it finished. */
	hitTurnLimit: boolean;
}

export async function runSubagent(options: {
	definition: SubagentDefinition;
	prompt: string;
	tools: AgentTool<any>[];
	runtime: SubagentRuntime;
	maxTurns?: number;
	onProgress?: (progress: SubagentProgress) => void;
	signal?: AbortSignal;
}): Promise<SubagentResult> {
	const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
	const agent = options.runtime.createAgent(options.definition.prompt, options.tools);

	let turns = 0;
	let toolCalls = 0;
	let hitTurnLimit = false;
	let stopReason = "stop";
	const textParts: string[] = [];

	const report = (lastActivity: string) => options.onProgress?.({ turns, toolCalls, lastActivity });

	const unsubscribe = agent.subscribe((event: AgentEvent) => {
		if (event.type === "tool_execution_start") {
			const started = event as AgentEvent & { type: "tool_execution_start" };
			toolCalls++;
			const label = (started.args as { label?: string } | undefined)?.label;
			report(`${started.toolName}: ${label ?? "running"}`);
			return;
		}
		if (event.type === "message_end") {
			const ended = event as AgentEvent & { type: "message_end" };
			if (ended.message.role !== "assistant") return;

			turns++;
			const message = ended.message;
			if (message.stopReason) stopReason = message.stopReason;

			// Keep every assistant text block; the last non-empty one is the report.
			const text = message.content
				.filter((block): block is TextContent => block.type === "text")
				.map((block) => block.text)
				.join("\n")
				.trim();
			if (text) {
				textParts.push(text);
				report(text.slice(0, 160));
			}

			if (turns >= maxTurns) {
				hitTurnLimit = true;
				agent.abort();
			}
		}
	});

	const onOuterAbort = () => agent.abort();
	options.signal?.addEventListener("abort", onOuterAbort, { once: true });

	try {
		await agent.prompt(options.prompt);
	} finally {
		unsubscribe();
		options.signal?.removeEventListener("abort", onOuterAbort);
	}

	if (options.signal?.aborted) {
		throw new Error(`Subagent ${options.definition.name} was cancelled`);
	}

	const text = textParts.at(-1) ?? "";
	return { text, turns, toolCalls, stopReason, hitTurnLimit };
}
