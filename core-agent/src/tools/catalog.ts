/**
 * Catalog of the primitive tools, and the rules for resolving which of them a
 * workspace auto-approves.
 *
 * The list is a permission setting, not a visibility one: the model is
 * registered for and told about every tool here regardless of the workspace's
 * choices. A tool the workspace left off still appears in the prompt and can
 * still be called — the agent's `beforeToolCall` hook stops that call and asks
 * the user first.
 *
 * This is the single source of truth shared by three consumers: the agent's
 * `beforeToolCall` hook (which decides what needs approval), the `GET /tools`
 * route that feeds the Tools tab in workspace settings, and `renderToolsPrompt`
 * (which turns the registered tools into the `## Tools` section of the system
 * prompt, marking the ones that will ask). `name` must stay in sync with the
 * `name` field of the corresponding tool in this directory.
 *
 * MCP tools are deliberately absent: they arrive through
 * `CoreAgentOptions.extraTools` and are gated per server by their own
 * `enabled` / `allowedTools` / `blockedTools` settings. Tools outside the
 * catalog that the host does want covered are named in
 * `CoreAgentOptions.approvalScope`.
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
	/**
	 * Whether a workspace that has never been configured auto-approves this tool.
	 * The field name predates the approval model and is kept because it already
	 * travels through `GET /tools` and `workspace.json`.
	 */
	defaultEnabled: boolean;
	/**
	 * Prose the model reads in the system prompt. It is longer and more
	 * directive than `description`, which serves the settings UI. When absent,
	 * `renderToolsPrompt` falls back to `description`.
	 */
	promptGuidance?: string;
}

export const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
	{
		name: "read",
		label: "Read file",
		group: "Files & shell",
		description: "Read a file, including text extracted from PDF, Word, Excel and PowerPoint documents.",
		defaultEnabled: true,
		promptGuidance:
			"Read files. Text lines come back prefixed with their line number (`  42→…`), which is the same number `grep` reports — so use `offset` to land on a match instead of reading the file from the top. The prefix is not part of the file. For pdf, docx, xlsx and pptx it returns the document's extracted text with page/sheet/slide markers instead. A large document returns an outline of its pages rather than its body — pick from it and read again with `pages=\"3-7\"` rather than pulling the whole document into context.",
	},
	{
		name: "write",
		label: "Write file",
		group: "Files & shell",
		description: "Create a file or overwrite it completely.",
		defaultEnabled: true,
		promptGuidance: "Create/overwrite files",
	},
	{
		name: "edit",
		label: "Edit file",
		group: "Files & shell",
		description: "Replace an exact string inside an existing file.",
		defaultEnabled: true,
		promptGuidance:
			"Surgical file edits. `oldText` must match the file exactly, so strip the `42→` line-number prefix off anything you copied out of `read`.",
	},
	{
		name: "bash",
		label: "Run shell command",
		group: "Files & shell",
		description: "Run a command in the workspace, optionally as a background shell.",
		defaultEnabled: true,
		promptGuidance:
			"Run shell commands. Install packages as needed. Set run_in_background for long-running commands.",
	},
	{
		name: "attach",
		label: "Attach file",
		group: "Files & shell",
		description: "Attach a workspace file to the conversation so the user can open or download it.",
		defaultEnabled: true,
		promptGuidance: "Share files to Web or Teams",
	},
	{
		name: "glob",
		label: "Find files",
		group: "Search",
		description: "Find files by glob pattern, in the host or inside the sandbox.",
		defaultEnabled: true,
		promptGuidance:
			"Find files by pattern, newest first, with their size and (for documents) page count. Use it to discover files you have not been told about; the attachments for this session are already listed above.",
	},
	{
		name: "grep",
		label: "Search contents",
		group: "Search",
		description: "Search file contents by regular expression, including inside binary documents.",
		defaultEnabled: true,
		promptGuidance:
			"Search file contents by regular expression. It also looks inside pdf, docx, xlsx and pptx by extracting their text, names the page/sheet/slide that matched, and reports which documents it had to skip and why (for example a scanned PDF with no text layer). When looking for information that could be in an attachment or report, grep before answering at all — not just before concluding it is not there — and try more than one wording, including the user's own language. On a broad search it shows a few matches per file so one noisy file cannot hide the others; narrow with `path` or `glob` to see everything in one file.",
	},
	{
		name: "bash_output",
		label: "Read background output",
		group: "Background shells",
		description: "Read new output from a shell started with run_in_background.",
		defaultEnabled: true,
		promptGuidance: "Read new output from a background shell",
	},
	{
		name: "kill_shell",
		label: "Stop background shell",
		group: "Background shells",
		description: "Terminate a background shell started by this session.",
		defaultEnabled: true,
		promptGuidance: "Stop a background shell",
	},
	{
		name: "web_fetch",
		label: "Fetch web page",
		group: "Web",
		description: "Fetch a public URL and convert it to text. Internal and private hosts are blocked.",
		defaultEnabled: true,
		promptGuidance:
			"Read one http(s) URL as Markdown. Private and internal hosts are blocked; reach SAP systems through the sap-adt connector instead.",
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
		promptGuidance:
			"Keep the task list current for any work with several steps, so the user can see progress. Send the whole list each time and keep one item in_progress.",
	},
	{
		name: "exit_plan_mode",
		label: "Exit plan mode",
		group: "Planning & delegation",
		description: "Present a plan and ask for approval to leave plan mode. Without it a session cannot leave plan mode.",
		defaultEnabled: true,
		promptGuidance: "In plan mode, present your plan and leave plan mode before making changes",
	},
	{
		name: "task",
		label: "Delegate to subagent",
		group: "Planning & delegation",
		description: "Run a nested agent for a scoped task, sharing this session's sandbox and model.",
		defaultEnabled: true,
		promptGuidance:
			"Launch a subagent for self-contained work. It has its own context window, so use it for broad searches whose intermediate output you do not need. For questions that have to be answered out of several documents, use the `doc-research` type: it does the reading on its own budget and returns the answer with file and page citations.",
	},
];

/**
 * The `## Tools` section's groups, in the order the model sees them.
 *
 * `group` matches `ToolCatalogEntry.group` (the settings UI label); `heading`
 * is what the prompt prints, which differs in punctuation. A `preamble`
 * belongs to the group rather than to any one tool.
 */
export const TOOL_PROMPT_GROUPS: readonly { group: string; heading: string; preamble?: string }[] = [
	{ group: "Files & shell", heading: "Files and shell" },
	{
		group: "Search",
		heading: "Search",
		preamble:
			"prefer these over running find/grep/dir through bash. They behave identically on the host and in the sandbox, whereas shell commands do not. Both cover the workspace artifacts folder and this session's attachments; see \"Grounding\" above for when to reach for them.",
	},
	{ group: "Background shells", heading: "Background shells" },
	{ group: "Web", heading: "Web" },
	{ group: "Planning & delegation", heading: "Planning and delegation" },
];

const CATALOG_NAMES: ReadonlySet<string> = new Set(TOOL_CATALOG.map((entry) => entry.name));

/** Tool names a workspace auto-approves when it has never been configured. */
export const DEFAULT_ENABLED_TOOLS: readonly string[] = TOOL_CATALOG.filter((entry) => entry.defaultEnabled).map(
	(entry) => entry.name,
);

/** True when a tool name belongs to the catalog, i.e. is subject to workspace gating. */
export function isCatalogTool(name: string): boolean {
	return CATALOG_NAMES.has(name);
}

/**
 * The one list every template seeded before the Tools tab existed: placeholder
 * values that never matched a tool name.
 */
const LEGACY_SEED: readonly string[] = ["shell", "code", "tests"];

function isLegacySeed(configured: readonly string[]): boolean {
	return configured.length === LEGACY_SEED.length && LEGACY_SEED.every((name) => configured.includes(name));
}

/**
 * Turns the stored `settings.tools.enabled` list into the set of tools that run
 * without asking. Everything else in scope goes through an approval prompt.
 *
 * Only the exact legacy seed counts as "never configured". The rule this
 * replaces — any unrecognized name falls back to the defaults — was written when
 * the catalog was the whole world, and became a trap once the settings UI began
 * serving capability tools that are not in it (`adt`, `sapgit`, and anything
 * else the host names in `approvalScope`): toggling one silently discarded every
 * other choice the user had made. Matching the seed itself is both narrower and
 * safer, since the fallback is the more permissive answer of the two.
 *
 * An empty list is honored as written: the user chose to be asked about
 * everything.
 */
export function resolveEnabledTools(configured?: readonly string[]): ReadonlySet<string> {
	if (!configured || isLegacySeed(configured)) return new Set(DEFAULT_ENABLED_TOOLS);
	return new Set(configured);
}
