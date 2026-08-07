/**
 * Shared types for the portable filesystem search engine.
 *
 * The engine itself lives in `engine-source.ts` as a self-contained CommonJS
 * program so that the exact same implementation can run on a Windows host, a
 * POSIX host, and inside a docker/podman sandbox. These types describe the
 * JSON job/result contract between `runner.ts` and that program.
 */

export type GrepOutputMode = "content" | "files_with_matches" | "count";

export interface GlobOptions {
	/** Glob pattern, e.g. "**\/*.ts" or "src/**\/*.{ts,tsx}" */
	pattern: string;
	/** Directory to search in. Relative paths resolve against the executor cwd. */
	path?: string;
	/** Maximum number of paths to return. */
	limit?: number;
	/** Additional directory names to skip on top of the defaults. */
	exclude?: string[];
	signal?: AbortSignal;
}

/** A file with the identity needed to cache work derived from its contents. */
export interface GlobEntry {
	path: string;
	size: number;
	mtimeMs: number;
}

export interface GlobResult {
	/** Matching paths, newest first (sorted by mtime descending). */
	files: string[];
	/** The same matches with the size and mtime the walk already had to stat. */
	entries: GlobEntry[];
	/** Directory the search was rooted at, as seen by the executor. */
	searchPath: string;
	/** Roots actually walked; `roots[0]` is the cwd unless an explicit path was given. */
	roots: string[];
	/** True when `limit` cut the result set short. */
	limitReached: boolean;
	/** Number of files scanned before filtering. */
	scanned: number;
}

export interface GrepOptions {
	/** Regular expression, JavaScript flavor. */
	pattern: string;
	/** File or directory to search in. Relative paths resolve against the executor cwd. */
	path?: string;
	/** Restrict the file set with a glob, e.g. "*.ts". */
	glob?: string;
	outputMode?: GrepOutputMode;
	ignoreCase?: boolean;
	/** Context lines after each match (content mode only). */
	after?: number;
	/** Context lines before each match (content mode only). */
	before?: number;
	/** Let `.` match newlines and allow patterns to span lines. */
	multiline?: boolean;
	/** Print only the matched part of each line. */
	onlyMatching?: boolean;
	/** Cap on returned entries (lines, paths, or counts depending on mode). */
	headLimit?: number;
	/**
	 * Cap on matching lines *emitted* per file, like `grep -m`. Counts and totals
	 * stay complete, so one verbose file cannot consume the whole head limit and
	 * hide every other file that matched.
	 */
	maxCount?: number;
	/** Skip this many entries before applying `headLimit`. */
	offset?: number;
	/** Additional directory names to skip on top of the defaults. */
	exclude?: string[];
	/**
	 * Extensions (with the dot) whose files are binary documents. They are kept
	 * out of the text search and returned as `documentCandidates` instead, so the
	 * caller can extract their text without walking the tree a second time.
	 */
	documentExtensions?: string[];
	signal?: AbortSignal;
}

export interface GrepMatchLine {
	path: string;
	line: number;
	text: string;
	/** True for context lines emitted by `before`/`after`. */
	context?: boolean;
}

export interface GrepResult {
	outputMode: GrepOutputMode;
	/** Populated when outputMode is "content". */
	lines: GrepMatchLine[];
	/** Populated when outputMode is "files_with_matches". */
	files: string[];
	/** Populated when outputMode is "count". */
	counts: Array<{ path: string; count: number }>;
	/** Directory or file the search was rooted at. */
	searchPath: string;
	/** Roots actually walked; `roots[0]` is the cwd unless an explicit path was given. */
	roots: string[];
	/** Files whose emitted matches were cut short by `maxCount`. */
	cappedFiles: number;
	/** Total matching lines across all files, before headLimit/offset. */
	totalMatches: number;
	/** Number of files that contained at least one match. */
	matchedFiles: number;
	/** Number of files opened and scanned. */
	scanned: number;
	/** True when headLimit cut the result set short. */
	limitReached: boolean;
	/**
	 * Binary documents seen during the same walk, already filtered by `path`,
	 * `glob` and the exclude list. Present only when `documentExtensions` was set.
	 */
	documentCandidates?: GlobEntry[];
	/** True when the candidate list was capped by the engine. */
	documentCandidatesTruncated?: boolean;
}

/**
 * Discriminated job passed to the engine as base64 JSON.
 *
 * `extraRoots` widens a search beyond `cwd` — the executor declares them, not
 * the model. They are ignored when the caller passes an explicit `path`, and
 * silently dropped when they do not exist.
 */
export type SearchJob =
	| ({ kind: "glob"; cwd: string; extraRoots?: string[] } & Omit<GlobOptions, "signal">)
	| ({ kind: "grep"; cwd: string; extraRoots?: string[] } & Omit<GrepOptions, "signal">);

/** Envelope the engine prints on stdout. */
export type SearchEnvelope =
	| { ok: true; kind: "glob"; result: GlobResult }
	| { ok: true; kind: "grep"; result: GrepResult }
	| { ok: false; error: string };
