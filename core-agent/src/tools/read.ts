import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { basename, extname } from "path";
import { extractDocumentBuffer, isExtractableDocument } from "../documents/extract.js";
import { buildOutline, OUTLINE_THRESHOLD_BYTES, renderOutline, shouldOutline } from "../documents/outline.js";
import { writeOutline } from "../documents/outline-cache.js";
import { selectSegments } from "../documents/select.js";
import { describeEmptyReason, type DocumentSegment, type ExtractedDocument } from "../documents/types.js";
import type { Executor } from "../sandbox.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const IMAGE_MIME_TYPES: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
};

function isImageFile(filePath: string): string | null {
	const ext = extname(filePath).toLowerCase();
	return IMAGE_MIME_TYPES[ext] || null;
}

const readSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're reading and why (shown to user)" }),
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
	pages: Type.Optional(
		Type.String({
			description:
				'Documents only (pdf, xlsx, pptx): which pages/sheets/slides to read, e.g. "3", "3-7", "2,5,9-11", or a sheet name like "Q3". Use "all" to force the whole document. Omit it to get an outline of a large document instead of its text.',
		}),
	),
});

interface ReadToolDetails {
	truncation?: TruncationResult;
	/** Set when the file was a binary document whose text had to be extracted. */
	extracted?: { kind: string; segments: number; unitCount?: number };
	/** Set when an outline was returned in place of the document body. */
	outline?: { rows: number; extractedBytes: number };
	/** Set when `pages` narrowed the document to a subset of its segments. */
	selected?: { spec: string; segments: number; unmatched: string[] };
}

/**
 * Prefixes every line with its real line number in the file, so the coordinate
 * `grep` reported survives into what `read` returns. Without this the round trip
 * is one-way: `grep` hands back `340:METHOD get_data`, `read(offset=340)` hands
 * back bare text, and from there a second hit in the same file has nothing to be
 * located against.
 *
 * The separator is deliberately not `:` — `grep` already uses that, and a colon
 * is common enough at the start of a line that the prefix could be mistaken for
 * content. `edit` matches text exactly, so both tool descriptions have to say
 * the prefix is not part of the file.
 */
function numberLines(content: string, startLine: number): string {
	const lines = content.split("\n");
	const width = String(startLine + lines.length - 1).length;
	return lines.map((line, index) => `${String(startLine + index).padStart(width, " ")}→${line}`).join("\n");
}

/**
 * Renders an extracted document as text with segment markers, so page and sheet
 * numbers survive into what the model reads and can be quoted back to the user.
 */
function renderExtracted(path: string, document: ExtractedDocument, segments: DocumentSegment[] = document.segments): string {
	const parts: string[] = [];
	for (const segment of segments) {
		if (segment.locator) parts.push(`--- ${segment.locator} ---`);
		parts.push(segment.text);
	}
	const unit = document.kind === "pdf" ? "page" : document.kind === "pptx" ? "slide" : "sheet";
	const count = document.unitCount ?? document.segments.length;
	const scope = document.kind === "docx" ? "" : ` — ${count} ${unit}${count === 1 ? "" : "s"}`;
	// Say so when this is a slice, so the model never mistakes a few pages for the
	// whole document and concludes something is absent.
	const selection =
		segments.length < document.segments.length ? `, showing ${segments.length} of ${document.segments.length}` : "";
	const header = `[Extracted text from ${basename(path)} (${document.kind}${scope}${selection}). This is the document's text, not the raw file.]`;
	return `${header}\n\n${parts.join("\n")}`;
}

export function createReadTool(executor: Executor): AgentTool<typeof readSchema> {
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files, images (jpg, png, gif, webp), and documents (pdf, docx, xlsx, pptx) whose text is extracted with page/sheet/slide markers. Images are sent as attachments. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).

Text lines come back prefixed with their line number and an arrow, as in "  42→const x = 1". The prefix is not part of the file: strip it before quoting a line or passing text to edit. Those numbers are the ones grep reports, so a hit at "340:foo" is read with offset=340 — read the region around a match instead of the whole file, and page through a large one with offset/limit.

A document larger than ${OUTLINE_THRESHOLD_BYTES / 1024}KB of text returns an outline of its pages/sheets/slides instead of its body — pick what you need from it and read again with pages="3-7". Do not pull a whole document into context when a page will do.`,
		parameters: readSchema,
		execute: async (
			_toolCallId: string,
			{ path, offset, limit, pages }: { label: string; path: string; offset?: number; limit?: number; pages?: string },
			_signal?: AbortSignal,
		): Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }> => {
			const mimeType = isImageFile(path);
			const buffer = await executor.readFile(path);

			if (mimeType) {
				const base64 = buffer.toString("base64");
				return {
					content: [
						{ type: "text", text: `Read image file [${mimeType}]` },
						{ type: "image", data: base64, mimeType },
					],
					details: undefined,
				};
			}

			// Binary documents (PDF/Office) are compressed containers, so reading them
			// as UTF-8 used to return mojibake. Extract their text instead.
			const documentKind = isExtractableDocument(path);
			let extractedDetails: ReadToolDetails["extracted"];
			let selectionDetails: ReadToolDetails["selected"];
			let fileContent: string;
			// Line numbers are the coordinate system for a text file. A document that
			// has coordinates of its own does not want them: its pages are addressed
			// with `pages=`, and numbering the *extracted* text would invent positions
			// that shift with the selection and exist nowhere in the file.
			let withLineNumbers = true;

			if (documentKind) {
				const document = await extractDocumentBuffer(buffer, documentKind);
				if (document.emptyReason) {
					return {
						content: [
							{
								type: "text",
								text: `Cannot read text from ${basename(path)}: ${describeEmptyReason(document.emptyReason, document.kind)}.`,
							},
						],
						details: undefined,
					};
				}

				extractedDetails = {
					kind: document.kind,
					segments: document.segments.length,
					unitCount: document.unitCount,
				};

				// Refresh the sidecar on every successful extraction. There is no stat
				// to offer here — the bytes came through the executor, which may be a
				// container — so the entry is validated on size alone. The key is the
				// resolved path, because `glob` reports absolute paths while the model
				// usually passes a relative one, and both must name the same entry.
				const outline = buildOutline(document);
				writeOutline(executor.resolvePath(path), outline, { size: buffer.byteLength });

				// A format with no coordinates of its own — docx, where mammoth returns
				// one blob — is navigated with offset/limit, and its outline rows are
				// already labelled by line range. That is the one document kind whose
				// line numbers are real, so it keeps them.
				withLineNumbers = !outline.addressable;

				let segments = document.segments;
				let selectedDetails: ReadToolDetails["selected"];

				if (pages !== undefined && pages.trim() !== "") {
					const selection = selectSegments(document, pages);
					selectedDetails = {
						spec: pages,
						segments: selection.segments.length,
						unmatched: selection.unmatched,
					};
					if (selection.segments.length === 0) {
						const available = document.segments
							.map((segment, index) => segment.locator ?? `segment ${index + 1}`)
							.slice(0, 12)
							.join(", ");
						const more = document.segments.length > 12 ? `, … (${document.segments.length} total)` : "";
						return {
							content: [
								{
									type: "text",
									text: `No part of ${basename(path)} matches pages="${pages}". Available: ${available}${more}.`,
								},
							],
							details: { extracted: extractedDetails, selected: selectedDetails },
						};
					}
					segments = selection.segments;
				}

				// Without an explicit selection, a large document returns its outline
				// rather than its body: fetching text the model cannot yet address is
				// the single most expensive thing `read` used to do.
				const wantsOutline =
					pages === undefined && offset === undefined && limit === undefined && shouldOutline(document);

				if (wantsOutline) {
					// Line labels have to match what a follow-up read actually returns,
					// which carries a header the extracted text does not have.
					const lineOffset = outline.addressable
						? 0
						: renderExtracted(path, document).split("\n").length - outline.totalLines;
					return {
						content: [{ type: "text", text: renderOutline(basename(path), outline, lineOffset) }],
						details: {
							extracted: extractedDetails,
							outline: { rows: outline.rows.length, extractedBytes: outline.extractedBytes },
						},
					};
				}

				fileContent = renderExtracted(path, document, segments);
				if (selectedDetails) selectionDetails = selectedDetails;
			} else {
				fileContent = buffer.toString("utf-8");
			}

			const allLines = fileContent.split("\n");
			const totalFileLines = allLines.length;

			const startLine = offset ? Math.max(1, offset) : 1;
			const startLineDisplay = startLine;

			if (startLine > totalFileLines) {
				throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
			}

			let selectedLines = allLines.slice(startLine - 1);
			let userLimitedLines: number | undefined;

			if (limit !== undefined) {
				const endLine = Math.min(limit, selectedLines.length);
				selectedLines = selectedLines.slice(0, endLine);
				userLimitedLines = endLine;
			}

			const selectedContent = selectedLines.join("\n");

			// Numbered before truncating, not after, so the prefixes are paid for out
			// of the same byte budget as the content rather than pushing the result
			// past the limit the model was told about.
			const truncation = truncateHead(withLineNumbers ? numberLines(selectedContent, startLine) : selectedContent);

			let outputText: string;
			let details: ReadToolDetails | undefined;

			if (truncation.firstLineExceedsLimit) {
				const firstLineSize = formatSize(Buffer.byteLength(selectedContent.split("\n")[0], "utf-8"));
				// The sed hint only makes sense for a real text file; extracted text has
				// no corresponding line in the file on disk.
				const hint = documentKind
					? "Use grep on this document to locate the part you need, then read it with pages=."
					: `Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}`;
				outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. ${hint}]`;
				details = { truncation };
			} else if (truncation.truncated) {
				const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
				const nextOffset = endLineDisplay + 1;

				outputText = truncation.content;

				if (truncation.truncatedBy === "lines") {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue]`;
				} else {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue]`;
				}
				details = { truncation };
			} else if (userLimitedLines !== undefined) {
				const linesFromStart = startLine - 1 + userLimitedLines;
				if (linesFromStart < totalFileLines) {
					const remaining = totalFileLines - linesFromStart;
					const nextOffset = startLine + userLimitedLines;
					outputText = truncation.content;
					outputText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue]`;
				} else {
					outputText = truncation.content;
				}
			} else {
				outputText = truncation.content;
			}

			if (extractedDetails) details = { ...details, extracted: extractedDetails };
			if (selectionDetails) {
				details = { ...details, selected: selectionDetails };
				if (selectionDetails.unmatched.length > 0) {
					outputText += `\n\n[No match in this document for: ${selectionDetails.unmatched.join(", ")}]`;
				}
			}

			return { content: [{ type: "text", text: outputText }], details };
		},
	};
}
