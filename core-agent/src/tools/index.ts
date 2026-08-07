import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { WebSearchConfig } from "../net/search-providers.js";
import type { Executor } from "../sandbox.js";
import type { SessionStateStore } from "../session-state.js";
import type { SubagentRuntime } from "../subagent/runner.js";
import { createAttachTool } from "./attach.js";
import { createBashOutputTool } from "./bash-output.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createExitPlanModeTool } from "./exit-plan-mode.js";
import { createGlobTool } from "./glob.js";
import { createGrepTool } from "./grep.js";
import { createKillShellTool } from "./kill-shell.js";
import { createReadTool } from "./read.js";
import { createTaskTool } from "./task.js";
import { createTodoWriteTool } from "./todo.js";
import { createWebFetchTool } from "./web-fetch.js";
import { createWebSearchTool } from "./web-search.js";
import { createWriteTool } from "./write.js";

type UploadFn = (filePath: string, title?: string) => Promise<void>;

export interface PrimitiveToolsOptions {
	executor: Executor;
	getUploadFn: () => UploadFn | null;
	attachCwd?: string;
	/** Session identifier; scopes background shells. */
	sessionId: string;
	/** Task list and permission mode for this session. */
	sessionState: SessionStateStore;
	/** Present only when a web search provider is configured. */
	webSearch?: WebSearchConfig;
	/** Present only when subagents are enabled. */
	subagent?: SubagentRuntime;
	/**
	 * Tool names the workspace has enabled. Omit to register everything.
	 * Resolve it with `resolveEnabledTools` so the legacy seed is handled.
	 */
	enabledTools?: ReadonlySet<string>;
}

/**
 * The tool set every Octo agent gets. Additional tools (MCP) are merged in by
 * the caller via `CoreAgentOptions.extraTools`.
 *
 * Tools whose backing capability is not configured are omitted rather than
 * registered-and-failing, so the model never sees a tool it cannot use.
 */
export function createPrimitiveTools(options: PrimitiveToolsOptions): AgentTool<any>[] {
	const { executor, enabledTools } = options;
	const isEnabled = (name: string) => !enabledTools || enabledTools.has(name);

	const tools: AgentTool<any>[] = [
		createReadTool(executor),
		createBashTool(executor, { sessionId: options.sessionId }),
		createEditTool(executor),
		createWriteTool(executor),
		createAttachTool(options.getUploadFn, options.attachCwd),
		createGlobTool(executor),
		createGrepTool(executor),
		createBashOutputTool(),
		createKillShellTool(),
		createTodoWriteTool(options.sessionState),
		createExitPlanModeTool(options.sessionState),
		createWebFetchTool(),
	];

	// Drop what the workspace turned off before `task` is built, so a subagent
	// inherits the same restrictions as its parent.
	const enabled = tools.filter((tool) => isEnabled(tool.name));

	if (options.webSearch && isEnabled("web_search")) {
		enabled.push(createWebSearchTool(options.webSearch));
	}

	// `task` is created last so the subagent can be given the tools above it.
	if (options.subagent && isEnabled("task")) {
		enabled.push(createTaskTool({ runtime: options.subagent, availableTools: [...enabled] }));
	}

	return enabled;
}
