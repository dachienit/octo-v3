import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { runWebSearch, type SearchResultItem, type WebSearchConfig } from "../net/search-providers.js";
import { truncateHead } from "./truncate.js";

const webSearchSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're searching for (shown to user)" }),
	query: Type.String({ description: "Search query" }),
	count: Type.Optional(Type.Number({ description: "Number of results to return (1-20, default 10)" })),
	allowed_domains: Type.Optional(
		Type.Array(Type.String(), { description: "Only keep results whose host matches one of these domains" }),
	),
	blocked_domains: Type.Optional(
		Type.Array(Type.String(), { description: "Drop results whose host matches one of these domains" }),
	),
});

interface WebSearchParams {
	label: string;
	query: string;
	count?: number;
	allowed_domains?: string[];
	blocked_domains?: string[];
}

interface WebSearchToolDetails {
	provider: string;
	query: string;
	returned: number;
	filtered: number;
}

/** Matches a result host against a domain, allowing subdomains. */
function hostMatches(url: string, domain: string): boolean {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	const needle = domain.trim().toLowerCase().replace(/^\*?\./, "");
	if (!needle) return false;
	return host === needle || host.endsWith(`.${needle}`);
}

export function createWebSearchTool(config: WebSearchConfig): AgentTool<typeof webSearchSchema> {
	return {
		name: "web_search",
		label: "web_search",
		description: `Search the web and return result titles, URLs and snippets (via ${config.provider}). Use this to find pages you do not already have a URL for, then read the interesting ones with web_fetch.`,
		parameters: webSearchSchema,
		execute: async (_toolCallId: string, params: WebSearchParams, signal?: AbortSignal) => {
			const results = await runWebSearch(config, params.query, { count: params.count, signal });

			let kept = results;
			if (params.allowed_domains?.length) {
				kept = kept.filter((result) => params.allowed_domains?.some((domain) => hostMatches(result.url, domain)));
			}
			if (params.blocked_domains?.length) {
				kept = kept.filter((result) => !params.blocked_domains?.some((domain) => hostMatches(result.url, domain)));
			}

			const details: WebSearchToolDetails = {
				provider: config.provider,
				query: params.query,
				returned: kept.length,
				filtered: results.length - kept.length,
			};

			if (kept.length === 0) {
				const note =
					results.length > 0
						? ` (${results.length} result(s) were removed by the domain filters)`
						: "";
				return {
					content: [{ type: "text", text: `No results for "${params.query}"${note}.` }],
					details,
				};
			}

			const body = kept.map(formatResult).join("\n\n");
			const truncation = truncateHead(body);
			let text = `${kept.length} result(s) for "${params.query}":\n\n${truncation.content}`;
			if (truncation.truncated) text += "\n\n[Result list truncated.]";

			return { content: [{ type: "text", text }], details };
		},
	};
}

function formatResult(result: SearchResultItem, index: number): string {
	const lines = [`${index + 1}. ${result.title}`, `   ${result.url}`];
	if (result.snippet) lines.push(`   ${result.snippet}`);
	return lines.join("\n");
}
