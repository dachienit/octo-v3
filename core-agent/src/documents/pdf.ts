/**
 * PDF text extraction via pdfjs.
 *
 * Uses the `legacy/build` entry point, which is the Node-capable one; the default
 * `build/pdf.mjs` export is the browser bundle and pulls in worker/DOM plumbing.
 * The import is dynamic so neither pdfjs nor its font data loads unless a PDF is
 * actually opened, and so it never enters the `@octo/core-agent/web` graph.
 */

import type { DocumentSegment, ExtractedDocument } from "./types.js";

/** Beyond this a PDF is almost certainly not what the agent should be grepping. */
const MAX_PDF_PAGES = 200;

type PdfModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let pdfModule: Promise<PdfModule> | undefined;

function loadPdfjs(): Promise<PdfModule> {
	pdfModule ??= import("pdfjs-dist/legacy/build/pdf.mjs");
	return pdfModule;
}

/**
 * pdfjs ships its character maps and standard font data as data directories.
 * Pointing at them matters for extraction quality: without the cmaps, text in
 * CID-encoded PDFs (CJK, and subset fonts from some producers) comes out as
 * unusable bytes. Resolved once, and treated as optional so a packaging layout
 * without those directories degrades instead of failing.
 */
let dataUrls: { cMapUrl?: string; standardFontDataUrl?: string } | undefined;

function getDataUrls(): { cMapUrl?: string; standardFontDataUrl?: string } {
	if (dataUrls) return dataUrls;
	try {
		const resolve = (import.meta as { resolve?: (specifier: string) => string }).resolve;
		const packageUrl = resolve?.("pdfjs-dist/package.json");
		if (!packageUrl) {
			dataUrls = {};
			return dataUrls;
		}
		const base = packageUrl.replace(/package\.json$/, "");
		dataUrls = { cMapUrl: `${base}cmaps/`, standardFontDataUrl: `${base}standard_fonts/` };
	} catch {
		dataUrls = {};
	}
	return dataUrls;
}

export async function extractPdf(buffer: Buffer): Promise<ExtractedDocument> {
	const pdfjs = await loadPdfjs();

	let document: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;
	try {
		document = await pdfjs.getDocument({
			// A copy is required: pdfjs takes ownership of the buffer it is given.
			data: new Uint8Array(buffer),
			isEvalSupported: false,
			disableFontFace: true,
			useWorkerFetch: false,
			cMapPacked: true,
			// Errors only: pdfjs is chatty about recoverable structural problems and
			// this runs inside the service, not a viewer.
			verbosity: 0,
			...getDataUrls(),
		}).promise;
	} catch (cause) {
		const name = (cause as { name?: string } | undefined)?.name;
		const reason = name === "PasswordException" ? "encrypted" : "parse-failed";
		return { kind: "pdf", text: "", segments: [], emptyReason: reason };
	}

	const pageCount = document.numPages;
	const pagesToRead = Math.min(pageCount, MAX_PDF_PAGES);
	const segments: DocumentSegment[] = [];

	try {
		for (let pageNumber = 1; pageNumber <= pagesToRead; pageNumber++) {
			const page = await document.getPage(pageNumber);
			const content = await page.getTextContent();
			const text = joinTextItems(content.items);
			page.cleanup();
			if (text) segments.push({ locator: `page ${pageNumber}`, text });
		}
	} catch {
		// Keep whatever pages already came out; a later page failing should not
		// throw away earlier text.
	} finally {
		await document.destroy().catch(() => undefined);
	}

	const text = segments.map((segment) => segment.text).join("\n");
	if (!text.trim()) {
		return { kind: "pdf", text: "", segments: [], emptyReason: "no-text-layer", unitCount: pageCount };
	}
	return { kind: "pdf", text, segments, unitCount: pageCount };
}

/**
 * pdfjs emits one item per positioned text run, with `hasEOL` marking line ends.
 * Joining on that keeps line numbers meaningful instead of collapsing a page to
 * one very long line.
 */
function joinTextItems(items: Array<{ str?: string; hasEOL?: boolean } | unknown>): string {
	let out = "";
	for (const item of items) {
		const run = item as { str?: string; hasEOL?: boolean };
		if (typeof run.str !== "string") continue;
		out += run.str;
		if (run.hasEOL) out += "\n";
		else if (run.str && !run.str.endsWith(" ")) out += " ";
	}
	return out
		.replace(/[ \t]{2,}/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
