/**
 * Subagent type definitions for the `task` tool.
 *
 * Two types ship built in. Departments can add their own by dropping a markdown
 * file into an `agents/` directory, using the same layering as skills: a session
 * definition overrides a workspace one, which overrides a built-in.
 *
 * File format (frontmatter plus body):
 *
 *   ---
 *   name: abap-reviewer
 *   description: Reviews ABAP objects against CleanABAP and reports findings.
 *   tools: read, glob, grep, bash
 *   ---
 *   You are an ABAP reviewer. ...
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface SubagentDefinition {
	name: string;
	description: string;
	/** Tool names the subagent may use. Undefined means every tool except `task`. */
	tools?: string[];
	/** System prompt for the nested agent. */
	prompt: string;
	source: "builtin" | "workspace" | "session";
}

const SHARED_GUIDANCE = [
	"You are a subagent launched by the main Octo agent to complete one self-contained task.",
	"You cannot ask follow-up questions, so make reasonable assumptions and state them.",
	"Your final message is the only thing the main agent sees: make it a complete, standalone report.",
	"Include concrete file paths with line numbers for anything you found, and keep it concise.",
].join(" ");

const BUILTIN_DEFINITIONS: SubagentDefinition[] = [
	{
		name: "Explore",
		description:
			"Read-only search agent. Use for broad codebase questions where the answer requires sweeping many files and you only need the conclusion, not the file contents.",
		tools: ["read", "glob", "grep", "bash"],
		source: "builtin",
		prompt: [
			SHARED_GUIDANCE,
			"You are in read-only mode: you can read, glob, grep and run read-only shell commands, but you cannot change anything.",
			"Work by narrowing down: glob to find candidate files, grep to locate the relevant code, then read only the parts that matter.",
			"Report exact file paths with line numbers so the main agent can go straight to them.",
		].join("\n\n"),
	},
	{
		name: "doc-research",
		description:
			"Read-only document researcher. Use when a question has to be answered from the workspace's documents and reports and the search will span more than a couple of files — it burns its own context on the reading and returns only the answer with citations.",
		tools: ["read", "glob", "grep"],
		source: "builtin",
		prompt: [
			SHARED_GUIDANCE,
			"Answer strictly from the files in this workspace: artifacts and the session's attachments. They outrank anything you believe you already know. If a file contradicts your own knowledge, the file is right.",
			"Work cheaply, in this order. Start with grep to find which files and which pages mention the term — try more than one wording, including the user's own words and language, before concluding a term is absent. Then read only the pages you identified, using pages=\"3-7\". A large document returns an outline rather than its text; pick from that outline instead of asking for the whole thing. Reach for pages=\"all\" only when the question genuinely requires the entire document.",
			"Cite every fact as file plus page, sheet or slide, and quote only the few lines that carry the answer.",
			"If the documents do not answer the question, say exactly that, and list what you searched for and where. Never fill the gap from general knowledge. If a document was skipped — a scanned PDF with no text layer, for instance — report it as skipped rather than as empty.",
		].join("\n\n"),
	},
	{
		name: "general-purpose",
		description:
			"General-purpose agent with the full tool set except task itself. Use for multi-step work that can be delegated end to end, including making changes.",
		source: "builtin",
		prompt: [
			SHARED_GUIDANCE,
			"You have the full tool set apart from launching further subagents.",
			"Verify your work before reporting: if you changed code, check it the way the project checks it.",
			"State clearly what you changed, what you verified, and anything you deliberately left undone.",
		].join("\n\n"),
	},
];

/** Splits `---` frontmatter from the body. */
function parseFrontmatter(content: string): { fields: Record<string, string>; body: string } {
	const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
	if (!match) return { fields: {}, body: content.trim() };

	const fields: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const separator = line.indexOf(":");
		if (separator <= 0) continue;
		const key = line.slice(0, separator).trim().toLowerCase();
		const value = line
			.slice(separator + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
		if (key) fields[key] = value;
	}
	return { fields, body: match[2].trim() };
}

function parseToolList(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	const normalized = value.trim();
	if (!normalized || normalized === "*" || normalized.toLowerCase() === "all") return undefined;
	const tools = normalized
		.replace(/^\[|\]$/g, "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function loadFromDir(dir: string, source: "workspace" | "session"): SubagentDefinition[] {
	if (!existsSync(dir)) return [];

	const definitions: SubagentDefinition[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}

	for (const entry of entries) {
		if (!entry.toLowerCase().endsWith(".md")) continue;
		let content: string;
		try {
			content = readFileSync(join(dir, entry), "utf-8");
		} catch {
			continue;
		}

		const { fields, body } = parseFrontmatter(content);
		const name = fields.name || basename(entry, ".md");
		const description = fields.description;
		if (!description || !body) {
			console.warn(`Skipping subagent definition ${join(dir, entry)}: it needs a description and a body.`);
			continue;
		}

		definitions.push({
			name,
			description,
			tools: parseToolList(fields.tools),
			prompt: [SHARED_GUIDANCE, body].join("\n\n"),
			source,
		});
	}
	return definitions;
}

/**
 * Resolves the available subagent types. Later sources win on name collision,
 * so session definitions override workspace ones, which override built-ins.
 */
export function loadSubagentDefinitions(options: { channelDir: string; hostWorkspacePath: string }): SubagentDefinition[] {
	const byName = new Map<string, SubagentDefinition>();
	for (const definition of BUILTIN_DEFINITIONS) byName.set(definition.name, definition);
	for (const definition of loadFromDir(join(options.hostWorkspacePath, "agents"), "workspace")) {
		byName.set(definition.name, definition);
	}
	for (const definition of loadFromDir(join(options.channelDir, "agents"), "session")) {
		byName.set(definition.name, definition);
	}
	return [...byName.values()];
}
