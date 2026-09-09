import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { WebSearchConfig } from "../net/search-providers.js";
import type { Executor } from "../sandbox.js";
import type { SessionStateStore } from "../session-state.js";
import type { SubagentRuntime } from "../subagent/runner.js";
import { isCatalogTool } from "./catalog.js";
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
}

/**
 * The tool set every Octo agent gets. Additional tools (MCP) are merged in by
 * the caller via `CoreAgentOptions.extraTools`.
 *
 * Tools whose backing capability is not configured are omitted rather than
 * registered-and-failing, so the model never sees a tool it cannot use. What a
 * workspace turned off in its settings is *not* such a case: that is a
 * permission, enforced in `CoreAgent`'s `beforeToolCall` by asking the user, and
 * the tool stays registered so the model knows it exists and can ask for it.
 */
export function createPrimitiveTools(options: PrimitiveToolsOptions): AgentTool<any>[] {
	const { executor } = options;

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

	// A primitive the catalog does not list cannot be shown in the Tools screen,
	// cannot be marked in the prompt, and is outside the approval gate — so
	// registering it would hand the model an ungovernable capability. `web_search`
	// is in exactly that state today (its catalog entry is commented out), and
	// this keeps it unreachable until that is resolved deliberately rather than as
	// a side effect. See G-6 in docs_core/21-roadmap-and-known-gaps.md.
	if (options.webSearch && isCatalogTool("web_search")) {
		tools.push(createWebSearchTool(options.webSearch));
	}

	// `task` is created last so the subagent can be given the tools above it. A
	// subagent therefore sees the same full set as its parent and is held to the
	// same approvals — `CoreAgent` passes its guard into the nested agent too.
	if (options.subagent) {
		tools.push(createTaskTool({ runtime: options.subagent, availableTools: [...tools] }));
	}

	return tools;
}
