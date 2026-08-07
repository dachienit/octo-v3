/**
 * Segment addressing for `read(pages=...)`.
 *
 * Locators produced by extraction are "page 3", "sheet Q3", "slide 5" — a kind
 * word plus a name that is usually, but not always, a number. A selector is
 * therefore matched two ways: numerically against the trailing number (and, for
 * formats without one, against the segment's ordinal), and by name against the
 * part after the kind word, case-insensitively, so a user's sheet called "Q3"
 * can be asked for as `pages="Q3"`.
 */

import type { DocumentSegment, ExtractedDocument } from "./types.js";

export interface SegmentSelection {
	segments: DocumentSegment[];
	/** Selector tokens that matched nothing, so the caller can say so plainly. */
	unmatched: string[];
	/** True when the selector asked for the whole document. */
	all: boolean;
}

interface ParsedSelector {
	all: boolean;
	numbers: Set<number>;
	ranges: Array<{ from: number; to: number; token: string }>;
	names: string[];
	tokens: string[];
}

function parseSelector(spec: string): ParsedSelector {
	const parsed: ParsedSelector = { all: false, numbers: new Set(), ranges: [], names: [], tokens: [] };

	for (const raw of spec.split(",")) {
		const token = raw.trim();
		if (!token) continue;
		parsed.tokens.push(token);

		if (token.toLowerCase() === "all" || token === "*") {
			parsed.all = true;
			continue;
		}

		const range = /^(\d+)\s*-\s*(\d+)$/.exec(token);
		if (range) {
			const from = Number(range[1]);
			const to = Number(range[2]);
			parsed.ranges.push({ from: Math.min(from, to), to: Math.max(from, to), token });
			continue;
		}

		if (/^\d+$/.test(token)) {
			parsed.numbers.add(Number(token));
			continue;
		}

		parsed.names.push(token.toLowerCase());
	}

	return parsed;
}

/** "page 3" -> 3, "sheet Q3" -> undefined. The ordinal is the fallback. */
function locatorNumber(locator: string | undefined): number | undefined {
	if (!locator) return undefined;
	const match = /(\d+)\s*$/.exec(locator);
	return match ? Number(match[1]) : undefined;
}

/** "sheet Q3" -> "q3". Used for name matching. */
function locatorName(locator: string | undefined): string | undefined {
	if (!locator) return undefined;
	const match = /^[a-z]+\s+(.+)$/i.exec(locator);
	return (match ? match[1] : locator).toLowerCase();
}

/**
 * Picks the segments a selector asks for, in document order. Unmatched tokens are
 * reported rather than silently dropped: asking for page 99 of a 40-page PDF is a
 * mistake worth telling the model about, not an empty result to puzzle over.
 */
export function selectSegments(document: ExtractedDocument, spec: string): SegmentSelection {
	const parsed = parseSelector(spec);
	if (parsed.all) return { segments: document.segments, unmatched: [], all: true };

	const picked = new Set<number>();
	const used = new Set<string>();

	document.segments.forEach((segment, index) => {
		const ordinal = index + 1;
		const number = locatorNumber(segment.locator) ?? ordinal;
		const name = locatorName(segment.locator);

		if (parsed.numbers.has(number)) {
			picked.add(index);
			used.add(String(number));
		}
		for (const range of parsed.ranges) {
			if (number >= range.from && number <= range.to) {
				picked.add(index);
				used.add(range.token);
			}
		}
		if (name) {
			for (const candidate of parsed.names) {
				if (name === candidate || segment.locator?.toLowerCase() === candidate) {
					picked.add(index);
					used.add(candidate);
				}
			}
		}
	});

	const unmatched = parsed.tokens.filter((token) => {
		const normalized = /^\d+$/.test(token) ? token : token.toLowerCase();
		return !used.has(normalized) && !used.has(token);
	});

	return {
		segments: [...picked].sort((a, b) => a - b).map((index) => document.segments[index]),
		unmatched,
		all: false,
	};
}
