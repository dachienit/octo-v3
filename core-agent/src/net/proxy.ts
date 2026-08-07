/**
 * Outbound HTTP for the web tools.
 *
 * Two things are deliberate here:
 *
 * 1. `NO_PROXY` is honored. `core-service` installs a global `ProxyAgent` at
 *    boot, which ignores `NO_PROXY` and therefore forces internal hosts through
 *    the corporate proxy. These tools use undici's `EnvHttpProxyAgent`, which
 *    reads `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`.
 *
 * 2. Requests go through undici's own `fetch`, not the global one. Node bundles
 *    its own copy of undici, and a dispatcher built from the `undici` package
 *    cannot serve a request issued by the bundled copy — the handler interfaces
 *    differ and the request fails with "invalid onRequestStart method". Keeping
 *    both sides on the same undici avoids that entirely.
 */

import { EnvHttpProxyAgent, fetch as undiciFetch, type RequestInit, type Response } from "undici";

let cached: { agent: EnvHttpProxyAgent; signature: string } | undefined;

function proxySignature(): string {
	return [
		process.env.HTTPS_PROXY,
		process.env.https_proxy,
		process.env.HTTP_PROXY,
		process.env.http_proxy,
		process.env.NO_PROXY,
		process.env.no_proxy,
	].join("|");
}

/** True when proxy environment variables are present. */
export function hasProxyConfigured(): boolean {
	return Boolean(
		process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy,
	);
}

/**
 * Returns the dispatcher to use for outbound requests, or `undefined` when no
 * proxy is configured. Rebuilt if the proxy environment changes at runtime.
 */
export function getProxyDispatcher(): EnvHttpProxyAgent | undefined {
	if (!hasProxyConfigured()) return undefined;

	const signature = proxySignature();
	if (cached?.signature === signature) return cached.agent;

	cached?.agent.close().catch(() => undefined);
	const agent = new EnvHttpProxyAgent();
	cached = { agent, signature };
	return agent;
}

export type HttpResponse = Response;

/** Proxy-aware `fetch` for the web tools. */
export function httpFetch(url: string | URL, init?: RequestInit): Promise<Response> {
	const dispatcher = getProxyDispatcher();
	return undiciFetch(url, dispatcher ? { ...init, dispatcher } : init);
}
