import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { loadSubagentDefinitions, type SubagentDefinition } from "../subagent/definitions.js";
import { runSubagent, type SubagentRuntime } from "../subagent/runner.js";
import { truncateTail } from "./truncate.js";

/** Guards against a prompt fanning out into unbounded parallel model usage. */
const MAX_CONCURRENT_SUBAGENTS = 8;

let activeSubagents = 0;

const taskSchema = Type.Object({
	label: Type.String({ description: "Brief description of the delegated work (shown to user)" }),
	description: Type.String({ description: "Short (3-5 word) description of the task" }),
	prompt: Type.String({
		description:
			"The complete, self-contained task for the subagent. It cannot ask follow-up questions, so state everything it needs and exactly what to report back.",
	}),
	subagent_type: Type.String({ description: "Which subagent type to launch" }),
});

interface TaskToolDetails {
	subagentType: string;
	turns: number;
	toolCalls: number;
	hitTurnLimit: boolean;
}

export interface TaskToolOptions {
	runtime: SubagentRuntime;
	/** Full tool set of the parent agent; the subagent gets a subset of these. */
	availableTools: AgentTool<any>[];
}

export function createTaskTool(options: TaskToolOptions): AgentTool<typeof taskSchema> {
	// Definitions are resolved per call so a newly added agents/*.md is picked up
	// without restarting the service.
	const listDefinitions = () =>
		loadSubagentDefinitions({
			channelDir: options.runtime.channelDir,
			hostWorkspacePath: options.runtime.hostWorkspacePath,
		});

	const describeTypes = () =>
		listDefinitions()
			.map((definition) => `- ${definition.name}: ${definition.description}`)
			.join("\n");

	return {
		name: "task",
		label: "task",
		description: [
			"Launch a subagent to work autonomously on a self-contained task and report back.",
			"The subagent has its own context window, so use it for work that would otherwise flood this conversation with intermediate output, such as searching broadly across the codebase.",
			"It runs with the same workspace and sandbox as you, cannot ask follow-up questions, and returns a single final report.",
			"Available subagent types:",
			describeTypes(),
		].join("\n"),
		parameters: taskSchema,
		execute: async (
			_toolCallId: string,
			params: { label: string; description: string; prompt: string; subagent_type: string },
			signal?: AbortSignal,
			onUpdate?: (partial: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void,
		) => {
			const definitions = listDefinitions();
			const definition = findDefinition(definitions, params.subagent_type);
			if (!definition) {
				throw new Error(
					`Unknown subagent type "${params.subagent_type}". Available types: ${definitions.map((entry) => entry.name).join(", ")}`,
				);
			}

			const tools = selectTools(options.availableTools, definition);
			if (tools.length === 0) {
				throw new Error(
					`Subagent type "${definition.name}" declares tools that are not available: ${definition.tools?.join(", ") ?? "(none)"}`,
				);
			}

			if (activeSubagents >= MAX_CONCURRENT_SUBAGENTS) {
				throw new Error(
					`Too many subagents running at once (limit ${MAX_CONCURRENT_SUBAGENTS}). Wait for the running ones to finish.`,
				);
			}

			activeSubagents++;
			try {
				const result = await runSubagent({
					definition,
					prompt: params.prompt,
					tools,
					runtime: options.runtime,
					signal,
					onProgress: (progress) => {
						onUpdate?.({
							content: [
								{
									type: "text",
									// turns counts completed turns, so the one in flight is turns + 1.
									text: `${definition.name}: turn ${progress.turns + 1}, ${progress.toolCalls} tool call(s) — ${progress.lastActivity}`,
								},
							],
							details: { subagentType: definition.name, ...progress },
						});
					},
				});

				const notes: string[] = [];
				if (result.hitTurnLimit) {
					notes.push("The subagent was stopped at its turn limit, so this report may be incomplete.");
				}
				if (!result.text) {
					notes.push("The subagent produced no final report.");
				}

				const body = result.text || "(no report)";
				const text = [
					`Subagent ${definition.name} finished after ${result.turns} turn(s) and ${result.toolCalls} tool call(s).`,
					"",
					truncateTail(body).content,
					...(notes.length > 0 ? ["", ...notes.map((note) => `[${note}]`)] : []),
				].join("\n");

				return {
					content: [{ type: "text", text }],
					details: {
						subagentType: definition.name,
						turns: result.turns,
						toolCalls: result.toolCalls,
						hitTurnLimit: result.hitTurnLimit,
					} satisfies TaskToolDetails,
				};
			} finally {
				activeSubagents--;
			}
		},
	};
}

function findDefinition(definitions: SubagentDefinition[], requested: string): SubagentDefinition | undefined {
	const wanted = requested.trim().toLowerCase();
	return definitions.find((definition) => definition.name.toLowerCase() === wanted);
}

/**
 * Resolves the subagent's tool set. `task` is always excluded so a subagent
 * cannot launch further subagents.
 */
function selectTools(available: AgentTool<any>[], definition: SubagentDefinition): AgentTool<any>[] {
	const usable = available.filter((tool) => tool.name !== "task");
	if (!definition.tools) return usable;

	const wanted = new Set(definition.tools.map((name) => name.toLowerCase()));
	return usable.filter((tool) => wanted.has(tool.name.toLowerCase()));
}
