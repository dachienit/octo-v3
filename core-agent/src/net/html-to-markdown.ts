/**
 * Minimal HTML to Markdown conversion for `web_fetch`.
 *
 * Written by hand rather than pulling in turndown/cheerio/jsdom: the corporate
 * proxy makes adding dependencies costly, and the goal here is only to produce
 * readable text for a language model, not a faithful round-trip converter.
 *
 * The approach is deliberately simple: isolate the main content region, drop
 * non-content elements, convert the block and inline tags that carry meaning,
 * then normalize whitespace.
 */

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ndash: "-",
	mdash: "--",
	hellip: "...",
	lsquo: "'",
	rsquo: "'",
	ldquo: '"',
	rdquo: '"',
	middot: "*",
	bull: "*",
	copy: "(c)",
	reg: "(R)",
	trade: "(TM)",
	deg: " degrees",
	euro: "EUR",
	pound: "GBP",
	laquo: "<<",
	raquo: ">>",
};

function decodeEntities(text: string): string {
	return text
		.replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_match, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
		.replace(/&([a-z][a-z0-9]*);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function safeCodePoint(code: number): string {
	if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
	try {
		return String.fromCodePoint(code);
	} catch {
		return "";
	}
}

/** Strips tags that never carry readable content, along with their contents. */
function removeNonContent(html: string): string {
	return html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<\?[\s\S]*?\?>/g, "")
		.replace(/<(script|style|noscript|template|svg|canvas|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
		.replace(/<(script|style|noscript|svg)\b[^>]*\/?>/gi, "");
}

/**
 * Narrows to the main content region when the page marks one. Falls back to the
 * body, then to the whole document.
 */
function extractMainRegion(html: string): string {
	for (const pattern of [
		/<main\b[^>]*>([\s\S]*?)<\/main>/i,
		/<article\b[^>]*>([\s\S]*?)<\/article>/i,
		/<div\b[^>]*role=["']main["'][^>]*>([\s\S]*?)<\/div>/i,
	]) {
		const match = pattern.exec(html);
		// Guard against a tiny <main> wrapper that is not really the content.
		if (match && match[1].length > 500) return match[1];
	}
	const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
	return body ? body[1] : html;
}

/** Drops chrome that survives inside the content region. */
function removeChrome(html: string): string {
	return html.replace(/<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
}

export function extractTitle(html: string): string | undefined {
	const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	if (!match) return undefined;
	const title = decodeEntities(match[1]).replace(/\s+/g, " ").trim();
	return title || undefined;
}

function convertLinks(html: string, baseUrl?: string): string {
	return html.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, inner: string) => {
		const text = inner.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
		if (!text) return "";
		if (!href || href.startsWith("#") || href.startsWith("javascript:")) return text;
		let resolved = href;
		if (baseUrl) {
			try {
				resolved = new URL(href, baseUrl).toString();
			} catch {
				resolved = href;
			}
		}
		return `[${text}](${resolved})`;
	});
}

function convertBlocks(html: string): string {
	let out = html;

	out = out.replace(/<br\s*\/?>/gi, "\n");
	out = out.replace(/<hr\s*\/?>/gi, "\n\n---\n\n");

	for (let level = 1; level <= 6; level++) {
		const pattern = new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)</h${level}>`, "gi");
		out = out.replace(pattern, (_match, inner: string) => `\n\n${"#".repeat(level)} ${inline(inner)}\n\n`);
	}

	out = out.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, inner: string) => {
		const code = inner.replace(/<\/?code\b[^>]*>/gi, "").replace(/<[^>]+>/g, "");
		return `\n\n\`\`\`\n${code.replace(/^\n+|\n+$/g, "")}\n\`\`\`\n\n`;
	});

	out = out.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_match, inner: string) => {
		const text = inline(inner).trim();
		return `\n\n${text
			.split("\n")
			.map((line) => `> ${line}`)
			.join("\n")}\n\n`;
	});

	// Table rows become pipe-separated lines; good enough to preserve structure.
	out = out.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_match, inner: string) => {
		const cells = [...inner.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => inline(cell[1]).trim());
		return cells.length > 0 ? `\n| ${cells.join(" | ")} |` : "";
	});

	out = out.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_match, inner: string) => `\n- ${inline(inner).trim()}`);
	out = out.replace(/<\/(ul|ol|table|tbody|thead)>/gi, "\n\n");
	out = out.replace(/<\/(p|div|section|dd|dt|dl|figcaption)>/gi, "\n\n");

	return out;
}

/**
 * Converts inline emphasis and code, then removes any remaining tags. Entities
 * are intentionally left alone: they are decoded exactly once, at the very end,
 * so that text like `&amp;nbsp;` does not get decoded twice.
 */
function convertInlineTags(html: string): string {
	return html
		.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, inner: string) => `**${strip(inner)}**`)
		.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, inner: string) => `*${strip(inner)}*`)
		.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_match, inner: string) => `\`${strip(inner)}\``)
		.replace(/<[^>]+>/g, "");
}

/** Inline conversion for a fragment that must end up on a single line. */
function inline(html: string): string {
	return convertInlineTags(html).replace(/[ \t]+/g, " ").trim();
}

function strip(html: string): string {
	return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function normalize(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.split("\n")
		.map((line) => line.replace(/[ \t]{2,}/g, " ").trimEnd())
		.join("\n")
		.trim();
}

/** Converts an HTML document to Markdown-ish plain text. */
export function htmlToMarkdown(html: string, baseUrl?: string): string {
	const cleaned = removeChrome(extractMainRegion(removeNonContent(html)));
	const withLinks = convertLinks(cleaned, baseUrl);
	const blocks = convertBlocks(withLinks);
	// This pass also removes every tag that survived block conversion, and is the
	// single point where entities are decoded.
	return normalize(decodeEntities(convertInlineTags(blocks)));
}
