/**
 * Catalog of the primitive tools, and the rules for resolving which of them a
 * workspace has enabled.
 *
 * This is the single source of truth shared by three consumers: the tool
 * factory (which filters what the model sees), the agent's `beforeToolCall`
 * hook (which blocks what the model may call), and the `GET /tools` route that
 * feeds the Tools tab in workspace settings. `name` must stay in sync with the
 * `name` field of the corresponding tool in this directory.
 *
 * MCP tools are deliberately absent: they arrive through
 * `CoreAgentOptions.extraTools` and are gated per server by their own
 * `enabled` / `allowedTools` / `blockedTools` settings.
 */

export interface ToolCatalogEntry {
	/** Registered tool name, as the model sees it. */
	name: string;
	/** Human-readable name for the settings UI. */
	label: string;
	/** Grouping label for the settings UI. */
	group: string;
	/** One-line explanation shown under the tool name. */
	description: string;
	/** Whether a workspace that has never been configured gets this tool. */
	defaultEnabled: boolean;
}

export const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
	{
		name: "read",
		label: "Read file",
		group: "Files & shell",
		description: "Read a file, including text extracted from PDF, Word, Excel and PowerPoint documents.",
		defaultEnabled: true,
	},
	{
		name: "write",
		label: "Write file",
		group: "Files & shell",
		description: "Create a file or overwrite it completely.",
		defaultEnabled: true,
	},
	{
		name: "edit",
		label: "Edit file",
		group: "Files & shell",
		description: "Replace an exact string inside an existing file.",
		defaultEnabled: true,
	},
	{
		name: "bash",
		label: "Run shell command",
		group: "Files & shell",
		description: "Run a command in the workspace, optionally as a background shell.",
		defaultEnabled: true,
	},
	{
		name: "attach",
		label: "Attach file",
		group: "Files & shell",
		description: "Attach a workspace file to the conversation so the user can open or download it.",
		defaultEnabled: true,
	},
	{
		name: "glob",
		label: "Find files",
		group: "Search",
		description: "Find files by glob pattern, in the host or inside the sandbox.",
		defaultEnabled: true,
	},
	{
		name: "grep",
		label: "Search contents",
		group: "Search",
		description: "Search file contents by regular expression, including inside binary documents.",
		defaultEnabled: true,
	},
	{
		name: "bash_output",
		label: "Read background output",
		group: "Background shells",
		description: "Read new output from a shell started with run_in_background.",
		defaultEnabled: true,
	},
	{
		name: "kill_shell",
		label: "Stop background shell",
		group: "Background shells",
		description: "Terminate a background shell started by this session.",
		defaultEnabled: true,
	},
	{
		name: "web_fetch",
		label: "Fetch web page",
		group: "Web",
		description: "Fetch a public URL and convert it to text. Internal and private hosts are blocked.",
		defaultEnabled: true,
	},
/* 	{
		name: "web_search",
		label: "Web search",
		group: "Web",
		description: "Search the web through the configured search provider.",
		defaultEnabled: false,
	}, */
	{
		name: "todo_write",
		label: "Task list",
		group: "Planning & delegation",
		description: "Keep a visible task list for multi-step work.",
		defaultEnabled: true,
	},
	{
		name: "exit_plan_mode",
		label: "Exit plan mode",
		group: "Planning & delegation",
		description: "Present a plan and ask for approval to leave plan mode. Without it a session cannot leave plan mode.",
		defaultEnabled: true,
	},
	{
		name: "task",
		label: "Delegate to subagent",
		group: "Planning & delegation",
		description: "Run a nested agent for a scoped task, sharing this session's sandbox and model.",
		defaultEnabled: true,
	},
];

const CATALOG_NAMES: ReadonlySet<string> = new Set(TOOL_CATALOG.map((entry) => entry.name));

/** Tool names a workspace gets when it has never been configured. */
export const DEFAULT_ENABLED_TOOLS: readonly string[] = TOOL_CATALOG.filter((entry) => entry.defaultEnabled).map(
	(entry) => entry.name,
);

/** True when a tool name belongs to the catalog, i.e. is subject to workspace gating. */
export function isCatalogTool(name: string): boolean {
	return CATALOG_NAMES.has(name);
}

/**
 * Turns the stored `settings.tools.enabled` list into the effective tool set.
 *
 * Also absorbs the legacy seed: workspaces created before this feature carry
 * `["shell", "code", "tests"]`, placeholder values that never matched a tool
 * name. Any unknown name means the list predates the Tools tab, because the UI
 * only ever writes catalog names — so it is treated as unconfigured rather than
 * as "almost everything is off". An empty list is honored as written: it means
 * the user deliberately turned everything off.
 */
export function resolveEnabledTools(configured?: readonly string[]): ReadonlySet<string> {
	if (!configured) return new Set(DEFAULT_ENABLED_TOOLS);
	if (configured.some((name) => !CATALOG_NAMES.has(name))) return new Set(DEFAULT_ENABLED_TOOLS);
	return new Set(configured);
}
