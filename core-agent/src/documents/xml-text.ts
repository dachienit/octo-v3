/**
 * Pulls readable text out of OOXML part documents.
 *
 * This is a regex-based stripper, not an XML parser: the goal is searchable text,
 * not structure. That trade-off is deliberate — a real parser would add a
 * dependency and buy nothing for `grep`.
 */

const XML_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};

function decodeXmlEntities(text: string): string {
	return text
		.replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => codePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_match, dec: string) => codePoint(Number.parseInt(dec, 10)))
		.replace(/&([a-z]+);/gi, (match, name: string) => XML_ENTITIES[name.toLowerCase()] ?? match);
}

function codePoint(code: number): string {
	if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
	try {
		return String.fromCodePoint(code);
	} catch {
		return "";
	}
}

/**
 * Converts an OOXML part to plain text. Paragraph, row and line-break elements
 * become newlines so that line numbers in search results mean something; cell
 * and run boundaries become spaces so words do not run together.
 */
export function ooxmlPartToText(xml: string): string {
	return decodeXmlEntities(
		xml
			// Drop parts that never contain body text.
			.replace(/<(?:mc:AlternateContent|w:instrText|a:fld)\b[^>]*>[\s\S]*?<\/(?:mc:AlternateContent|w:instrText|a:fld)>/g, "")
			// Paragraph, row and explicit break boundaries -> newline.
			.replace(/<(?:\/w:p|\/a:p|\/row|w:br\s*\/|a:br\s*\/|w:cr\s*\/)>/g, "\n")
			.replace(/<\/(?:w:tr|a:tr)>/g, "\n")
			// Cell and run boundaries -> space.
			.replace(/<\/(?:w:tc|a:tc|c|is|si)>/g, " ")
			.replace(/<[^>]*>/g, ""),
	)
		.replace(/\r\n/g, "\n")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Extracts the text of every occurrence of a simple element, in order. */
export function collectElementTexts(xml: string, tagName: string): string[] {
	const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`, "g");
	const out: string[] = [];
	for (const match of xml.matchAll(pattern)) {
		out.push(decodeXmlEntities(match[1].replace(/<[^>]*>/g, "")));
	}
	return out;
}

/** Reads an attribute off the first matching element. */
export function attributeValues(xml: string, tagName: string, attribute: string): string[] {
	const pattern = new RegExp(`<${tagName}\\b[^>]*\\b${attribute}="([^"]*)"`, "g");
	const out: string[] = [];
	for (const match of xml.matchAll(pattern)) {
		out.push(decodeXmlEntities(match[1]));
	}
	return out;
}
