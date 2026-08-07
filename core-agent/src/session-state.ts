/**
 * Per-session agent state that is neither chat history nor workspace content:
 * the task list written by `todo_write` and the current permission mode enforced
 * for `exit_plan_mode`.
 *
 * State is held in memory and mirrored to `<channelDir>/session-state.json` so a
 * task list survives a service restart. Persistence failures never break a tool
 * call — the in-memory value stays authoritative.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
	/** Imperative description of the work, e.g. "Add the grep tool". */
	content: string;
	status: TodoStatus;
	/** Present-tense label shown while the item is in progress. */
	activeForm: string;
}

/** "plan" restricts the agent to read-only tools until `exit_plan_mode` runs. */
export type AgentMode = "default" | "plan";

interface SessionState {
	todos: TodoItem[];
	mode: AgentMode;
}

interface SessionStateEntry extends SessionState {
	filePath: string;
}

const STATE_FILE = "session-state.json";

const states = new Map<string, SessionStateEntry>();

function load(sessionId: string, channelDir: string): SessionStateEntry {
	const existing = states.get(sessionId);
	if (existing) return existing;

	const filePath = join(channelDir, STATE_FILE);
	const entry: SessionStateEntry = { todos: [], mode: "default", filePath };

	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<SessionState>;
		if (Array.isArray(parsed.todos)) entry.todos = parsed.todos.filter(isTodoItem);
		if (parsed.mode === "plan" || parsed.mode === "default") entry.mode = parsed.mode;
	} catch {
		// No state yet, or unreadable: start clean.
	}

	states.set(sessionId, entry);
	return entry;
}

function isTodoItem(value: unknown): value is TodoItem {
	if (typeof value !== "object" || value === null) return false;
	const item = value as Record<string, unknown>;
	return (
		typeof item.content === "string" &&
		typeof item.activeForm === "string" &&
		(item.status === "pending" || item.status === "in_progress" || item.status === "completed")
	);
}

function persist(entry: SessionStateEntry): void {
	try {
		writeFileSync(entry.filePath, JSON.stringify({ todos: entry.todos, mode: entry.mode }, null, 2), "utf-8");
	} catch {
		// Session state must not fail a tool call because persistence failed.
	}
}

/** Binds the state helpers to one session; created once per CoreAgent. */
export class SessionStateStore {
	constructor(
		private readonly sessionId: string,
		private readonly channelDir: string,
	) {}

	getTodos(): TodoItem[] {
		return load(this.sessionId, this.channelDir).todos;
	}

	/** Full replacement, matching the tool's contract of always sending the whole list. */
	setTodos(todos: TodoItem[]): void {
		const entry = load(this.sessionId, this.channelDir);
		entry.todos = todos;
		persist(entry);
	}

	getMode(): AgentMode {
		return load(this.sessionId, this.channelDir).mode;
	}

	setMode(mode: AgentMode): void {
		const entry = load(this.sessionId, this.channelDir);
		entry.mode = mode;
		persist(entry);
	}
}

/** Drops cached state for a session (called when a session is disposed). */
export function forgetSessionState(sessionId: string): void {
	states.delete(sessionId);
}

/** Renders a task list as a checklist for tool output. */
export function formatTodos(todos: TodoItem[]): string {
	if (todos.length === 0) return "(task list is empty)";
	return todos
		.map((todo) => {
			const marker = todo.status === "completed" ? "x" : todo.status === "in_progress" ? "~" : " ";
			const text = todo.status === "in_progress" ? todo.activeForm : todo.content;
			return `- [${marker}] ${text}`;
		})
		.join("\n");
}
