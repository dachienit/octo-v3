/**
 * Document outlines — the navigation surface that makes page addressing usable.
 *
 * Reading a 40-page PDF to reach one paragraph costs the same as reading all of
 * it, because extracted text has no table of contents the model can consult.
 * An outline is that table of contents: one row per addressable unit, carrying
 * only enough text to choose between rows. The body is fetched afterwards with
 * `read(pages=...)`, which is two orders of magnitude cheaper than the document.
 *
 * Outlines are also what the on-disk cache stores, so the shape here is
 * deliberately small and serializable: never document text, only locators,
 * sizes and one preview line each.
 */

import { formatSize } from "../tools/truncate.js";
import type { ExtractedDocument } from "./types.js";

/** Documents at or below this size are cheap enough to return whole. */
export const OUTLINE_THRESHOLD_BYTES = 6 * 1024;

/** Upper bound on outline rows, so a 400-page PDF does not become the new problem. */
const MAX_OUTLINE_ROWS = 120;

/** A single-segment document (docx) is cut into rows no smaller than this. */
const MIN_CHUNK_LINES = 50;

/** Previews exist to tell rows apart, not to convey content. */
const PREVIEW_CHARS = 120;

export interface OutlineRow {
	/**
	 * How to ask for this row: "page 3", "pages 4-6", "sheet Q3", or "lines 1-100"
	 * for documents without their own coordinates.
	 */
	label: string;
	/** 1-based line span within the document's extracted text. */
	startLine: number;
	endLine: number;
	bytes: number;
	/** First non-empty line, collapsed and clipped — usually the heading. */
	preview: string;
}

export interface DocumentOutline {
	kind: string;
	/** Page/sheet/slide count when the format has one. */
	unitCount?: number;
	/** Size of the full extracted text, i.e. what reading the body would cost. */
	extractedBytes: number;
	totalLines: number;
	/** True when rows address named units (`pages=`), false when they address lines. */
	addressable: boolean;
	rows: OutlineRow[];
}

/**
 * Lines that appear on most pages — running headers, footers, confidentiality
 * banners, copyright notices. Every page of a corporate deck starts with the
 * same one, so previewing it verbatim would make all rows identical and leave
 * the model no basis to choose a page, which is the entire job of an outline.
 */
function findBoilerplate(segments: Array<{ text: string }>): Set<string> {
	if (segments.length < 3) return new Set();

	const counts = new Map<string, number>();
	for (const segment of segments) {
		// A line repeated within one page still counts once for that page.
		const seen = new Set<string>();
		for (const line of segment.text.split("\n")) {
			const normalized = line.replace(/\s+/g, " ").trim();
			if (!normalized) continue;
			seen.add(normalized);
		}
		for (const line of seen) counts.set(line, (counts.get(line) ?? 0) + 1);
	}

	const threshold = Math.max(3, Math.ceil(segments.length * 0.4));
	const boilerplate = new Set<string>();
	for (const [line, count] of counts) {
		if (count >= threshold) boilerplate.add(line);
	}
	return boilerplate;
}

function preview(text: string, boilerplate: Set<string> = new Set()): string {
	let fallback: string | undefined;
	for (const line of text.split("\n")) {
		const collapsed = line.replace(/\s+/g, " ").trim();
		if (!collapsed) continue;
		// A bare page number is unique per page, so frequency cannot catch it, and
		// it says nothing about what the page contains.
		if (boilerplate.has(collapsed) || /^[\divxlc]{1,5}$/i.test(collapsed)) {
			// Keep the first one in reserve: a page that is nothing but boilerplate
			// should still say something rather than claim it has no text.
			fallback ??= collapsed;
			continue;
		}
		return collapsed.length > PREVIEW_CHARS ? `${collapsed.slice(0, PREVIEW_CHARS - 1)}…` : collapsed;
	}
	if (fallback) return fallback.length > PREVIEW_CHARS ? `${fallback.slice(0, PREVIEW_CHARS - 1)}…` : fallback;
	return "(no text)";
}

function countLines(text: string): number {
	return text.length === 0 ? 0 : text.split("\n").length;
}

/**
 * Turns "page 3" plus "page 6" into "pages 3-6" when consecutive segments have to
 * be grouped. Falls back to the plain locator when the shape is unexpected, so a
 * label is always something `pages=` can accept.
 */
function rangeLabel(first: string | undefined, last: string | undefined, fallback: string): string {
	if (!first) return fallback;
	if (!last || first === last) return first;
	const match = /^([a-z]+)\s+(.+)$/i.exec(first);
	const lastMatch = /^([a-z]+)\s+(.+)$/i.exec(last);
	if (!match || !lastMatch) return `${first}-${last}`;
	return `${match[1]}s ${match[2]}-${lastMatch[2]}`;
}

/**
 * Rows for a document whose segments carry their own coordinates (pdf, xlsx,
 * pptx). Consecutive segments are grouped when there are more of them than the
 * row budget, which keeps a 400-page PDF's outline addressable without making it
 * as expensive as the thing it is supposed to replace.
 */
function locatorRows(document: ExtractedDocument): OutlineRow[] {
	const segments = document.segments;
	const groupSize = Math.ceil(segments.length / MAX_OUTLINE_ROWS);
	const boilerplate = findBoilerplate(segments);
	const rows: OutlineRow[] = [];

	let line = 1;
	for (let index = 0; index < segments.length; index += groupSize) {
		const group = segments.slice(index, index + groupSize);
		const text = group.map((segment) => segment.text).join("\n");
		const lines = countLines(text);
		rows.push({
			label: rangeLabel(group[0].locator, group[group.length - 1].locator, `segment ${index + 1}`),
			startLine: line,
			endLine: line + Math.max(lines - 1, 0),
			bytes: Buffer.byteLength(text, "utf-8"),
			preview: preview(text, boilerplate),
		});
		line += lines;
	}
	return rows;
}

/**
 * Rows for a document with no coordinates of its own — Word, where mammoth
 * returns one blob. Line ranges are honest about what they are, and `offset`
 * and `limit` already address them.
 */
function lineRows(text: string): OutlineRow[] {
	const lines = text.split("\n");
	const chunk = Math.max(MIN_CHUNK_LINES, Math.ceil(lines.length / MAX_OUTLINE_ROWS));
	const rows: OutlineRow[] = [];

	for (let start = 0; start < lines.length; start += chunk) {
		const slice = lines.slice(start, start + chunk);
		const body = slice.join("\n");
		rows.push({
			label: `lines ${start + 1}-${start + slice.length}`,
			startLine: start + 1,
			endLine: start + slice.length,
			bytes: Buffer.byteLength(body, "utf-8"),
			preview: preview(body),
		});
	}
	return rows;
}

export function buildOutline(document: ExtractedDocument): DocumentOutline {
	const addressable = document.segments.some((segment) => segment.locator);
	const rows = addressable ? locatorRows(document) : lineRows(document.text);

	return {
		kind: document.kind,
		unitCount: document.unitCount,
		extractedBytes: Buffer.byteLength(document.text, "utf-8"),
		totalLines: countLines(document.text),
		addressable,
		rows,
	};
}

/** True when a document is large enough that its body should not be returned unasked. */
export function shouldOutline(document: ExtractedDocument): boolean {
	return Buffer.byteLength(document.text, "utf-8") > OUTLINE_THRESHOLD_BYTES;
}

function pad(value: string, width: number): string {
	return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/**
 * Renders an outline as the model sees it. `lineOffset` shifts the line labels of
 * a non-addressable document so they match what `read` actually returns, which
 * carries a header the extracted text itself does not have.
 */
export function renderOutline(fileName: string, outline: DocumentOutline, lineOffset = 0): string {
	const unit = outline.kind === "pdf" ? "page" : outline.kind === "pptx" ? "slide" : "sheet";
	const scope =
		outline.unitCount !== undefined && outline.kind !== "docx"
			? `, ${outline.unitCount} ${unit}${outline.unitCount === 1 ? "" : "s"}`
			: "";

	const header = `[Outline of ${fileName} (${outline.kind}${scope}, ${formatSize(outline.extractedBytes)} of text). The body is NOT shown.]`;

	const labelWidth = Math.min(24, Math.max(...outline.rows.map((row) => row.label.length), 8));
	const body = outline.rows.map((row) => {
		const label = outline.addressable
			? row.label
			: `lines ${row.startLine + lineOffset}-${row.endLine + lineOffset}`;
		return `${pad(label, labelWidth)}  ${pad(formatSize(row.bytes), 7)}  ${row.preview}`;
	});

	const footer = outline.addressable
		? `[Read only what you need: read(pages="${outline.rows[0]?.label.replace(/^[a-z]+s?\s+/i, "") ?? "1"}"). Ranges and lists work: pages="3-7", pages="2,9". Use pages="all" only if you truly need the whole document, and grep to locate a term first.]`
		: `[This format has no page coordinates. Use offset/limit to read a range, or grep to locate a term first.]`;

	return [header, "", ...body, "", footer].join("\n");
}
