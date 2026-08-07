/**
 * Plan mode enforcement.
 *
 * While a session is in plan mode the agent may research but not change
 * anything: it reads, searches, and runs read-only commands, then presents a
 * plan with `exit_plan_mode`. Enforcement lives in the agent loop's
 * `beforeToolCall` hook rather than in each tool, so a tool cannot forget to
 * check and newly registered tools are denied by default.
 */

/** Tools that change the workspace, the outside world, or delegate work that could. */
const MUTATING_TOOLS = new Set(["write", "edit", "attach", "acp_delegate", "task"]);

/** Tools that are always safe in plan mode regardless of the deny list. */
const PLAN_MODE_TOOLS = new Set([
	"read",
	"glob",
	"grep",
	"bash",
	"bash_output",
	"kill_shell",
	"web_fetch",
	"web_search",
	"todo_write",
	"exit_plan_mode",
	"acp_agents",
]);

/**
 * Command prefixes considered read-only. Deliberately an allowlist: anything not
 * recognized is blocked, because a deny list can always be worked around.
 */
const READ_ONLY_COMMANDS = new Set([
	"awk",
	"basename",
	"cat",
	"cd",
	"date",
	"df",
	"dirname",
	"du",
	"echo",
	"env",
	"file",
	"find",
	"grep",
	"head",
	"hostname",
	"id",
	"jq",
	"less",
	"ls",
	"md5sum",
	"more",
	"node",
	"nproc",
	"printenv",
	"pwd",
	"python",
	"python3",
	"readlink",
	"realpath",
	"sed",
	"seq",
	"sha256sum",
	"sort",
	"stat",
	"tail",
	"tree",
	"type",
	"uname",
	"uniq",
	"wc",
	"which",
	"whoami",
	// PowerShell equivalents, since the host shell on Windows is PowerShell.
	"get-childitem",
	"get-content",
	"get-location",
	"get-item",
	"select-string",
	"measure-object",
	"resolve-path",
	"test-path",
]);

/** Read-only `git` subcommands; every other git verb can write. */
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"blame",
	"branch",
	"config",
	"describe",
	"diff",
	"log",
	"ls-files",
	"ls-remote",
	"show",
	"shortlog",
	"status",
	"rev-parse",
	"tag",
]);

/** Shell metacharacters that could smuggle a write past the prefix check. */
const REDIRECTION_PATTERN = /(^|[^0-9<>])(>>?|<)(?![=<])/;

/**
 * True when every segment of a command line looks read-only. Pipes are allowed
 * because each stage is checked; redirection is not, because it writes files.
 */
export function isReadOnlyCommand(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return true;
	if (REDIRECTION_PATTERN.test(trimmed)) return false;

	// Split on the separators that chain commands, then vet each segment.
	const segments = trimmed
		.split(/\|\||&&|[;|\n]/)
		.map((segment) => segment.trim())
		.filter(Boolean);
	if (segments.length === 0) return false;

	return segments.every(isReadOnlySegment);
}

function isReadOnlySegment(segment: string): boolean {
	// Drop a leading environment assignment such as FOO=bar cmd.
	const withoutEnv = segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
	const tokens = withoutEnv.split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return false;

	// Subshells and command substitution hide their real command.
	if (/[`$(]/.test(tokens[0])) return false;

	const head = tokens[0].replace(/^.*[\\/]/, "").toLowerCase();
	if (head === "git") {
		const subcommand = tokens.slice(1).find((token) => !token.startsWith("-"));
		return subcommand !== undefined && READ_ONLY_GIT_SUBCOMMANDS.has(subcommand.toLowerCase());
	}
	return READ_ONLY_COMMANDS.has(head);
}

export interface PlanModeDecision {
	blocked: boolean;
	reason?: string;
}

/**
 * Decides whether a tool call is allowed while in plan mode. MCP tools are
 * blocked because their side effects are unknown to Octo.
 */
export function checkPlanMode(toolName: string, args: unknown): PlanModeDecision {
	if (toolName === "bash") {
		const command = typeof (args as { command?: unknown })?.command === "string" ? (args as { command: string }).command : "";
		if (isReadOnlyCommand(command)) return { blocked: false };
		return {
			blocked: true,
			reason:
				"Plan mode is active, so bash is limited to read-only commands. Finish researching, then call exit_plan_mode to present your plan and ask for approval before running this.",
		};
	}

	if (MUTATING_TOOLS.has(toolName) || toolName.startsWith("mcp_") || !PLAN_MODE_TOOLS.has(toolName)) {
		return {
			blocked: true,
			reason: `Plan mode is active, so ${toolName} is not available. Research with read, glob, grep and read-only bash, then call exit_plan_mode to present your plan and ask for approval.`,
		};
	}

	return { blocked: false };
}
