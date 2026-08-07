/**
 * Registry of background shells started by the `bash` tool with
 * `run_in_background: true`.
 *
 * Modeled on the ACP job registry: a module-level map holding one record per
 * shell, with the live child process kept off the snapshot type so callers
 * cannot accidentally serialize it. Output is retained in a bounded buffer and
 * handed out incrementally, so `bash_output` returns only what is new since the
 * previous read.
 */

import type { ChildProcess } from "node:child_process";
import type { Executor } from "./sandbox.js";

/** Per-stream retention. Older output is dropped, and the gap is reported. */
const OUTPUT_BUFFER_CHARS = 256 * 1024;
/** Finished shells are kept this long so their output can still be collected. */
const COMPLETED_RETENTION_MS = 30 * 60 * 1000;

export type BackgroundShellStatus = "running" | "completed" | "failed" | "killed";

export interface BackgroundShellSnapshot {
	id: string;
	sessionId: string;
	command: string;
	status: BackgroundShellStatus;
	exitCode?: number;
	startedAt: string;
	finishedAt?: string;
}

export interface BackgroundShellRead extends BackgroundShellSnapshot {
	/** Output produced since the previous read of this stream. */
	stdout: string;
	stderr: string;
	/** True when retention dropped output that was never read. */
	truncated: boolean;
}

/** Bounded append-only buffer that tracks how much has been consumed. */
class OutputBuffer {
	private text = "";
	private dropped = 0;
	private cursor = 0;

	append(chunk: string): void {
		this.text += chunk;
		if (this.text.length > OUTPUT_BUFFER_CHARS) {
			const excess = this.text.length - OUTPUT_BUFFER_CHARS;
			this.text = this.text.slice(excess);
			this.dropped += excess;
		}
	}

	/** Consumes and returns everything appended since the previous call. */
	drain(): { text: string; lostOutput: boolean } {
		const total = this.dropped + this.text.length;
		const lostOutput = this.cursor < this.dropped;
		const start = Math.max(this.cursor, this.dropped) - this.dropped;
		const text = this.text.slice(start);
		this.cursor = total;
		return { text, lostOutput };
	}
}

interface BackgroundShellRecord extends BackgroundShellSnapshot {
	child: ChildProcess;
	executor: Executor;
	stdout: OutputBuffer;
	stderr: OutputBuffer;
}

const shells = new Map<string, BackgroundShellRecord>();

function createId(): string {
	return `bash_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function snapshot(record: BackgroundShellRecord): BackgroundShellSnapshot {
	return {
		id: record.id,
		sessionId: record.sessionId,
		command: record.command,
		status: record.status,
		exitCode: record.exitCode,
		startedAt: record.startedAt,
		finishedAt: record.finishedAt,
	};
}

/** Drops long-finished shells so the map does not grow without bound. */
function reapCompleted(): void {
	const cutoff = Date.now() - COMPLETED_RETENTION_MS;
	for (const [id, record] of shells) {
		if (record.status === "running") continue;
		if (!record.finishedAt) continue;
		if (Date.parse(record.finishedAt) < cutoff) shells.delete(id);
	}
}

export function startBackgroundShell(options: {
	executor: Executor;
	sessionId: string;
	command: string;
}): BackgroundShellSnapshot {
	reapCompleted();

	const child = options.executor.spawnShell(options.command);
	const record: BackgroundShellRecord = {
		id: createId(),
		sessionId: options.sessionId,
		command: options.command,
		status: "running",
		startedAt: new Date().toISOString(),
		child,
		executor: options.executor,
		stdout: new OutputBuffer(),
		stderr: new OutputBuffer(),
	};

	child.stdout?.on("data", (data: Buffer) => record.stdout.append(data.toString()));
	child.stderr?.on("data", (data: Buffer) => record.stderr.append(data.toString()));
	child.on("error", (err: Error) => {
		record.stderr.append(`\n${err.message}\n`);
		if (record.status === "running") {
			record.status = "failed";
			record.finishedAt = new Date().toISOString();
		}
	});
	child.on("close", (code: number | null) => {
		if (record.status === "killed") {
			record.finishedAt ??= new Date().toISOString();
			return;
		}
		record.exitCode = code ?? 0;
		record.status = record.exitCode === 0 ? "completed" : "failed";
		record.finishedAt = new Date().toISOString();
	});

	shells.set(record.id, record);
	return snapshot(record);
}

export function getBackgroundShell(id: string): BackgroundShellSnapshot | undefined {
	const record = shells.get(id);
	return record ? snapshot(record) : undefined;
}

export function listBackgroundShells(sessionId?: string): BackgroundShellSnapshot[] {
	const all = [...shells.values()].filter((record) => !sessionId || record.sessionId === sessionId);
	return all.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(snapshot);
}

/**
 * Reads and consumes the output produced since the previous read. `filter` keeps
 * only lines matching a regular expression, applied per stream.
 */
export function readBackgroundShell(id: string, filter?: string): BackgroundShellRead {
	const record = shells.get(id);
	if (!record) throw new Error(`Unknown background shell: ${id}`);

	const out = record.stdout.drain();
	const err = record.stderr.drain();

	let regex: RegExp | undefined;
	if (filter) {
		try {
			regex = new RegExp(filter);
		} catch (cause) {
			throw new Error(`Invalid filter regular expression: ${cause instanceof Error ? cause.message : String(cause)}`);
		}
	}

	const applyFilter = (text: string): string => {
		if (!regex || !text) return text;
		return text
			.split("\n")
			.filter((line) => regex.test(line))
			.join("\n");
	};

	return {
		...snapshot(record),
		stdout: applyFilter(out.text),
		stderr: applyFilter(err.text),
		truncated: out.lostOutput || err.lostOutput,
	};
}

export async function killBackgroundShell(id: string): Promise<BackgroundShellSnapshot> {
	const record = shells.get(id);
	if (!record) throw new Error(`Unknown background shell: ${id}`);
	if (record.status !== "running") return snapshot(record);

	record.status = "killed";
	record.finishedAt = new Date().toISOString();
	await record.executor.terminateShell(record.child);
	return snapshot(record);
}

/** Kills every shell of a session. Called when a session is disposed. */
export async function killSessionShells(sessionId: string): Promise<void> {
	const running = [...shells.values()].filter((record) => record.sessionId === sessionId && record.status === "running");
	await Promise.all(running.map((record) => killBackgroundShell(record.id).catch(() => undefined)));
	for (const record of shells.values()) {
		if (record.sessionId === sessionId) shells.delete(record.id);
	}
}
