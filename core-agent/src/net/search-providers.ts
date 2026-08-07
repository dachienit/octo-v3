/**
 * Web search backends for the `web_search` tool.
 *
 * Octo has no search provider of its own, so this is an adapter over the usual
 * hosted APIs. Configuration is environment-driven and the tool is only
 * registered when a provider and key are present, so the model never sees a tool
 * it cannot actually call.
 *
 * On Cloud Foundry the variables can be supplied through a user-provided service:
 * `loadUserProvidedCredentials()` in core-service copies those credentials into
 * `process.env` before the agent is constructed.
 */

import { httpFetch } from "./proxy.js";

export type SearchProviderName = "brave" | "tavily" | "google-cse";

export interface SearchResultItem {
	title: string;
	url: string;
	snippet?: string;
	/** Provider-supplied page content, when the backend returns it. */
	content?: string;
}

export interface WebSearchConfig {
	provider: SearchProviderName;
	apiKey: string;
	/** Overrides the provider's default endpoint. */
	endpoint?: string;
	/** Google Programmable Search engine id (`cx`); required for google-cse. */
	engineId?: string;
}

const DEFAULT_ENDPOINTS: Record<SearchProviderName, string> = {
	brave: "https://api.search.brave.com/res/v1/web/search",
	tavily: "https://api.tavily.com/search",
	"google-cse": "https://www.googleapis.com/customsearch/v1",
};

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Reads the search configuration from the environment. Returns `undefined` when
 * search is not configured, which is the normal default.
 */
export function resolveWebSearchConfig(env: NodeJS.ProcessEnv = process.env): WebSearchConfig | undefined {
	const provider = env.WEB_SEARCH_PROVIDER?.trim().toLowerCase();
	const apiKey = env.WEB_SEARCH_API_KEY?.trim();
	if (!provider || !apiKey) return undefined;

	if (provider !== "brave" && provider !== "tavily" && provider !== "google-cse") {
		console.warn(`Ignoring unknown WEB_SEARCH_PROVIDER "${provider}"; expected brave, tavily or google-cse.`);
		return undefined;
	}
	if (provider === "google-cse" && !env.WEB_SEARCH_ENGINE_ID?.trim()) {
		console.warn("WEB_SEARCH_PROVIDER=google-cse also requires WEB_SEARCH_ENGINE_ID; web search stays disabled.");
		return undefined;
	}

	return {
		provider,
		apiKey,
		endpoint: env.WEB_SEARCH_ENDPOINT?.trim() || undefined,
		engineId: env.WEB_SEARCH_ENGINE_ID?.trim() || undefined,
	};
}

export async function runWebSearch(
	config: WebSearchConfig,
	query: string,
	options: { count?: number; signal?: AbortSignal } = {},
): Promise<SearchResultItem[]> {
	const count = Math.min(Math.max(options.count ?? 10, 1), 20);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	const onAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		if (config.provider === "brave") return await searchBrave(config, query, count, controller.signal);
		if (config.provider === "tavily") return await searchTavily(config, query, count, controller.signal);
		return await searchGoogleCse(config, query, count, controller.signal);
	} catch (cause) {
		if (controller.signal.aborted && !options.signal?.aborted) {
			throw new Error(`Web search timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds`);
		}
		throw cause;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

async function requestJson(
	url: string,
	init: Parameters<typeof httpFetch>[1],
	provider: SearchProviderName,
): Promise<unknown> {
	const response = await httpFetch(url, init);
	if (!response.ok) {
		const body = (await response.text().catch(() => "")).slice(0, 300);
		throw new Error(`${provider} search failed with HTTP ${response.status} ${response.statusText}${body ? `: ${body}` : ""}`);
	}
	return response.json();
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

async function searchBrave(
	config: WebSearchConfig,
	query: string,
	count: number,
	signal: AbortSignal,
): Promise<SearchResultItem[]> {
	const url = new URL(config.endpoint ?? DEFAULT_ENDPOINTS.brave);
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(count));

	const payload = (await requestJson(
		url.toString(),
		{ signal, headers: { accept: "application/json", "x-subscription-token": config.apiKey } },
		"brave",
	)) as { web?: { results?: Array<Record<string, unknown>> } };

	return (payload.web?.results ?? []).flatMap((result) => {
		const link = asString(result.url);
		if (!link) return [];
		return [{ title: asString(result.title) ?? link, url: link, snippet: stripTags(asString(result.description)) }];
	});
}

async function searchTavily(
	config: WebSearchConfig,
	query: string,
	count: number,
	signal: AbortSignal,
): Promise<SearchResultItem[]> {
	const payload = (await requestJson(
		config.endpoint ?? DEFAULT_ENDPOINTS.tavily,
		{
			method: "POST",
			signal,
			headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
			body: JSON.stringify({ query, max_results: count, search_depth: "basic" }),
		},
		"tavily",
	)) as { results?: Array<Record<string, unknown>> };

	return (payload.results ?? []).flatMap((result) => {
		const link = asString(result.url);
		if (!link) return [];
		return [
			{
				title: asString(result.title) ?? link,
				url: link,
				snippet: asString(result.content)?.slice(0, 500),
				content: asString(result.raw_content),
			},
		];
	});
}

async function searchGoogleCse(
	config: WebSearchConfig,
	query: string,
	count: number,
	signal: AbortSignal,
): Promise<SearchResultItem[]> {
	const url = new URL(config.endpoint ?? DEFAULT_ENDPOINTS["google-cse"]);
	url.searchParams.set("key", config.apiKey);
	url.searchParams.set("cx", config.engineId ?? "");
	url.searchParams.set("q", query);
	// The Custom Search API caps `num` at 10 per request.
	url.searchParams.set("num", String(Math.min(count, 10)));

	const payload = (await requestJson(url.toString(), { signal, headers: { accept: "application/json" } }, "google-cse")) as {
		items?: Array<Record<string, unknown>>;
	};

	return (payload.items ?? []).flatMap((item) => {
		const link = asString(item.link);
		if (!link) return [];
		return [{ title: asString(item.title) ?? link, url: link, snippet: stripTags(asString(item.snippet)) }];
	});
}

/** Providers return highlighted snippets containing markup; drop the tags. */
function stripTags(value: string | undefined): string | undefined {
	if (!value) return undefined;
	return value.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || undefined;
}
