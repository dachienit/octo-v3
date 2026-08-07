import {
	closeMcpTools,
	CoreAgent,
	createMcpTools,
	formatSize,
	formatSkillsForPrompt,
	getMemory,
	loadSkills,
	isExtractableDocument,
	readOutline,
	type CoreAgentEventHandlers,
	type McpServerConfig,
	type SandboxConfig,
} from "@octo/core-agent";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { getAppTitle } from "./branding.js";
import * as log from "./log.js";
import type { BotContext, ChannelInfo, UserInfo } from "./types.js";
import type { ChannelStore } from "./store.js";
import { detectSkillFromToolCall } from "./agent-events.js";

export interface PendingMessage {
	userName: string;
	text: string;
	attachments: { local: string }[];
	timestamp: number;
}

export interface AgentRunner {
	run(
		ctx: BotContext,
		store: ChannelStore,
		pendingMessages?: PendingMessage[],
	): Promise<{ stopReason: string; errorMessage?: string }>;
	abort(): void;
}

export interface RunnerOptions {
	authFilePath?: string;
	userId?: string;
	usersRoot?: string;
	agentWorkersEnabled?: boolean;
	remindersEnabled?: boolean;
	mcpServers?: McpServerConfig[];
	/** Workspace `settings.tools.enabled`; omitted means "never configured". */
	enabledTools?: string[];
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.substring(0, maxLen - 3)}...`;
}

function formatToolArgsForSlack(_toolName: string, args: Record<string, unknown>): string {
	const lines: string[] = [];

	for (const [key, value] of Object.entries(args)) {
		if (key === "label") continue;

		if (key === "path" && typeof value === "string") {
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined && limit !== undefined) {
				lines.push(`${value}:${offset}-${offset + limit}`);
			} else {
				lines.push(value);
			}
			continue;
		}

		if (key === "offset" || key === "limit") continue;

		if (typeof value === "string") {
			lines.push(value);
		} else {
			lines.push(JSON.stringify(value));
		}
	}

	return lines.join("\n");
}

// Slack's max message length
const SLACK_MAX_LENGTH = 40000;

function splitForSlack(text: string): string[] {
	if (text.length <= SLACK_MAX_LENGTH) return [text];
	const parts: string[] = [];
	let remaining = text;
	let partNum = 1;
	while (remaining.length > 0) {
		const chunk = remaining.substring(0, SLACK_MAX_LENGTH - 50);
		remaining = remaining.substring(SLACK_MAX_LENGTH - 50);
		const suffix = remaining.length > 0 ? `\n_(continued ${partNum}...)_` : "";
		parts.push(chunk + suffix);
		partNum++;
	}
	return parts;
}

/**
 * Lists what the user has uploaded to this session, with size and — when the
 * outline cache already knows — page, sheet or slide counts.
 *
 * This is the cheapest rung of the search ladder. It costs a few dozen tokens
 * and removes the reflexive opening `glob` that used to spend a couple of
 * thousand listing paths the model mostly did not need. Nothing here extracts a
 * document: an unknown page count is simply left off.
 */
function buildAttachmentInventory(workspacePath: string, channelId: string): string {
	const dir = join(workspacePath, "sessions", channelId, "attachments");
	const files = collectAttachmentFiles(dir);
	if (files.length === 0) return "";

	const cacheDir = join(workspacePath, ".octo", "doc-index");
	const rows: Array<{ line: string; mtimeMs: number }> = [];

	if (files.length <= MAX_INVENTORY_ROWS) {
		for (const file of files) {
			let detail = formatSize(file.size);
			const kind = isExtractableDocument(file.full);
			if (kind) {
				const outline = readOutline(cacheDir, file.full, { size: file.size, mtimeMs: file.mtimeMs });
				const unit = kind === "pdf" ? "page" : kind === "pptx" ? "slide" : "sheet";
				detail +=
					outline?.unitCount !== undefined && outline.unitCount > 0
						? `, ${kind}, ${outline.unitCount} ${unit}${outline.unitCount === 1 ? "" : "s"}`
						: `, ${kind}`;
			}
			rows.push({ line: `${file.rel}\t${detail}`, mtimeMs: file.mtimeMs });
		}
	} else {
		// An uploaded folder can hold dozens of files; listing every one would turn the
		// cheapest rung of the ladder into an expensive one. Collapse each folder to a
		// single row — the agent globs or greps it from there.
		const folders = new Map<string, { count: number; size: number; mtimeMs: number }>();
		for (const file of files) {
			const cut = file.rel.indexOf("/");
			if (cut === -1) {
				rows.push({ line: `${file.rel}\t${formatSize(file.size)}`, mtimeMs: file.mtimeMs });
				continue;
			}
			const top = file.rel.slice(0, cut);
			const group = folders.get(top) ?? { count: 0, size: 0, mtimeMs: 0 };
			group.count += 1;
			group.size += file.size;
			group.mtimeMs = Math.max(group.mtimeMs, file.mtimeMs);
			folders.set(top, group);
		}
		for (const [name, group] of folders) {
			rows.push({
				line: `${name}/\t${group.count} file${group.count === 1 ? "" : "s"}, ${formatSize(group.size)}`,
				mtimeMs: group.mtimeMs,
			});
		}
	}
	if (rows.length === 0) return "";

	// Newest first, matching what `glob` reports, so "the file I just uploaded" is
	// always the top line.
	rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return rows.map((row) => row.line).join("\n");
}

/** Beyond this the inventory summarizes folders instead of naming every file in them. */
const MAX_INVENTORY_ROWS = 40;

type InventoryFile = { rel: string; full: string; size: number; mtimeMs: number };

/**
 * Every file under the session's attachments, with its path relative to that directory.
 * Uploading a folder keeps its tree, so a flat readdir would report the folder and none
 * of its contents.
 */
function collectAttachmentFiles(dir: string, prefix = "", out: InventoryFile[] = []): InventoryFile[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return out;
	}

	for (const name of names) {
		const full = join(dir, name);
		const rel = prefix ? `${prefix}/${name}` : name;
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(full);
		} catch {
			continue;
		}
		if (stat.isDirectory()) {
			collectAttachmentFiles(full, rel, out);
		} else if (stat.isFile()) {
			out.push({ rel, full, size: stat.size, mtimeMs: stat.mtimeMs });
		}
	}
	return out;
}

function buildSystemPrompt(
	workspacePath: string,
	channelId: string,
	memory: string,
	sandboxConfig: SandboxConfig,
	channels: ChannelInfo[],
	users: UserInfo[],
	skills: ReturnType<typeof loadSkills>,
	workspaceInstructions: string,
	remindersEnabled: boolean,
): string {
	const workspacePathFwd = workspacePath.replace(/\\/g, "/");
	const channelPath = `${workspacePathFwd}/sessions/${channelId}`;
	const workingDirectory = `${workspacePathFwd}/artifacts`;
	const isContainer = sandboxConfig.type === "docker" || sandboxConfig.type === "podman";
	const containerRuntime = sandboxConfig.type === "podman" ? "Podman" : "Docker";

	const channelMappings =
		channels.length > 0 ? channels.map((c) => `${c.id}\t#${c.name}`).join("\n") : "(no channels loaded)";

	const userMappings =
		users.length > 0 ? users.map((u) => `${u.displayName}\t@${u.id}\t${u.userName}`).join("\n") : "(no users loaded)";

	const envDescription = isContainer
		? `You are running inside a ${containerRuntime} container (Alpine Linux).
- Bash working directory: ${workingDirectory}
- Install tools with: apk add <package>
- Your changes persist across sessions`
		: process.platform === "win32"
		? `You are running directly on a Windows host machine using PowerShell.
- Shell: PowerShell (not cmd, not bash)
- Working directory: ${workingDirectory}
- Use forward slashes or double-backslashes in paths: C:/Users/... or C:\\Users\\...
- Use PowerShell syntax: New-Item -ItemType Directory -Force -Path <dir> (or just mkdir <dir>)
- For multi-line or complex scripts, use PowerShell idioms
- Be careful with system modifications`
		: `You are running directly on the host machine.
- Bash working directory: ${workingDirectory}
- Be careful with system modifications`;

	const attachmentInventory = buildAttachmentInventory(workspacePath, channelId);

	const workspaceInstructionsSection = workspaceInstructions.trim()
		? `\n## Workspace Instructions\nThese workspace-specific instructions are loaded from AGENTS.md/agents.md/CLAUDE.md/claude.md in the workspace root and override general behavior when they conflict.\n\n${workspaceInstructions.trim()}\n`
		: "";

	const eventsSection = remindersEnabled
		? `
## Events
You can schedule events that wake you up at specific times or when external things happen. Events are JSON files in \`${workspacePathFwd}/events/\`.

### Event Types

**Immediate** - Triggers as soon as harness sees the file. Use in scripts/webhooks to signal external events.
\`\`\`json
{"type": "immediate", "channelId": "${channelId}", "text": "New GitHub issue opened"}
\`\`\`

**One-shot** - Triggers once at a specific time. Use for reminders.
\`\`\`json
{"type": "one-shot", "channelId": "${channelId}", "text": "Remind Mario about dentist", "at": "2025-12-15T09:00:00+01:00"}
\`\`\`

**Periodic** - Triggers on a cron schedule. Use for recurring tasks.
\`\`\`json
{"type": "periodic", "channelId": "${channelId}", "text": "Check inbox and summarize", "schedule": "0 9 * * 1-5", "timezone": "${Intl.DateTimeFormat().resolvedOptions().timeZone}"}
\`\`\`

### Cron Format
\`minute hour day-of-month month day-of-week\`
- \`0 9 * * *\` = daily at 9:00
- \`0 9 * * 1-5\` = weekdays at 9:00
- \`30 14 * * 1\` = Mondays at 14:30
- \`0 0 1 * *\` = first of each month at midnight

### Timezones
All \`at\` timestamps must include offset (e.g., \`+01:00\`). Periodic events use IANA timezone names. The harness runs in ${Intl.DateTimeFormat().resolvedOptions().timeZone}. When users mention times without timezone, assume ${Intl.DateTimeFormat().resolvedOptions().timeZone}.

### Creating Events
Use unique filenames to avoid overwriting existing events. Include a timestamp or random suffix:
\`\`\`bash
cat > ${workspacePathFwd}/events/dentist-reminder-$(date +%s).json << 'EOF'
{"type": "one-shot", "channelId": "${channelId}", "text": "Dentist tomorrow", "at": "2025-12-14T09:00:00+01:00"}
EOF
\`\`\`
Or check if file exists first before creating.

### Managing Events
- List: \`ls ${workspacePathFwd}/events/\`
- View: \`cat ${workspacePathFwd}/events/foo.json\`
- Delete/cancel: \`rm ${workspacePathFwd}/events/foo.json\`

### When Events Trigger
You receive a message like:
\`\`\`
[EVENT:dentist-reminder.json:one-shot:2025-12-14T09:00:00+01:00] Dentist tomorrow
\`\`\`
Immediate and one-shot events auto-delete after triggering. Periodic events persist until you delete them.

### Silent Completion
For periodic events where there's nothing to report, respond with just \`[SILENT]\` (no other text). This deletes the status message and posts nothing to Slack. Use this to avoid spamming the channel when periodic checks find nothing actionable.

### Debouncing
When writing programs that create immediate events (email watchers, webhooks, etc.), always debounce. If 50 emails arrive in a minute, don't create 50 immediate events. Instead collect events over a window and create ONE immediate event summarizing what happened, or just signal "new activity, check inbox" rather than per-item events. Or simpler: use a periodic event to check for new items every N minutes instead of immediate events.

### Limits
Maximum 5 events can be queued. Don't create excessive immediate or periodic events.
`
		: "";

	return `You are ${getAppTitle()}, a Teams bot assistant. Be concise. No emojis.

## Context
- For current date/time, use: date
- You have access to previous conversation context including tool results from prior turns.
- For older history beyond your context, search log.jsonl (contains user messages and your final responses, but not tool results).

## Grounding: the workspace outranks what you already know
The artifacts folder and this session's attachments are the source of truth about this user's world. Your training data is not. When a file contradicts what you believe, **the file is right**, and you say which file it came from.

**Search whenever the question is about something that could be in a file here** — an invoice, order, contract, report, spec, ticket, meeting note, dataset, or any specific figure, date, name, ID or status belonging to the user. Do this on the first turn, without being asked. A confident answer built from general knowledge is wrong in a way the user may not catch.

The trap to avoid: recognizing the *kind* of thing being asked about and answering about the category instead of their instance. Knowing what a final invoice generally contains is not knowing what is in *their* final invoice. If the user names a document, a number, or a business object, assume the answer lives in a file and go find it.

### How to search: cheapest step first
Each step below costs roughly ten times the one before it. Do not skip ahead — pulling a whole document into context to find one paragraph is the most expensive mistake available to you, and it crowds out the conversation you are having.

0. **Honour what the user pointed at.** A \`<mentions>\` block on their message means they tagged those paths deliberately with \`@\` — start there before searching anywhere else. \`read\` a \`file:\` mention; \`glob\` or \`grep\` a \`dir:\` mention rather than trying to read it. The paths are given to you, not the contents, so fetch only what you need.
1. **Look at what you already have.** The attachments for this session are listed below, with their sizes and page counts. You do not need a \`glob\` to discover them.
2. **\`grep\` to locate.** It searches pdf, docx, xlsx and pptx too, and tells you which page, sheet or slide matched. Try more than one wording, including the user's own words and language, and the obvious synonyms — a miss on the first phrasing is not an answer. Use \`output_mode="files_with_matches"\` when you only need to know *where* something is.
3. **\`read\` to navigate.** A large document returns an outline of its pages rather than its text. That is the map, not a failure — read it and choose.
4. **\`read\` again with \`pages=\`** for just the part you need: \`pages="27"\`, \`pages="3-7"\`, \`pages="2,9"\`, or a sheet name. Use \`pages="all"\` only when the question genuinely needs the whole document.

Use \`glob\` when you need to discover files you have not been told about — it reports sizes, so you can tell a small note from a large report before opening either.

**Source code takes the same ladder, with line numbers where a document would use pages.** \`glob\` to find candidate files, \`grep\` to get \`path:line\`, then \`read(offset=<that line>, limit=…)\` for the region around it. \`read\` prefixes every text line with its number, so the coordinate \`grep\` gave you is the one you get back and a second hit in the same file is one more \`offset\` away. Reading a whole source file to look at one method is the same mistake as pulling a whole PDF for one paragraph. Strip the \`42→\` prefix before you quote a line or hand it to \`edit\` — it is not in the file.

**Delegate the wide sweeps.** When the answer needs more than about three documents read, or the search is open-ended, launch \`task\` with the \`doc-research\` subagent. It reads on its own context budget and returns the answer with citations, which keeps hundreds of pages out of this conversation.

Then answer **from what the files say**, and name the file and page.

If the search genuinely turns up nothing, say what you searched for and where, and ask — do not fill the gap from memory. If \`grep\` reports that it skipped a document (for example a scanned PDF with no text layer), tell the user that instead of treating the file as empty.

## Teams Formatting (mrkdwn, NOT Markdown)
Bold: *text*, Italic: _text_, Code: \`code\`, Block: \`\`\`code\`\`\`, Links: <url|text>
Do NOT use **double asterisks** or [markdown](links).

## Teams IDs
Channels: ${channelMappings}

Users: ${userMappings}

When mentioning users, use <@username> format (e.g., <@mario>).

## Environment
${envDescription}

## Workspace Layout
${workspacePathFwd}/
├── MEMORY.md                    # Global memory (all channels)
├── SYSTEM.md                    # Environment config log
├── skills/                      # Global CLI tools you create
├── artifacts/                   # Durable user-requested outputs shared by all sessions
└── sessions/${channelId}/       # This channel
    ├── MEMORY.md                # Channel-specific memory
    ├── log.jsonl                # Message history (no tool results)
    ├── attachments/             # User-shared files
    └── skills/                  # Channel-specific tools

Relative file paths in tools resolve inside \`${workingDirectory}/\`.

\`glob\` and \`grep\` search two places by default: \`${workspacePathFwd}/artifacts/\` and this session's \`${channelPath}/attachments/\`. So a file the user just uploaded is already in scope — you do not need to pass a \`path\` to reach it, and you should not assume an upload is invisible to you. Pass \`path\` only to deliberately narrow the search; doing so searches that directory alone.
${attachmentInventory ? `\n## Session Attachments\nFiles the user uploaded to this session, newest first. These are already in scope for \`glob\` and \`grep\`, and are usually what a question is about.\n\n${attachmentInventory}\n` : ""}

## File Outputs
- Your working directory is the shared workspace artifacts folder: \`${workspacePathFwd}/artifacts/\`.
- When the user asks you to create, save, export, or share a file, write the final file in this directory.
- This applies to Markdown, text, JSON, HTML, SVG, reports, generated assets, and any other user-requested saved output.
- Use a subdirectory inside \`${workspacePathFwd}/artifacts/\` for temporary or intermediate work if needed.

## Structured Workspace Data
- For durable CRM-style records, tables, pipelines, inventory, contacts, or other shared structured data, prefer a \`.duckdb\` database file in \`${workspacePathFwd}/artifacts/\` when DuckDB is available.
- Use descriptive database filenames such as \`crm.duckdb\`, \`research.duckdb\`, or \`inventory.duckdb\` when multiple structured datasets are useful.
- Do not create ad hoc CSV files for persistent workspace records unless the user explicitly asks for an export. Use CSV/XLSX only as import/export formats.
- Generated reports, previews, and exported files still belong in \`${workspacePathFwd}/artifacts/\`.

## Artifacts (Interactive Canvas)
**Rule: Any time you create an HTML, SVG, or visualization file, you MUST:**
1. Write it to \`${workspacePathFwd}/artifacts/\`
2. Immediately call \`attach\` with that file path so the user sees it rendered inline as an interactive canvas

\`\`\`
mkdir -p ${workspacePathFwd}/artifacts
# On Windows PowerShell: mkdir ${workspacePathFwd}/artifacts -Force
\`\`\`

Then use the write tool to create the file there, then call attach:
- \`attach\` path: \`${workspacePathFwd}/artifacts/my-file.html\`
- \`attach\` title: a short descriptive name like "Poem" or "Dashboard"

Do NOT just tell the user the file path — always call \`attach\` so it renders in the chat.

## Workspace Skills
Workspace skills are instruction files that provide specialized domain guidance. They are not callable tools.

### Creating Skills
Store in \`${workspacePathFwd}/skills/<name>/\` (global) or \`${channelPath}/skills/<name>/\` (channel-specific).
Each skill directory needs a \`SKILL.md\` with YAML frontmatter:

\`\`\`markdown
---
name: skill-name
description: Short description of what this skill does
---

# Skill Name

Usage instructions, examples, etc.
Scripts are in: {baseDir}/
\`\`\`

\`name\` and \`description\` are required. Use \`{baseDir}\` as placeholder for the skill's directory path.

### Available Skills
${skills.length > 0 ? formatSkillsForPrompt(skills) : "(no skills installed yet)"}

If a skill is listed above, it is available in this workspace. Do not claim a listed skill is unavailable and do not look for it as a tool.
When the user asks to use a listed skill, or the request strongly matches a listed skill description, read that skill's \`SKILL.md\` from the listed location before answering unless the answer is only a trivial clarification.

### Invoked skills
A \`<skills>\` block on a user message means they invoked those skills explicitly by name (the \`/skill-name\` mechanic in the composer). That is not a hint to weigh like a mention — it is the instruction for the request:
1. \`read\` each listed \`SKILL.md\` **first**, before any other tool call and before answering.
2. Follow it for this request, including anything it says about scripts or references in its own directory.
3. Do not ask whether the skill should be used, and do not answer from general knowledge instead. If a listed path cannot be read, say so plainly rather than improvising.
Treat natural names as aliases for listed skill IDs. For example, "abap cds skill", "ABAP CDS", and "CDS skill" refer to \`sap-abap-cds\` when that skill is listed.

${eventsSection}

## Memory
Write to MEMORY.md files to persist context across conversations.
- Global (${workspacePathFwd}/MEMORY.md): skills, preferences, project info
- Channel (${channelPath}/MEMORY.md): channel-specific decisions, ongoing work
Update when you learn something important or when asked to remember something.

### Current Memory
${memory}

## System Configuration Log
Maintain ${workspacePathFwd}/SYSTEM.md to log all environment modifications:
- Installed packages (apk add, npm install, pip install)
- Environment variables set
- Config files modified (~/.gitconfig, cron jobs, etc.)
- Skill dependencies installed

Update this file whenever you modify the environment. On fresh container, read it first to restore your setup.
${workspaceInstructionsSection}

## Log Queries (for older history)
Format: \`{"date":"...","ts":"...","user":"...","userName":"...","text":"...","isBot":false}\`
The log contains user messages and your final responses (not tool calls/results).
${isContainer ? "Install jq: apk add jq" : ""}

\`\`\`bash
# Recent messages
tail -30 log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Search for specific topic
grep -i "topic" log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Messages from specific user
grep '"userName":"mario"' log.jsonl | tail -20 | jq -c '{date: .date[0:19], text}'
\`\`\`

## Tools

Files and shell
- read: Read files. Text lines come back prefixed with their line number (\`  42→…\`), which is the same number \`grep\` reports — so use \`offset\` to land on a match instead of reading the file from the top. The prefix is not part of the file. For pdf, docx, xlsx and pptx it returns the document's extracted text with page/sheet/slide markers instead. A large document returns an outline of its pages rather than its body — pick from it and read again with \`pages="3-7"\` rather than pulling the whole document into context.
- write: Create/overwrite files
- edit: Surgical file edits. \`oldText\` must match the file exactly, so strip the \`42→\` line-number prefix off anything you copied out of \`read\`.
- bash: Run shell commands. Install packages as needed. Set run_in_background for long-running commands.
- attach: Share files to Web or Teams

Search — prefer these over running find/grep/dir through bash. They behave identically on the host and in the sandbox, whereas shell commands do not. Both cover the workspace artifacts folder and this session's attachments; see "Grounding" above for when to reach for them.
- glob: Find files by pattern, newest first, with their size and (for documents) page count. Use it to discover files you have not been told about; the attachments for this session are already listed above.
- grep: Search file contents by regular expression. It also looks inside pdf, docx, xlsx and pptx by extracting their text, names the page/sheet/slide that matched, and reports which documents it had to skip and why (for example a scanned PDF with no text layer). When looking for information that could be in an attachment or report, grep before answering at all — not just before concluding it is not there — and try more than one wording, including the user's own language. On a broad search it shows a few matches per file so one noisy file cannot hide the others; narrow with \`path\` or \`glob\` to see everything in one file.

Background shells
- bash_output: Read new output from a background shell
- kill_shell: Stop a background shell

Web
- web_fetch: Read one http(s) URL as Markdown. Private and internal hosts are blocked; reach SAP systems through the sap-adt connector instead.

Planning and delegation
- todo_write: Keep the task list current for any work with several steps, so the user can see progress. Send the whole list each time and keep one item in_progress.
- exit_plan_mode: In plan mode, present your plan and leave plan mode before making changes
- task: Launch a subagent for self-contained work. It has its own context window, so use it for broad searches whose intermediate output you do not need. For questions that have to be answered out of several documents, use the \`doc-research\` type: it does the reading on its own budget and returns the answer with file and page citations.

Each tool requires a "label" parameter (shown to user).

`;
}

function loadWorkspaceInstructions(workspacePath: string): string {
	for (const filename of ["AGENTS.md", "agents.md", "CLAUDE.md", "claude.md"]) {
		const path = join(workspacePath, filename);
		if (existsSync(path)) return readFileSync(path, "utf-8");
	}
	return "";
}

// Cache one CoreAgent per channel/auth file. AgentSession owns a ModelRegistry
// bound to its AuthStorage, so recreate the agent when a web user auth path changes.
const channelAgents = new Map<string, { agent: CoreAgent; authFilePath?: string; agentWorkersEnabled?: boolean; remindersEnabled?: boolean; mcpKey: string; toolsKey: string; mcpTools: AgentTool<any>[] }>();

function getMcpKey(servers: McpServerConfig[] | undefined): string {
	return JSON.stringify(servers ?? []);
}

/** The tool set is baked into the agent at construction, so a change must evict it. */
export function getToolsKey(enabledTools: string[] | undefined): string {
	return JSON.stringify(enabledTools ?? null);
}

/** Evict the cached CoreAgent for a channel and close its MCP tools (permanent session delete). */
export function disposeChannelAgent(channelId: string): void {
	const entry = channelAgents.get(channelId);
	if (!entry) return;
	closeMcpTools(entry.mcpTools);
	// Kills any background shells the session left running.
	void entry.agent.dispose().catch((err) => {
		console.warn(`Failed to dispose agent for ${channelId}: ${err instanceof Error ? err.message : String(err)}`);
	});
	channelAgents.delete(channelId);
}

export async function getOrCreateRunner(
	sandboxConfig: SandboxConfig,
	channelId: string,
	channelDir: string,
	options: RunnerOptions = {},
): Promise<AgentRunner> {
	const existing = channelAgents.get(channelId);
	const mcpKey = getMcpKey(options.mcpServers);
	const toolsKey = getToolsKey(options.enabledTools);
	if (
		existing &&
		existing.authFilePath === options.authFilePath &&
		existing.agentWorkersEnabled === options.agentWorkersEnabled &&
		existing.remindersEnabled === options.remindersEnabled &&
		existing.mcpKey === mcpKey &&
		existing.toolsKey === toolsKey
	) {
		return createRunner(existing.agent, sandboxConfig, channelId, channelDir, options.remindersEnabled !== false);
	}

	const extraTools = await createMcpTools(options.mcpServers);
	closeMcpTools(existing?.mcpTools);

	const agent = new CoreAgent(channelId, {
		sandboxConfig,
		channelDir,
		authFilePath: options.authFilePath,
		userId: options.userId,
		usersRoot: options.usersRoot,
		agentWorkersEnabled: options.agentWorkersEnabled,
		extraTools,
		enabledTools: options.enabledTools,
	});
	channelAgents.set(channelId, { agent, authFilePath: options.authFilePath, agentWorkersEnabled: options.agentWorkersEnabled, remindersEnabled: options.remindersEnabled, mcpKey, toolsKey, mcpTools: extraTools });
	return createRunner(agent, sandboxConfig, channelId, channelDir, options.remindersEnabled !== false);
}

function createRunner(
	coreAgent: CoreAgent,
	sandboxConfig: SandboxConfig,
	channelId: string,
	channelDir: string,
	remindersEnabled: boolean,
): AgentRunner {
	return {
		async run(
			ctx: BotContext,
			_store: ChannelStore,
			_pendingMessages?: PendingMessage[],
		): Promise<{ stopReason: string; errorMessage?: string }> {
			const logCtx = {
				channelId: ctx.message.channel,
				userName: ctx.message.userName,
				channelName: ctx.channelName,
			};

			// Sequential message queue for Slack delivery
			let queueChain = Promise.resolve();
			const enqueue = (fn: () => Promise<void>, errorContext: string): void => {
				queueChain = queueChain.then(async () => {
					try {
						await fn();
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning(`Slack API error (${errorContext})`, errMsg);
						try {
							await ctx.respondInThread(`_Error: ${errMsg}_`);
						} catch {
							// Ignore
						}
					}
				});
			};

			const enqueueMessage = (text: string, target: "main" | "thread", errorContext: string, doLog = true): void => {
				for (const part of splitForSlack(text)) {
					enqueue(
						() => (target === "main" ? ctx.respond(part, doLog) : ctx.respondInThread(part)),
						errorContext,
					);
				}
			};

			const emit = ctx.emitAgentEvent;
			let turnIndex = -1;
			let lastModel: { provider: string; id: string } | undefined;

			const events: CoreAgentEventHandlers = {
				onToolStart(toolName, label, args, toolCallId) {
					log.logToolStart(logCtx, toolName, label, args);
					if (emit) {
						emit({ type: "tool", seq: 0, phase: "start", toolCallId: toolCallId ?? "", toolName, label, args, ts: Date.now() });
						const skill = detectSkillFromToolCall(toolName, args);
						if (skill) {
							emit({ type: "skill", seq: 0, name: skill.name, path: skill.path, toolCallId: toolCallId ?? "", ts: Date.now() });
						}
						return;
					}
					enqueue(() => ctx.respond(`_→ ${label}_`, false), "tool label");
				},

				onToolEnd(toolName, label, args, durationMs, resultText, isError, toolCallId) {
					if (isError) {
						log.logToolError(logCtx, toolName, durationMs, resultText);
					} else {
						log.logToolSuccess(logCtx, toolName, durationMs, resultText);
					}

					if (emit) {
						emit({
							type: "tool",
							seq: 0,
							phase: "end",
							toolCallId: toolCallId ?? "",
							toolName,
							label,
							args,
							durationMs,
							result: resultText,
							resultTruncated: false,
							isError,
							ts: Date.now(),
						});
						return;
					}

					const argsFormatted = formatToolArgsForSlack(toolName, args);
					const duration = (durationMs / 1000).toFixed(1);
					let threadMessage = `*${isError ? "✗" : "✓"} ${toolName}*`;
					if (label) threadMessage += `: ${label}`;
					threadMessage += ` (${duration}s)\n`;
					if (argsFormatted) threadMessage += `\`\`\`\n${argsFormatted}\n\`\`\`\n`;
					threadMessage += `*Result:*\n\`\`\`\n${resultText}\n\`\`\``;

					enqueueMessage(threadMessage, "thread", "tool result thread", false);

					if (isError) {
						enqueue(() => ctx.respond(`_Error: ${truncate(resultText, 200)}_`, false), "tool error");
					}
				},

				onToolUpdate(toolName, label, args, resultText, toolCallId) {
					if (!resultText.trim()) return;
					log.logInfo(`[${channelId}] ${toolName} update: ${truncate(resultText, 200)}`);
					if (emit) {
						emit({ type: "tool", seq: 0, phase: "update", toolCallId: toolCallId ?? "", toolName, partialResult: resultText });
						return;
					}
					const argsFormatted = formatToolArgsForSlack(toolName, args);
					let threadMessage = `*… ${toolName}*`;
					if (label) threadMessage += `: ${label}`;
					threadMessage += "\n";
					if (argsFormatted) threadMessage += `\`\`\`\n${argsFormatted}\n\`\`\`\n`;
					threadMessage += `*Progress:*\n\`\`\`\n${resultText}\n\`\`\``;
					enqueueMessage(threadMessage, "thread", "tool progress thread", false);
				},

				onMessage(text) {
					log.logResponse(logCtx, text);
					if (emit) return;
					enqueueMessage(text, "main", "response main");
					enqueueMessage(text, "thread", "response thread", false);
				},

				onThinking(thinking) {
					log.logThinking(logCtx, thinking);
					if (emit) return;
					enqueueMessage(`_${thinking}_`, "main", "thinking main");
					enqueueMessage(`_${thinking}_`, "thread", "thinking thread", false);
				},

				onCompactionStart(reason) {
					log.logInfo(`Auto-compaction started (reason: ${reason})`);
					if (emit) {
						emit({ type: "compaction", seq: 0, phase: "start", reason });
						return;
					}
					enqueue(() => ctx.respond("_Compacting context..._", false), "compaction start");
				},

				onCompactionEnd(result, aborted) {
					if (result) {
						log.logInfo(`Auto-compaction complete: ${result.tokensBefore} tokens compacted`);
					} else if (aborted) {
						log.logInfo("Auto-compaction aborted");
					}
					emit?.({ type: "compaction", seq: 0, phase: "end", tokensBefore: result?.tokensBefore, aborted });
				},

				onRetry(attempt, maxAttempts, errorMessage) {
					log.logWarning(`Retrying (${attempt}/${maxAttempts})`, errorMessage);
					if (emit) {
						emit({ type: "retry", seq: 0, attempt, maxAttempts, errorMessage });
						return;
					}
					enqueue(
						() => ctx.respond(`_Retrying (${attempt}/${maxAttempts})..._`, false),
						"retry",
					);
				},

				onTurnStart() {
					if (!emit) return;
					turnIndex++;
					emit({ type: "turn", seq: 0, phase: "start", turnIndex, ts: Date.now() });
				},
				onTurnEnd() {
					emit?.({ type: "turn", seq: 0, phase: "end", turnIndex: Math.max(turnIndex, 0), ts: Date.now() });
				},
				onBlockStart(blockId, kind) {
					emit?.({ type: "block", seq: 0, phase: "start", blockId, kind, ts: Date.now() });
				},
				onBlockDelta(blockId, kind, delta) {
					emit?.({ type: "block", seq: 0, phase: "delta", blockId, kind, delta });
				},
				onBlockEnd(blockId, kind, content) {
					emit?.({ type: "block", seq: 0, phase: "end", blockId, kind, content });
				},
				onToolCall(toolCallId, toolName, args) {
					emit?.({ type: "tool", seq: 0, phase: "call", toolCallId, toolName, args, ts: Date.now() });
				},
				onUsage(usage, _stopReason, model) {
					if (model?.id) lastModel = model;
					emit?.({ type: "usage", seq: 0, scope: "message", usage, model });
				},
			};

			// Build system prompt with fresh memory/skills/channels/users
			const memory = getMemory(channelDir);
			const skills = loadSkills(channelDir, coreAgent.workspacePath);
			const hostWorkspacePath = join(channelDir, "..", "..");
			const workspaceInstructions = loadWorkspaceInstructions(hostWorkspacePath);
			const systemPrompt = buildSystemPrompt(
				coreAgent.workspacePath,
				channelId,
				memory,
				sandboxConfig,
				ctx.channels,
				ctx.users,
				skills,
				workspaceInstructions,
				remindersEnabled,
			);

			log.logInfo(`Context sizes - system: ${systemPrompt.length} chars, memory: ${memory.length} chars`);
			log.logInfo(`Channels: ${ctx.channels.length}, Users: ${ctx.users.length}`);
			log.logResponseStart(logCtx);

			const result = await coreAgent.run({
				text: ctx.message.text,
				ts: ctx.message.ts,
				userName: ctx.message.userName,
				attachments: ctx.message.attachments,
				mentions: ctx.message.mentions,
				skills: ctx.message.skills,
				systemPrompt,
				authFilePath: ctx.authFilePath,
				model: ctx.model,
				uploadFile: async (hostPath, title) => {
					await ctx.uploadFile(hostPath, title);
				},
				events,
			});

			// Drain Slack message queue before final state handling
			await queueChain;

			// Handle final state
			if (result.stopReason === "error" && result.errorMessage) {
				try {
					await ctx.replaceMessage("_Sorry, something went wrong_");
					await ctx.respondInThread(`_Error: ${result.errorMessage}_`);
				} catch (err) {
					log.logWarning("Failed to post error message", err instanceof Error ? err.message : String(err));
				}
			} else {
				const finalText = result.lastAssistantText ?? "";

				if (finalText.trim() === "[SILENT]" || finalText.trim().startsWith("[SILENT]")) {
					try {
						await ctx.deleteMessage();
						log.logInfo("Silent response - deleted message and thread");
					} catch (err) {
						log.logWarning("Failed to delete message for silent response", err instanceof Error ? err.message : String(err));
					}
				} else if (finalText.trim()) {
					try {
						const mainText =
							finalText.length > SLACK_MAX_LENGTH
								? `${finalText.substring(0, SLACK_MAX_LENGTH - 50)}\n\n_(see thread for full response)_`
								: finalText;
						await ctx.replaceMessage(mainText);
					} catch (err) {
						log.logWarning("Failed to replace message with final text", err instanceof Error ? err.message : String(err));
					}
				}
			}

			if (emit) {
				const messages = coreAgent.messages;
				const lastAssistant = messages
					.slice()
					.reverse()
					.find((m) => m.role === "assistant" && (m as any).stopReason !== "aborted") as any;
				const contextTokens = lastAssistant
					? lastAssistant.usage.input +
						lastAssistant.usage.output +
						lastAssistant.usage.cacheRead +
						lastAssistant.usage.cacheWrite
					: 0;
				emit({
					type: "usage",
					seq: 0,
					scope: "run",
					usage: result.usage,
					model: lastModel,
					contextTokens,
					contextWindow: coreAgent.modelContextWindow,
				});
			}

			// Post usage summary
			if (result.usage.cost.total > 0) {
				// Derive context size from last assistant message
				const messages = coreAgent.messages;
				const lastAssistantMsg = messages
					.slice()
					.reverse()
					.find((m) => m.role === "assistant" && (m as any).stopReason !== "aborted") as any;

				const contextTokens = lastAssistantMsg
					? lastAssistantMsg.usage.input +
						lastAssistantMsg.usage.output +
						lastAssistantMsg.usage.cacheRead +
						lastAssistantMsg.usage.cacheWrite
					: 0;
				const contextWindow = coreAgent.modelContextWindow;

				const summary = log.logUsageSummary(logCtx, result.usage, contextTokens, contextWindow);
				if (!emit) {
					enqueue(() => ctx.respondInThread(summary), "usage summary");
					await queueChain;
				}
			}

			return { stopReason: result.stopReason, errorMessage: result.errorMessage };
		},

		abort() {
			coreAgent.abort();
		},
	};
}
