/**
 * The document half of `grep`.
 *
 * Text files are searched by the engine inside the execution environment; binary
 * documents cannot be, so the engine hands back the documents it saw during that
 * same walk — already filtered by path, glob and the exclude list — and they are
 * extracted and matched here. Reusing the engine's walk keeps a grep over a tree
 * with no documents exactly as cheap as it was before.
 */

import { buildSearchRegExp } from "../search/regexp.js";
import type { GlobEntry } from "../search/types.js";
import type { Executor } from "../sandbox.js";
import { extractDocumentText } from "./extract.js";
import { describeEmptyReason, type EmptyReason } from "./types.js";

/** Cap on documents opened per search: extraction is far costlier than a grep. */
export const MAX_DOCUMENTS = 40;

export interface DocumentMatch {
	path: string;
	/** "page 3", "sheet Q3", "slide 5"; absent for formats without segments. */
	locator?: string;
	/** 1-based line number within the segment. */
	line: number;
	text: string;
	context?: boolean;
}

export interface DocumentSkip {
	path: string;
	reason: EmptyReason;
	description: string;
}

export interface DocumentSearchResult {
	matches: DocumentMatch[];
	/** Paths that contained at least one match. */
	matchedPaths: string[];
	/**
	 * Every locator that contained a match, per path, unaffected by `maxCount`.
	 * This is what lets a files-only search still say "pages 3, 27" — the whole
	 * point of the cheap rung, since it is what the model needs to call
	 * `read(pages=...)` next.
	 */
	matchedLocators: Map<string, string[]>;
	scanned: number;
	skipped: DocumentSkip[];
	/** True when the candidate set was cut short before extraction. */
	limitReached: boolean;
	/** Documents whose emitted matches were cut short by `maxCount`. */
	cappedDocuments: number;
}

export interface DocumentSearchOptions {
	pattern: string;
	ignoreCase?: boolean;
	multiline?: boolean;
	before?: number;
	after?: number;
	/** Cap on matching lines emitted per document, mirroring grep's `-m`. */
	maxCount?: number;
	signal?: AbortSignal;
}

export async function searchDocumentCandidates(
	executor: Executor,
	candidates: GlobEntry[],
	options: DocumentSearchOptions,
	candidatesTruncated = false,
): Promise<DocumentSearchResult> {
	const selected = candidates.slice(0, MAX_DOCUMENTS);
	const test = buildSearchRegExp(options.pattern, {
		ignoreCase: options.ignoreCase,
		multiline: options.multiline,
	});

	const matches: DocumentMatch[] = [];
	const matchedPaths: string[] = [];
	const matchedLocators = new Map<string, string[]>();
	const skipped: DocumentSkip[] = [];
	const maxCount = options.maxCount && options.maxCount > 0 ? options.maxCount : 0;
	let cappedDocuments = 0;

	for (const entry of selected) {
		if (options.signal?.aborted) break;

		const document = await extractDocumentText(executor, entry.path, entry);
		if (document.emptyReason) {
			skipped.push({
				path: entry.path,
				reason: document.emptyReason,
				description: describeEmptyReason(document.emptyReason, document.kind),
			});
			continue;
		}

		let matchedHere = false;
		// Counted across the whole document, not per segment: a term appearing on
		// every page of a 200-page PDF is one document's worth of noise.
		let emitted = 0;
		let capped = false;

		for (const segment of document.segments) {
			const hits = matchSegment(segment.text, test, options);
			const real = hits.filter((hit) => !hit.context);
			if (real.length > 0) {
				matchedHere = true;
				if (segment.locator) {
					const locators = matchedLocators.get(entry.path) ?? [];
					if (!locators.includes(segment.locator)) locators.push(segment.locator);
					matchedLocators.set(entry.path, locators);
				}
			}

			for (const hit of hits) {
				if (maxCount > 0 && emitted >= maxCount) {
					// Keep scanning the remaining segments: the locator list must stay
					// complete even once the emitted lines have been capped.
					capped = true;
					break;
				}
				matches.push({ path: entry.path, locator: segment.locator, ...hit });
				if (!hit.context) emitted++;
			}
		}

		if (capped) cappedDocuments++;
		if (matchedHere) matchedPaths.push(entry.path);
	}

	return {
		matches,
		matchedPaths,
		matchedLocators,
		scanned: selected.length,
		skipped,
		limitReached: candidatesTruncated || candidates.length > MAX_DOCUMENTS,
		cappedDocuments,
	};
}

function matchSegment(
	text: string,
	test: RegExp,
	options: DocumentSearchOptions,
): Array<{ line: number; text: string; context?: boolean }> {
	const lines = text.split("\n");
	const before = options.before && options.before > 0 ? options.before : 0;
	const after = options.after && options.after > 0 ? options.after : 0;

	const wanted = new Map<number, "match" | "context">();
	for (const [index, line] of lines.entries()) {
		test.lastIndex = 0;
		if (!test.test(line)) continue;
		wanted.set(index, "match");
		for (let i = Math.max(0, index - before); i < index; i++) {
			if (!wanted.has(i)) wanted.set(i, "context");
		}
		for (let i = index + 1; i <= Math.min(lines.length - 1, index + after); i++) {
			if (!wanted.has(i)) wanted.set(i, "context");
		}
	}

	return [...wanted.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([index, kind]) => ({
			line: index + 1,
			text: lines[index],
			...(kind === "context" ? { context: true as const } : {}),
		}));
}
