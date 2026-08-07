import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { extractTitle, htmlToMarkdown } from "../net/html-to-markdown.js";
import { httpFetch, type HttpResponse } from "../net/proxy.js";
import { assertPublicUrl, BlockedUrlError } from "../net/ssrf-guard.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

/** Hard cap on the response body read into memory. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
/** Repeated fetches of the same URL within a turn are common; cache briefly. */
const CACHE_TTL_MS = 15 * 60 * 1000;
const USER_AGENT = "Octo-Agent/1.0 (+internal)";

const webFetchSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're fetching (shown to user)" }),
	url: Type.String({ description: "Absolute http or https URL to fetch" }),
	prompt: Type.Optional(
		Type.String({ description: "What you are looking for on the page; recorded for the user, does not change the request" }),
	),
});

interface WebFetchToolDetails {
	url: string;
	finalUrl: string;
	status: number;
	contentType?: string;
	title?: string;
	bytes: number;
	fromCache: boolean;
	truncation?: TruncationResult;
}

interface CacheEntry {
	expiresAt: number;
	finalUrl: string;
	status: number;
	contentType?: string;
	title?: string;
	body: string;
	bytes: number;
}

const cache = new Map<string, CacheEntry>();

function readCache(url: string): CacheEntry | undefined {
	const entry = cache.get(url);
	if (!entry) return undefined;
	if (entry.expiresAt < Date.now()) {
		cache.delete(url);
		return undefined;
	}
	return entry;
}

/** Follows redirects by hand so every hop can be re-validated by the guard. */
async function fetchFollowing(startUrl: URL, signal: AbortSignal): Promise<{ response: HttpResponse; finalUrl: URL }> {
	let current = startUrl;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const response = await httpFetch(current, {
			redirect: "manual",
			signal,
			headers: {
				"user-agent": USER_AGENT,
				accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
				"accept-language": "en",
			},
		});

		const isRedirect = response.status >= 300 && response.status < 400 && response.headers.has("location");
		if (!isRedirect) return { response, finalUrl: current };

		const location = response.headers.get("location") as string;
		let next: URL;
		try {
			next = new URL(location, current);
		} catch {
			throw new Error(`Server returned an unusable redirect target: ${location}`);
		}
		// Re-check every hop: a public URL may redirect to an internal address.
		current = await assertPublicUrl(next.toString());
	}
	throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}) starting from ${startUrl.toString()}`);
}

async function readBodyCapped(response: HttpResponse): Promise<{ text: string; bytes: number; truncated: boolean }> {
	const buffer = await response.arrayBuffer();
	const bytes = buffer.byteLength;
	const slice = bytes > MAX_BODY_BYTES ? buffer.slice(0, MAX_BODY_BYTES) : buffer;
	return {
		text: Buffer.from(slice).toString("utf-8"),
		bytes,
		truncated: bytes > MAX_BODY_BYTES,
	};
}

export function createWebFetchTool(): AgentTool<typeof webFetchSchema> {
	return {
		name: "web_fetch",
		label: "web_fetch",
		description:
			"Fetch a single http or https URL and return its content as Markdown (HTML is converted, JSON and plain text are returned as-is). Private, loopback, link-local and internal hostnames are blocked; internal SAP systems must be reached through the configured Destination and the sap-adt connector instead. Use web_search first if you do not already have a URL.",
		parameters: webFetchSchema,
		execute: async (_toolCallId: string, { url }: { label: string; url: string; prompt?: string }, signal?: AbortSignal) => {
			const target = await assertPublicUrl(url);
			const cacheKey = target.toString();

			const cached = readCache(cacheKey);
			if (cached) {
				const truncation = truncateHead(cached.body, { maxBytes: DEFAULT_MAX_BYTES * 4 });
				return {
					content: [{ type: "text", text: renderBody(cached, truncation, true) }],
					details: {
						url,
						finalUrl: cached.finalUrl,
						status: cached.status,
						contentType: cached.contentType,
						title: cached.title,
						bytes: cached.bytes,
						fromCache: true,
						truncation: truncation.truncated ? truncation : undefined,
					} satisfies WebFetchToolDetails,
				};
			}

			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
			const onOuterAbort = () => controller.abort();
			signal?.addEventListener("abort", onOuterAbort, { once: true });

			let response: HttpResponse;
			let finalUrl: URL;
			try {
				({ response, finalUrl } = await fetchFollowing(target, controller.signal));
			} catch (cause) {
				if (cause instanceof BlockedUrlError) throw cause;
				if (controller.signal.aborted && !signal?.aborted) {
					throw new Error(`Request to ${cacheKey} timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds`);
				}
				throw new Error(`Failed to fetch ${cacheKey}: ${cause instanceof Error ? cause.message : String(cause)}`);
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onOuterAbort);
			}

			if (!response.ok) {
				throw new Error(`Fetching ${finalUrl.toString()} returned HTTP ${response.status} ${response.statusText}`);
			}

			const contentType = response.headers.get("content-type") ?? undefined;
			const mediaType = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
			if (mediaType && !isTextual(mediaType)) {
				throw new Error(
					`${finalUrl.toString()} returned ${mediaType}, which is not text. Only HTML, JSON, XML and plain text can be read.`,
				);
			}

			const body = await readBodyCapped(response);
			const isHtml = mediaType === "text/html" || mediaType === "application/xhtml+xml" || /^\s*<(!doctype|html)/i.test(body.text);

			const title = isHtml ? extractTitle(body.text) : undefined;
			let rendered = isHtml ? htmlToMarkdown(body.text, finalUrl.toString()) : body.text;
			if (body.truncated) {
				rendered += `\n\n[Response body exceeded ${formatSize(MAX_BODY_BYTES)} and was cut short.]`;
			}

			const entry: CacheEntry = {
				expiresAt: Date.now() + CACHE_TTL_MS,
				finalUrl: finalUrl.toString(),
				status: response.status,
				contentType,
				title,
				body: rendered,
				bytes: body.bytes,
			};
			cache.set(cacheKey, entry);

			const truncation = truncateHead(rendered, { maxBytes: DEFAULT_MAX_BYTES * 4 });
			return {
				content: [{ type: "text", text: renderBody(entry, truncation, false) }],
				details: {
					url,
					finalUrl: entry.finalUrl,
					status: entry.status,
					contentType,
					title,
					bytes: body.bytes,
					fromCache: false,
					truncation: truncation.truncated ? truncation : undefined,
				} satisfies WebFetchToolDetails,
			};
		},
	};
}

function isTextual(mediaType: string): boolean {
	if (mediaType.startsWith("text/")) return true;
	return (
		mediaType === "application/json" ||
		mediaType === "application/xhtml+xml" ||
		mediaType === "application/xml" ||
		mediaType.endsWith("+json") ||
		mediaType.endsWith("+xml")
	);
}

function renderBody(entry: CacheEntry, truncation: TruncationResult, fromCache: boolean): string {
	const header = [
		entry.title ? `# ${entry.title}` : undefined,
		`Source: ${entry.finalUrl}${fromCache ? " (cached)" : ""}`,
	]
		.filter(Boolean)
		.join("\n");

	let text = `${header}\n\n${truncation.content || "(empty response body)"}`;
	if (truncation.truncated) {
		text += `\n\n[Showing the first ${truncation.outputLines} of ${truncation.totalLines} lines.]`;
	}
	return text;
}
