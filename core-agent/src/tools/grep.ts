import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { DOCUMENT_EXTENSIONS } from "../documents/extract.js";
import { type DocumentSearchResult, searchDocumentCandidates } from "../documents/search.js";
import type { Executor } from "../sandbox.js";
import type { GrepOutputMode } from "../search/types.js";
import { createPathShortener, type PathShortener } from "./paths.js";
import { type TruncationResult, truncateHead } from "./truncate.js";

const DEFAULT_HEAD_LIMIT = 250;

/**
 * Per-file cap applied when the model searches the whole workspace without
 * narrowing. A broad grep is a discovery step — knowing which twelve files
 * mention a term is worth far more than seeing 250 hits from the first one —
 * and it is where the head limit used to be spent almost entirely on one file.
 */
const BROAD_MAX_COUNT = 3;

/** Locators listed per document before collapsing into "+N more". */
const MAX_LOCATORS_LISTED = 8;

const grepSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're searching for (shown to user)" }),
	pattern: Type.String({ description: "Regular expression (JavaScript flavor), e.g. \"createTool\\\\w+\" or \"class \\\\w+Executor\"" }),
	path: Type.Optional(
		Type.String({ description: "File or directory to search in (relative to the working directory, or absolute). Defaults to the working directory." }),
	),
	glob: Type.Optional(
		Type.String({ description: 'Restrict the search to files matching this glob, e.g. "*.ts" or "src/**/*.abap"' }),
	),
	output_mode: Type.Optional(
		Type.Union([Type.Literal("content"), Type.Literal("files_with_matches"), Type.Literal("count")], {
			description: '"content" shows matching lines (default), "files_with_matches" shows only paths, "count" shows per-file match counts',
		}),
	),
	ignore_case: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
	line_numbers: Type.Optional(Type.Boolean({ description: "Prefix each line with its line number (content mode, default true)" })),
	before: Type.Optional(Type.Number({ description: "Context lines before each match (content mode)" })),
	after: Type.Optional(Type.Number({ description: "Context lines after each match (content mode)" })),
	multiline: Type.Optional(Type.Boolean({ description: "Let the pattern span lines and make . match newlines" })),
	only_matching: Type.Optional(Type.Boolean({ description: "Output only the matched part of each line instead of the whole line" })),
	head_limit: Type.Optional(Type.Number({ description: `Maximum entries to return (default ${DEFAULT_HEAD_LIMIT}, 0 for unlimited)` })),
	max_count: Type.Optional(
		Type.Number({
			description: `Maximum matching lines to show per file, like grep -m. Totals stay accurate. Defaults to ${BROAD_MAX_COUNT} on a broad search (no path and no glob) so one verbose file cannot crowd out the others; unlimited once you narrow with path or glob. Pass 0 for unlimited.`,
		}),
	),
	offset: Type.Optional(Type.Number({ description: "Skip this many entries before applying head_limit" })),
	documents: Type.Optional(
		Type.Boolean({
			description:
				"Also search inside pdf, docx, xlsx and pptx files by extracting their text (default true). Set false to search text files only, which is faster.",
		}),
	),
});

interface GrepParams {
	label: string;
	pattern: string;
	path?: string;
	glob?: string;
	output_mode?: GrepOutputMode;
	ignore_case?: boolean;
	line_numbers?: boolean;
	before?: number;
	after?: number;
	multiline?: boolean;
	only_matching?: boolean;
	head_limit?: number;
	max_count?: number;
	offset?: number;
	documents?: boolean;
}

interface GrepToolDetails {
	outputMode: GrepOutputMode;
	searchPath: string;
	totalMatches: number;
	matchedFiles: number;
	scanned: number;
	limitReached: boolean;
	truncation?: TruncationResult;
	documentsScanned?: number;
	documentsMatched?: number;
	documentsSkipped?: Array<{ path: string; reason: string }>;
}

export function createGrepTool(executor: Executor): AgentTool<typeof grepSchema> {
	return {
		name: "grep",
		label: "grep",
		description:
			"Search file contents with a regular expression. Returns matching lines with file path and line number, and supports context lines, per-file counts, and a files-only mode. Also searches inside pdf, docx, xlsx and pptx files by extracting their text, reporting hits with page, sheet or slide. Uses JavaScript regular expressions and runs identically on the host and inside the sandbox. Prefer this over running grep, findstr or Select-String through bash.",
		parameters: grepSchema,
		execute: async (_toolCallId: string, params: GrepParams, signal?: AbortSignal) => {
			const outputMode: GrepOutputMode = params.output_mode ?? "content";
			const showLineNumbers = params.line_numbers !== false;
			const searchDocuments = params.documents !== false;

			// A search the model has already narrowed is a deliberate deep read, so
			// the cap only defends the broad case it did not narrow.
			const isBroad = !params.path && !params.glob;
			const maxCount =
				params.max_count !== undefined
					? params.max_count
					: outputMode === "content" && isBroad
						? BROAD_MAX_COUNT
						: 0;

			const result = await executor.grep({
				pattern: params.pattern,
				path: params.path,
				glob: params.glob,
				outputMode,
				ignoreCase: params.ignore_case,
				before: params.before,
				after: params.after,
				multiline: params.multiline,
				onlyMatching: params.only_matching,
				headLimit: params.head_limit,
				maxCount,
				offset: params.offset,
				// The engine sets these aside during its walk instead of trying to
				// search them as text, so no second traversal is needed.
				documentExtensions: searchDocuments ? DOCUMENT_EXTENSIONS : undefined,
				signal,
			});

			// Binary documents cannot be searched inside the sandbox: their text is
			// extracted here, in the host process.
			const documentSearch = searchDocuments
				? await searchDocumentCandidates(
						executor,
						result.documentCandidates ?? [],
						{
							pattern: params.pattern,
							ignoreCase: params.ignore_case,
							multiline: params.multiline,
							before: params.before,
							after: params.after,
							maxCount,
							signal,
						},
						result.documentCandidatesTruncated,
					)
				: undefined;

			// One shortener across both sections, so a single header can describe every
			// relative row and the two sections cannot disagree about a path.
			const shortener = createPathShortener(result.roots, params.path !== undefined);

			const documentSection = documentSearch ? renderDocuments(documentSearch, outputMode, showLineNumbers, shortener) : "";
			const documentDetails = documentSearch
				? {
						documentsScanned: documentSearch.scanned,
						documentsMatched: documentSearch.matchedPaths.length,
						documentsSkipped: documentSearch.skipped.map((skip) => ({ path: skip.path, reason: skip.description })),
					}
				: {};

			const baseDetails = {
				outputMode,
				searchPath: result.searchPath,
				totalMatches: result.totalMatches,
				matchedFiles: result.matchedFiles,
				scanned: result.scanned,
				limitReached: result.limitReached,
				...documentDetails,
			};

			if (result.totalMatches === 0 && !documentSection) {
				const scope = params.glob ? ` matching ${params.glob}` : "";
				const documentNote = documentSearch ? documentFooter(documentSearch) : "";
				return {
					content: [
						{
							type: "text",
							text:
								`No matches for /${params.pattern}/ under ${result.searchPath}${scope} (${result.scanned} files scanned)` +
								(documentNote ? `\n${documentNote}` : ""),
						},
					],
					details: baseDetails satisfies GrepToolDetails,
				};
			}

			const sections = [renderResult(result, outputMode, showLineNumbers, shortener), documentSection].filter(Boolean);
			// The header can only be asked for once both sections have been rendered:
			// it reports what was actually shortened, not what could have been.
			const header = shortener.header();
			const body = (header ? [header, ...sections] : sections).join("\n\n");
			const truncation = truncateHead(body);
			let text = truncation.content;

			// Says "text file" explicitly because documents are counted separately in
			// their own footer.
			const scope = documentSearch ? "text file" : "file";
			const summary =
				outputMode === "content"
					? `${result.totalMatches} matching line(s) in ${result.matchedFiles} ${scope}(s)`
					: outputMode === "files_with_matches"
						? `${result.matchedFiles} ${scope}(s) with matches`
						: `${result.matchedFiles} ${scope}(s), ${result.totalMatches} match(es)`;
			text += `\n\n[${summary}]`;

			const cappedFiles = (result.cappedFiles ?? 0) + (documentSearch?.cappedDocuments ?? 0);
			if (maxCount > 0 && cappedFiles > 0) {
				text += `\n[Showing at most ${maxCount} match(es) per file; ${cappedFiles} file(s) had more. The counts above are complete. Narrow with path or glob, or raise max_count, to see the rest of one file.]`;
			}
			if (result.limitReached) {
				text += `\n[Result set was cut at the head_limit; raise head_limit or use offset to page through the rest.]`;
			}
			if (truncation.truncated) {
				text += `\n[Output truncated at ${truncation.outputLines} of ${truncation.totalLines} lines.]`;
			}
			if (documentSearch) {
				const footer = documentFooter(documentSearch);
				if (footer) text += `\n${footer}`;
			}

			return {
				content: [{ type: "text", text }],
				details: {
					...baseDetails,
					truncation: truncation.truncated ? truncation : undefined,
				} satisfies GrepToolDetails,
			};
		},
	};
}

/**
 * Document hits are rendered in their own section, grouped by file, with the
 * document's own coordinates so the model can cite "page 3" rather than a line
 * number that only exists in extracted text.
 */
function renderDocuments(
	search: DocumentSearchResult,
	outputMode: GrepOutputMode,
	showLineNumbers: boolean,
	shortener: PathShortener,
): string {
	if (search.matchedPaths.length === 0) return "";

	if (outputMode === "files_with_matches") {
		// Naming the pages turns a file list into something directly actionable:
		// the next call is read(pages="3,27") rather than reading the document.
		const rows = search.matchedPaths.map((path) => {
			const display = shortener.display(path);
			const locators = search.matchedLocators.get(path) ?? [];
			if (locators.length === 0) return display;
			const shown = locators.slice(0, MAX_LOCATORS_LISTED).join(", ");
			const more = locators.length > MAX_LOCATORS_LISTED ? `, +${locators.length - MAX_LOCATORS_LISTED} more` : "";
			return `${display} (${shown}${more})`;
		});
		return ["Documents (extracted text):", ...rows].join("\n");
	}

	if (outputMode === "count") {
		const counts = new Map<string, number>();
		for (const match of search.matches) {
			if (match.context) continue;
			counts.set(match.path, (counts.get(match.path) ?? 0) + 1);
		}
		return [
			"Documents (extracted text):",
			...[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([path, count]) => `${count}\t${shortener.display(path)}`),
		].join("\n");
	}

	const lines: string[] = ["Documents (extracted text):"];
	let currentPath: string | undefined;
	let currentLocator: string | undefined;
	for (const match of search.matches) {
		if (match.path !== currentPath) {
			lines.push(shortener.display(match.path));
			currentPath = match.path;
			currentLocator = undefined;
		}
		const separator = match.context ? "-" : ":";
		const prefix = showLineNumbers ? `${match.line}${separator}` : "";
		if (match.locator && match.locator !== currentLocator) {
			currentLocator = match.locator;
			lines.push(`  ${match.locator}`);
		}
		lines.push(`    ${prefix}${match.text}`);
	}
	return lines.join("\n");
}

/** One-line account of what happened in the document pass, including skips. */
function documentFooter(search: DocumentSearchResult): string {
	if (search.scanned === 0 && search.skipped.length === 0) return "";

	const parts = [`${search.matchedPaths.length} document(s) matched of ${search.scanned} scanned`];
	if (search.limitReached) parts.push("document candidate list was capped");
	let footer = `[${parts.join("; ")}]`;

	if (search.skipped.length > 0) {
		const detail = search.skipped
			.slice(0, 10)
			.map((skip) => `${skip.path} (${skip.description})`)
			.join("; ");
		const more = search.skipped.length > 10 ? ` and ${search.skipped.length - 10} more` : "";
		footer += `\n[Skipped ${search.skipped.length} document(s): ${detail}${more}]`;
	}
	return footer;
}

function renderResult(
	result: Awaited<ReturnType<Executor["grep"]>>,
	outputMode: GrepOutputMode,
	showLineNumbers: boolean,
	shortener: PathShortener,
): string {
	if (outputMode === "files_with_matches") return result.files.map((file) => shortener.display(file)).join("\n");
	if (outputMode === "count") {
		return result.counts.map((entry) => `${entry.count}\t${shortener.display(entry.path)}`).join("\n");
	}

	// Content mode: group by file so the output stays readable, and mark context
	// lines with "-" instead of ":" the way grep does.
	const out: string[] = [];
	let currentPath: string | undefined;
	for (const line of result.lines) {
		if (line.path !== currentPath) {
			if (currentPath !== undefined) out.push("");
			out.push(shortener.display(line.path));
			currentPath = line.path;
		}
		const separator = line.context ? "-" : ":";
		out.push(showLineNumbers ? `${line.line}${separator}${line.text}` : line.text);
	}
	return out.join("\n");
}
