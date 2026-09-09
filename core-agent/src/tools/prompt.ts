/**
 * Renders the `## Tools` section of the system prompt from the tools actually
 * registered for a session.
 *
 * The section used to be a hand-written literal in core-service, which drifted:
 * it described tools a workspace had turned off and never mentioned the MCP or
 * ACP tools that arrive at runtime. Deriving it here keeps what the model reads
 * in step with what it can actually call.
 *
 * Every registered tool is listed, including the ones the workspace did not
 * pre-authorize — those carry a marker so the model knows the call will pause for
 * the user rather than fail.
 */

import { isCatalogTool, TOOL_CATALOG, TOOL_PROMPT_GROUPS } from "./catalog.js";

/** The minimum a tool must advertise to be listed. Matches `AgentTool`'s shape. */
export interface ToolPromptEntry {
	name: string;
	description: string;
}

/** One MCP server can expose dozens of tools; cap the listing so it cannot flood the prompt. */
const MAX_MCP_LINES = 20;

const FOOTER = 'Each tool requires a "label" parameter (shown to user).';

//IYH1HC tool approval add
/** Suffix marking a tool the workspace has not pre-authorized. */
const APPROVAL_MARK = " [needs approval]";

const APPROVAL_FOOTER = [
	"Tools marked [needs approval] are not pre-authorized for this workspace: calling one pauses you",
	"while the user is asked to allow it. Use them when they are genuinely the right tool — say what you",
	"are about to do and why first, so the request does not arrive without context. Prefer an unmarked",
	"tool that does the same job. If a call is denied, do not retry it; explain what you needed and offer",
	"an alternative.",
].join(" ");

export interface ToolsPromptOptions {
	/** Registered tools that will stop and ask the user before they run. */
	needsApproval?: ReadonlySet<string>;
}

/** Runtime tools carry a full description; only its first line belongs in the prompt. */
function firstLine(text: string): string {
	return text.trim().split("\n")[0]?.trim() ?? "";
}

export function renderToolsPrompt(tools: readonly ToolPromptEntry[], options: ToolsPromptOptions = {}): string {
	const registered = new Set(tools.map((tool) => tool.name));
	const needsApproval = options.needsApproval ?? new Set<string>();
	const mark = (name: string) => (needsApproval.has(name) ? APPROVAL_MARK : "");
	const bullet = (tool: ToolPromptEntry) => `- ${tool.name}${mark(tool.name)}: ${firstLine(tool.description)}`;
	const sections: string[] = [];

	for (const { group, heading, preamble } of TOOL_PROMPT_GROUPS) {
		const lines = TOOL_CATALOG.filter((entry) => entry.group === group && registered.has(entry.name)).map(
			(entry) => `- ${entry.name}${mark(entry.name)}: ${entry.promptGuidance ?? entry.description}`,
		);
		// A group is only empty when its tools failed to register at all — a
		// workspace turning them off no longer removes them. Drop the heading
		// rather than print it empty.
		if (lines.length === 0) continue;
		sections.push([preamble ? `${heading} — ${preamble}` : heading, ...lines].join("\n"));
	}

	// Tools outside the catalog appear at runtime, so they are grouped by name
	// prefix and described with whatever they advertise.
	const extras = tools.filter((tool) => !isCatalogTool(tool.name));
	const acp = extras.filter((tool) => tool.name.startsWith("acp_"));
	const mcp = extras.filter((tool) => tool.name.startsWith("mcp_"));
	const other = extras.filter((tool) => !tool.name.startsWith("acp_") && !tool.name.startsWith("mcp_"));

	if (acp.length > 0) {
		sections.push(["Agent workers", ...acp.map(bullet)].join("\n"));
	}
	if (mcp.length > 0) {
		const lines = mcp.slice(0, MAX_MCP_LINES).map(bullet);
		if (mcp.length > MAX_MCP_LINES) lines.push(`- …and ${mcp.length - MAX_MCP_LINES} more`);
		sections.push(["Connected tools (MCP)", ...lines].join("\n"));
	}
	if (other.length > 0) {
		sections.push(["Other", ...other.map(bullet)].join("\n"));
	}

	if (sections.length === 0) {
		return ["## Tools", "", "(no tools are available for this workspace)"].join("\n");
	}

	const footer = needsApproval.size > 0 ? `${FOOTER}\n\n${APPROVAL_FOOTER}` : FOOTER;
	return ["## Tools", "", sections.join("\n\n"), "", footer].join("\n");
}
