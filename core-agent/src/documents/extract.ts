/**
 * Entry point for document text extraction: dispatch by extension, read bytes
 * through the executor, and cache by file identity.
 */

import { extname } from "node:path";
import type { Executor } from "../sandbox.js";
import { extractOoxml } from "./ooxml.js";
import { buildOutline } from "./outline.js";
import { writeOutline } from "./outline-cache.js";
import { extractPdf } from "./pdf.js";
import type { DocumentKind, ExtractedDocument } from "./types.js";

/** Bytes cross the executor boundary base64-encoded, so keep documents modest. */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
/** Extracted text is retained for this many documents, keyed by file identity. */
const CACHE_ENTRIES = 50;

const EXTENSIONS: Record<string, DocumentKind> = {
	".pdf": "pdf",
	".docx": "docx",
	".xlsx": "xlsx",
	".xlsm": "xlsx",
	".pptx": "pptx",
};

/** Returns the document kind for a path, or null when it is not extractable. */
export function isExtractableDocument(path: string): DocumentKind | null {
	return EXTENSIONS[extname(path).toLowerCase()] ?? null;
}

/** Every extractable extension, with the leading dot. */
export const DOCUMENT_EXTENSIONS = Object.keys(EXTENSIONS);

export interface DocumentStat {
	size: number;
	mtimeMs: number;
}

/**
 * Cache keyed by path plus size plus mtime, so an edited file is re-extracted
 * without any explicit invalidation. Worth having because a 30-page PDF takes
 * seconds and the agent commonly greps several times within one task.
 */
const cache = new Map<string, ExtractedDocument>();

function cacheKey(path: string, stat: DocumentStat): string {
	return `${path}|${stat.size}|${stat.mtimeMs}`;
}

function remember(key: string, value: ExtractedDocument): ExtractedDocument {
	cache.set(key, value);
	while (cache.size > CACHE_ENTRIES) {
		const oldest = cache.keys().next();
		if (oldest.done) break;
		cache.delete(oldest.value);
	}
	return value;
}

/** Clears the extraction cache. Exposed for tests. */
export function clearDocumentCache(): void {
	cache.clear();
}

/**
 * Extracts text from bytes already in hand. Never throws: a document that cannot
 * be parsed is reported through `emptyReason` so one bad file does not fail a
 * whole search. Not cached — callers holding a buffer already paid the read.
 */
export async function extractDocumentBuffer(buffer: Buffer, kind: DocumentKind): Promise<ExtractedDocument> {
	if (buffer.byteLength > MAX_DOCUMENT_BYTES) {
		return { kind, text: "", segments: [], emptyReason: "too-large" };
	}
	try {
		if (kind === "pdf") return await extractPdf(buffer);
		if (kind === "docx") return await extractDocx(buffer);
		return await extractOoxml(buffer, kind);
	} catch {
		return { kind, text: "", segments: [], emptyReason: "parse-failed" };
	}
}

/**
 * Reads a document through the executor and extracts its text, caching the
 * result against the file's identity. Use this when only the path is known.
 */
export async function extractDocumentText(
	executor: Executor,
	path: string,
	stat: DocumentStat,
): Promise<ExtractedDocument> {
	const kind = isExtractableDocument(path);
	if (!kind) return { kind: "pdf", text: "", segments: [], emptyReason: "parse-failed" };

	const key = cacheKey(path, stat);
	const cached = cache.get(key);
	if (cached) return cached;

	// Checked before reading so an oversize file never crosses the boundary.
	if (stat.size > MAX_DOCUMENT_BYTES) {
		return remember(key, { kind, text: "", segments: [], emptyReason: "too-large" });
	}

	let buffer: Buffer;
	try {
		buffer = await executor.readFile(path);
	} catch {
		return remember(key, { kind, text: "", segments: [], emptyReason: "parse-failed" });
	}

	const document = await extractDocumentBuffer(buffer, kind);
	// A real extraction just happened and the caller supplied a trustworthy stat,
	// so this is the best moment to refresh the outline sidecar.
	if (!document.emptyReason) {
		writeOutline(path, buildOutline(document), { size: stat.size, mtimeMs: stat.mtimeMs });
	}
	return remember(key, document);
}

/**
 * mammoth understands Word structure, so it is tried first. It does not reach
 * text boxes, headers or footers, so the generic OOXML reader is the fallback.
 */
async function extractDocx(buffer: Buffer): Promise<ExtractedDocument> {
	try {
		const mammoth = (await import("mammoth")).default;
		const result = await mammoth.extractRawText({ buffer });
		const text = result.value.trim();
		if (text) return { kind: "docx", text, segments: [{ text }] };
	} catch {
		// Fall through to the OOXML reader below.
	}
	return extractOoxml(buffer, "docx");
}
