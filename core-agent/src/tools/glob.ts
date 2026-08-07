import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { isExtractableDocument } from "../documents/extract.js";
import { getOutlineCacheDir, readOutline } from "../documents/outline-cache.js";
import type { Executor } from "../sandbox.js";
import type { GlobResult } from "../search/types.js";
import { createPathShortener } from "./paths.js";
import { DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const DEFAULT_LIMIT = 200;

const globSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're looking for (shown to user)" }),
	pattern: Type.String({
		description:
			'Glob pattern, e.g. "**/*.ts", "src/**/*.{ts,tsx}", "*.abap". Supports **, *, ?, {a,b} and [abc]. A pattern without a slash matches the file name at any depth.',
	}),
	path: Type.Optional(
		Type.String({ description: "Directory to search in (relative to the working directory, or absolute). Defaults to the working directory." }),
	),
	limit: Type.Optional(Type.Number({ description: `Maximum number of paths to return (default ${DEFAULT_LIMIT})` })),
});

interface GlobToolDetails {
	searchPath: string;
	matched: number;
	scanned: number;
	limitReached: boolean;
	truncation?: TruncationResult;
}

/**
 * Renders matches one per line with their size, shortening paths under the
 * working directory to a single leading header (see `createPathShortener`).
 *
 * Rows are never regrouped: the newest-first order is a documented property that
 * the system prompt relies on to say a fresh upload appears first.
 */
function render(result: GlobResult, hasExplicitPath: boolean): string {
	const entries = result.entries ?? result.files.map((file) => ({ path: file, size: 0, mtimeMs: 0 }));
	const shortener = createPathShortener(result.roots, hasExplicitPath);

	const rows = entries.map((entry) => {
		const display = shortener.display(entry.path);

		// Unit counts appear only when they are already known. Extracting a document
		// during a glob would defeat the point of a cheap listing, and the cache is
		// only consulted for formats that could have an entry at all.
		const outline = isExtractableDocument(entry.path)
			? readOutline(getOutlineCacheDir(), entry.path, { size: entry.size })
			: undefined;
		const units =
			outline?.unitCount !== undefined && outline.unitCount > 0
				? `\t${outline.unitCount} ${outline.kind === "pdf" ? "page" : outline.kind === "pptx" ? "slide" : "sheet"}${outline.unitCount === 1 ? "" : "s"}`
				: "";

		return `${display}\t${formatSize(entry.size)}${units}`;
	});

	const header = shortener.header();
	return header ? `${header}\n${rows.join("\n")}` : rows.join("\n");
}

export function createGlobTool(executor: Executor): AgentTool<typeof globSchema> {
	return {
		name: "glob",
		label: "glob",
		description:
			"Find files by glob pattern. Returns matching paths with their size, sorted by modification time, newest first; documents also show their page, sheet or slide count when it is already known. Paths under the working directory are shown relative to it. Works identically on the host and inside the sandbox, and skips .git, node_modules and build output directories. Prefer this over running find or dir through bash.",
		parameters: globSchema,
		execute: async (
			_toolCallId: string,
			{ pattern, path, limit }: { label: string; pattern: string; path?: string; limit?: number },
			signal?: AbortSignal,
		) => {
			const effectiveLimit = limit && limit > 0 ? limit : DEFAULT_LIMIT;
			const result = await executor.glob({ pattern, path, limit: effectiveLimit, signal });

			if (result.files.length === 0) {
				return {
					content: [{ type: "text", text: `No files matching ${pattern} under ${result.searchPath} (${result.scanned} files scanned)` }],
					details: {
						searchPath: result.searchPath,
						matched: 0,
						scanned: result.scanned,
						limitReached: false,
					} satisfies GlobToolDetails,
				};
			}

			const truncation = truncateHead(render(result, path !== undefined), { maxLines: DEFAULT_MAX_LINES });
			let text = truncation.content;

			if (result.limitReached) {
				text += `\n\n[Showing the ${result.files.length} most recently modified matches; more exist. Narrow the pattern or raise limit.]`;
			}
			if (truncation.truncated) {
				text += `\n\n[Output truncated at ${truncation.outputLines} of ${truncation.totalLines} paths.]`;
			}

			return {
				content: [{ type: "text", text }],
				details: {
					searchPath: result.searchPath,
					matched: result.files.length,
					scanned: result.scanned,
					limitReached: result.limitReached,
					truncation: truncation.truncated ? truncation : undefined,
				} satisfies GlobToolDetails,
			};
		},
	};
}
