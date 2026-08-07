/**
 * Text extraction for OOXML documents: .docx, .xlsx and .pptx are all ZIP
 * archives of XML parts, so one JSZip-based reader covers them.
 *
 * For .docx, mammoth is tried first because it understands document structure;
 * this module is the fallback for text mammoth does not reach (text boxes,
 * headers, footers) and the only path for .xlsx and .pptx.
 */

import type { DocumentKind, DocumentSegment, ExtractedDocument } from "./types.js";
import { attributeValues, collectElementTexts, ooxmlPartToText } from "./xml-text.js";

type JSZipModule = typeof import("jszip");
type JSZipArchive = Awaited<ReturnType<JSZipModule["loadAsync"]>>;

let jszipModule: Promise<JSZipModule> | undefined;

function loadJsZip(): Promise<JSZipModule> {
	// jszip is CommonJS with `export =`: the types describe the callable on the
	// namespace, but at runtime an ESM dynamic import puts it on `default`.
	jszipModule ??= import("jszip").then((imported) => {
		const withDefault = imported as unknown as { default?: JSZipModule };
		return withDefault.default ?? (imported as unknown as JSZipModule);
	});
	return jszipModule;
}

export async function extractOoxml(buffer: Buffer, kind: DocumentKind): Promise<ExtractedDocument> {
	let archive: JSZipArchive;
	try {
		const JSZip = await loadJsZip();
		archive = await JSZip.loadAsync(buffer);
	} catch {
		return { kind, text: "", segments: [], emptyReason: "parse-failed" };
	}

	try {
		const segments =
			kind === "xlsx"
				? await extractWorkbook(archive)
				: kind === "pptx"
					? await extractPresentation(archive)
					: await extractWordDocument(archive);

		const text = segments.map((segment) => segment.text).join("\n");
		if (!text.trim()) {
			return { kind, text: "", segments: [], emptyReason: "no-text-layer", unitCount: segments.length };
		}
		return { kind, text, segments, unitCount: segments.length };
	} catch {
		return { kind, text: "", segments: [], emptyReason: "parse-failed" };
	}
}

async function readPart(archive: JSZipArchive, name: string): Promise<string | undefined> {
	const file = archive.file(name);
	if (!file) return undefined;
	return file.async("string");
}

/** Sorts `sheet2.xml`, `sheet10.xml` numerically rather than lexicographically. */
function sortByTrailingNumber(names: string[]): string[] {
	const numberOf = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);
	return [...names].sort((a, b) => numberOf(a) - numberOf(b));
}

async function extractWordDocument(archive: JSZipArchive): Promise<DocumentSegment[]> {
	const parts = ["word/document.xml"];
	// Headers and footers often hold the org/owner information worth searching.
	for (const name of Object.keys(archive.files)) {
		if (/^word\/(?:header|footer)\d+\.xml$/.test(name)) parts.push(name);
	}

	const texts: string[] = [];
	for (const name of parts) {
		const xml = await readPart(archive, name);
		if (!xml) continue;
		const text = ooxmlPartToText(xml);
		if (text) texts.push(text);
	}
	return texts.length > 0 ? [{ text: texts.join("\n") }] : [];
}

async function extractPresentation(archive: JSZipArchive): Promise<DocumentSegment[]> {
	const slideNames = sortByTrailingNumber(
		Object.keys(archive.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)),
	);

	const segments: DocumentSegment[] = [];
	for (const [index, name] of slideNames.entries()) {
		const xml = await readPart(archive, name);
		if (!xml) continue;
		const text = ooxmlPartToText(xml);
		if (text) segments.push({ locator: `slide ${index + 1}`, text });
	}
	return segments;
}

async function extractWorkbook(archive: JSZipArchive): Promise<DocumentSegment[]> {
	const sharedStrings = await readSharedStrings(archive);
	const sheets = await resolveSheets(archive);

	const segments: DocumentSegment[] = [];
	for (const sheet of sheets) {
		const xml = await readPart(archive, sheet.part);
		if (!xml) continue;
		const text = worksheetToText(xml, sharedStrings);
		if (text) segments.push({ locator: `sheet ${sheet.name}`, text });
	}
	return segments;
}

/** `xl/sharedStrings.xml` holds the string table cells refer to by index. */
async function readSharedStrings(archive: JSZipArchive): Promise<string[]> {
	const xml = await readPart(archive, "xl/sharedStrings.xml");
	if (!xml) return [];
	// Each <si> may hold several <t> runs; concatenating them rebuilds the value.
	return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) =>
		collectElementTexts(match[1], "t").join(""),
	);
}

/**
 * Maps sheet names to worksheet parts through the workbook relationships, so a
 * hit is reported against the sheet the user actually sees.
 */
async function resolveSheets(archive: JSZipArchive): Promise<Array<{ name: string; part: string }>> {
	const workbook = await readPart(archive, "xl/workbook.xml");
	const rels = await readPart(archive, "xl/_rels/workbook.xml.rels");

	const fallback = sortByTrailingNumber(
		Object.keys(archive.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)),
	);

	if (!workbook) {
		return fallback.map((part, index) => ({ name: String(index + 1), part }));
	}

	const names = attributeValues(workbook, "sheet", "name");
	const relIds = attributeValues(workbook, "sheet", "r:id");

	const relTargets = new Map<string, string>();
	if (rels) {
		for (const match of rels.matchAll(/<Relationship\b[^>]*>/g)) {
			const id = /\bId="([^"]*)"/.exec(match[0])?.[1];
			const target = /\bTarget="([^"]*)"/.exec(match[0])?.[1];
			if (id && target) relTargets.set(id, target.replace(/^\/?xl\//, "").replace(/^\.\//, ""));
		}
	}

	return names.map((name, index) => {
		const target = relIds[index] ? relTargets.get(relIds[index]) : undefined;
		const part = target ? `xl/${target}` : (fallback[index] ?? "");
		return { name: name || String(index + 1), part };
	}).filter((sheet) => sheet.part.length > 0);
}

/** One spreadsheet row becomes one line, cells separated by tabs. */
function worksheetToText(xml: string, sharedStrings: string[]): string {
	const lines: string[] = [];
	for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
		const cells: string[] = [];
		for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
			cells.push(cellValue(cellMatch[1], cellMatch[2], sharedStrings));
		}
		const line = cells.join("\t").trim();
		if (line) lines.push(line);
	}
	return lines.join("\n");
}

function cellValue(attributes: string, body: string, sharedStrings: string[]): string {
	const type = /\bt="([^"]*)"/.exec(attributes)?.[1];

	if (type === "s") {
		const index = Number(collectElementTexts(body, "v")[0]);
		return Number.isInteger(index) ? (sharedStrings[index] ?? "") : "";
	}
	if (type === "inlineStr") {
		return collectElementTexts(body, "t").join("");
	}
	// Numbers, booleans, dates and formula results all live in <v>; formula text
	// itself (<f>) is deliberately ignored.
	return collectElementTexts(body, "v").join("") || collectElementTexts(body, "t").join("");
}
