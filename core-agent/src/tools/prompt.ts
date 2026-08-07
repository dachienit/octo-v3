/**
 * Renders the `## Tools` section of the system prompt from the tools actually
 * registered for a session.
 *
 * The section used to be a hand-written literal in core-service, which drifted:
 * it described tools a workspace had turned off and never mentioned the MCP or
 * ACP tools that arrive at runtime. Deriving it here keeps what the model reads
 * in step with what it can actually call.
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

/** Runtime tools carry a full description; only its first line belongs in the prompt. */
function firstLine(text: string): string {
	return text.trim().split("\n")[0]?.trim() ?? "";
}

function bullet(tool: ToolPromptEntry): string {
	return `- ${tool.name}: ${firstLine(tool.description)}`;
}

export function renderToolsPrompt(tools: readonly ToolPromptEntry[]): string {
	const registered = new Set(tools.map((tool) => tool.name));
	const sections: string[] = [];

	for (const { group, heading, preamble } of TOOL_PROMPT_GROUPS) {
		const lines = TOOL_CATALOG.filter((entry) => entry.group === group && registered.has(entry.name)).map(
			(entry) => `- ${entry.name}: ${entry.promptGuidance ?? entry.description}`,
		);
		// A workspace can turn a whole group off; drop the heading rather than print it empty.
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
		return ["## Tools", "", "(no tools are enabled for this workspace)"].join("\n");
	}

	return ["## Tools", "", sections.join("\n\n"), "", FOOTER].join("\n");
}
