/**
 * On-disk outline cache.
 *
 * The in-memory cache in `extract.ts` holds full document text for 50 entries and
 * dies with the process. This sidecar holds **outlines only** — locators, sizes
 * and one preview line each, never document text — so it stays small, is safe to
 * keep indefinitely, and is emphatically not a retrieval index (see CLAUDE.md §1:
 * RAG is not part of the core).
 *
 * Its job is to answer "what is in this file" without paying for extraction:
 * the session attachment inventory in the system prompt needs page counts on
 * every prompt build, and re-parsing a 40-page PDF for that would be absurd.
 *
 * Freshness: entries record `size` and `mtimeMs`. A reader validates both when
 * the entry carries an mtime, and `size` alone when it does not — `read` works
 * from bytes handed over by an executor and has no stat to offer, which is why
 * `MTIME_UNKNOWN` exists. A stale entry therefore degrades the inventory to
 * name/size/kind; it can never put wrong page text in front of the model,
 * because outlines are only ever *written* from a fresh extraction.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DocumentOutline } from "./outline.js";

/** Recorded when the writer has bytes but no stat. Readers validate on size only. */
export const MTIME_UNKNOWN = 0;

/** Outlines are a few KB each; this bounds the directory without any real cost. */
const MAX_ENTRIES = 500;

export interface CachedOutline extends DocumentOutline {
	path: string;
	size: number;
	mtimeMs: number;
}

let cacheDir: string | undefined;

/**
 * Points the cache at a workspace. `.octo` is already in the search engine's
 * DEFAULT_EXCLUDES, so nothing written here can ever turn up in a glob or grep.
 */
export function configureOutlineCache(hostWorkspacePath: string | undefined): void {
	cacheDir = hostWorkspacePath ? join(hostWorkspacePath, ".octo", "doc-index") : undefined;
}

/** The configured directory, or undefined when the host declared none. */
export function getOutlineCacheDir(): string | undefined {
	return cacheDir;
}

function entryFile(dir: string, path: string): string {
	return join(dir, `${createHash("sha1").update(path).digest("hex")}.json`);
}

/**
 * Deletes the oldest entries once the directory grows past MAX_ENTRIES. Runs only
 * after a write, and failures are ignored: a full cache directory is a housekeeping
 * problem, never a reason to fail a read.
 */
function prune(dir: string): void {
	try {
		const entries = readdirSync(dir).filter((name) => name.endsWith(".json"));
		if (entries.length <= MAX_ENTRIES) return;

		const timed = entries.map((name) => {
			const full = join(dir, name);
			try {
				return { full, mtime: statSync(full).mtimeMs };
			} catch {
				return { full, mtime: 0 };
			}
		});
		timed.sort((a, b) => b.mtime - a.mtime);
		for (const stale of timed.slice(MAX_ENTRIES)) {
			try {
				rmSync(stale.full, { force: true });
			} catch {
				// Ignore: another process may have removed it already.
			}
		}
	} catch {
		// Ignore.
	}
}

/**
 * Stores an outline derived from a fresh extraction. Never throws — a cache that
 * cannot be written is slower, not broken.
 */
export function writeOutline(
	path: string,
	outline: DocumentOutline,
	stat: { size: number; mtimeMs?: number },
): void {
	if (!cacheDir) return;
	try {
		mkdirSync(cacheDir, { recursive: true });
		const payload: CachedOutline = {
			...outline,
			path,
			size: stat.size,
			mtimeMs: stat.mtimeMs ?? MTIME_UNKNOWN,
		};
		writeFileSync(entryFile(cacheDir, path), JSON.stringify(payload), "utf-8");
		prune(cacheDir);
	} catch {
		// Ignore.
	}
}

/**
 * Looks up an outline that still matches the file on disk. `dir` is explicit so
 * a host (core-service building a system prompt) can read the cache without
 * depending on module configuration order.
 */
export function readOutline(
	dir: string | undefined,
	path: string,
	stat: { size: number; mtimeMs?: number },
): CachedOutline | undefined {
	if (!dir) return undefined;
	try {
		const file = entryFile(dir, path);
		if (!existsSync(file)) return undefined;

		const cached = JSON.parse(readFileSync(file, "utf-8")) as CachedOutline;
		if (cached.size !== stat.size) return undefined;
		// Only compare mtimes when both sides have one to compare.
		if (cached.mtimeMs !== MTIME_UNKNOWN && stat.mtimeMs !== undefined && cached.mtimeMs !== stat.mtimeMs) {
			return undefined;
		}
		return cached;
	} catch {
		return undefined;
	}
}
