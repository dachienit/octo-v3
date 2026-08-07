/**
 * Text extraction for binary documents (PDF, Word, Excel, PowerPoint).
 *
 * Why this lives in the host process and not in the search engine: the engine is
 * a self-contained CommonJS program materialized into `/tmp` and run as a bare
 * `node` process, with no `node_modules` on its resolution path — inside a
 * container there is nothing to `require` and never will be. Extraction
 * therefore runs here, pulling bytes across the executor boundary with
 * `readFile`, which is already base64-safe in every sandbox mode.
 */

export type DocumentKind = "pdf" | "docx" | "xlsx" | "pptx";

/** Why a document yielded no searchable text. */
export type EmptyReason =
	/** Parsed fine but carries no text layer — typically a scanned image. */
	| "no-text-layer"
	| "encrypted"
	| "too-large"
	| "parse-failed";

export interface DocumentSegment {
	/** "page 3" (pdf), "sheet Q3" (xlsx), "slide 5" (pptx); absent for docx. */
	locator?: string;
	text: string;
}

export interface ExtractedDocument {
	kind: DocumentKind;
	/** All segments joined by newlines; empty when nothing could be extracted. */
	text: string;
	segments: DocumentSegment[];
	/** Set when there is no usable text; `text` is empty in that case. */
	emptyReason?: EmptyReason;
	/** Page count for PDFs, sheet count for xlsx, slide count for pptx. */
	unitCount?: number;
}

/**
 * Human-readable explanation used in tool output. `kind` matters for
 * "no-text-layer": OCR is the right advice for a scanned PDF and nonsense for a
 * spreadsheet holding only a chart, and telling a user their workbook needs OCR
 * is worse than saying nothing.
 */
export function describeEmptyReason(reason: EmptyReason, kind?: DocumentKind): string {
	switch (reason) {
		case "no-text-layer":
			if (kind === "xlsx") return "no cell text — the workbook may hold only charts, images or formatting";
			if (kind === "pptx") return "no text on any slide — the deck may be made of images";
			if (kind === "docx") return "no readable text — the document may hold only images";
			return "no text layer — likely a scanned image, which would need OCR";
		case "encrypted":
			return "encrypted or password-protected";
		case "too-large":
			return "larger than the extraction size limit";
		case "parse-failed":
			return "could not be parsed";
	}
}
