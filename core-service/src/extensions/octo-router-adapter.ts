/**
 * Octo Router gateway adapter.
 *
 * User-configured custom models (Octo Router) point at a complete gateway URL.
 * It supports four flavours we bridge here:
 *
 *   1. Azure OpenAI API (openai base provider):
 *        https://<host>/api/openai/deployments/<deployment>/chat/completions?api-version=<v>
 *   2. Vertex AI publisher endpoint, Google models (google base provider):
 *        https://<host>/api/google/v1/publishers/google/models/<model>:<method>
 *   3. Vertex AI publisher endpoint, Anthropic models (anthropic base provider):
 *        https://<host>/api/google/v1/publishers/anthropic/models/<model>:<method>
 *   4. AWS Bedrock publisher endpoint, Anthropic models (anthropic base provider):
 *        https://<host>/api/aws/v1/publishers/anthropic/models/<model>:<method>
 *        or standard AWS Bedrock Runtime endpoints.
 *
 * All router paths authenticate with `Authorization: Bearer <API_KEY>`.
 *
 * This module bridges the gaps with a single globalThis.fetch interceptor:
 * requests whose URL matches a registered base get their URL/headers/body rewritten
 * to the router/service expectations. SSE responses are untouched.
 */

type OctoRouterTarget =
	| { kind: "azure-openai"; apiVersion: string }
	| { kind: "vertex-google" }
	| { kind: "vertex-anthropic"; modelId?: string }
	| { kind: "bedrock-anthropic"; modelId?: string };

// Registered deployment bases (origin + path, without query and without the trailing
// route the SDK re-appends) → how the interceptor must rewrite matching requests.
const registry = new Map<string, OctoRouterTarget>();
let installed = false;

/**
 * Normalise a user-supplied Azure OpenAI endpoint into the `baseUrl` that pi-ai's
 * OpenAI client should use, and register its api-version so the interceptor can
 * re-attach it at request time. Returns the normalised base URL.
 */
export function prepareOctoRouterOpenAIEndpoint(endpoint: string): string {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return endpoint;
	}
	const apiVersion = url.searchParams.get("api-version") ?? undefined;
	url.search = "";
	// Strip the route the OpenAI SDK will append again, plus any trailing slashes.
	url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
	const base = `${url.origin}${url.pathname}`;
	if (apiVersion) {
		registry.set(base, { kind: "azure-openai", apiVersion });
		installOctoRouterFetch();
	}
	return base;
}

// parse a Vertex publisher URL pasted from the docs. Tolerates an
// optional query, an optional ":method" suffix and an optional "/models/{id}" segment:
//   https://<host>/api/google/v1/publishers/{pub}/models/{model}:{method}
// Returns the base up to ".../publishers/{pub}" plus the extracted model id (if any).
// Google models via the router's Vertex publisher endpoint.
export function prepareOctoRouterGoogleEndpoint(endpoint: string): string {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return endpoint;
	}
	const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
	registry.set(base, { kind: "vertex-google" });
	installOctoRouterFetch();
	return base;
}

// Anthropic models via Vertex/Bedrock publisher endpoints on the Octo Router.
export function prepareOctoRouterAnthropicEndpoint(endpoint: string, routing?: string): string {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return endpoint;
	}
	const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;

	if (routing === "vertex") {
		registry.set(base, { kind: "vertex-anthropic" });
	} else if (routing === "bedrock") {
		registry.set(base, { kind: "bedrock-anthropic" });
	} else {
		// Heuristic Fallback
		const looksLikeBedrock = endpoint.includes("aws") || endpoint.includes("bedrock");
		if (looksLikeBedrock) {
			registry.set(base, { kind: "bedrock-anthropic" });
		} else {
			registry.set(base, { kind: "vertex-anthropic" });
		}
	}

	installOctoRouterFetch();
	return base;
}

function matchRegisteredBase(url: string): OctoRouterTarget | undefined {
	for (const [base, target] of registry) {
		if (url.startsWith(base)) return target;
	}
	return undefined;
}

function installOctoRouterFetch(): void {
	if (installed) return;
	installed = true;

	const origFetch = globalThis.fetch;

	(globalThis as any).fetch = async function (
		input: string | Request | URL,
		init?: RequestInit,
	): Promise<Response> {
		let isStreaming = false;
		if (init?.body && typeof init.body === "string") {
			try {
				const p = JSON.parse(init.body) as Record<string, unknown>;
				if (p.stream === true) isStreaming = true;
			} catch {}
		}

		const url: string | undefined =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: (input as any)?.url;

		const target = url ? matchRegisteredBase(url) : undefined;
		if (!url || !target) {
			return origFetch.call(globalThis, input as any, init);
		}

		const headers = new Headers((init?.headers as Record<string, string> | undefined) ?? {});

		if (target.kind === "azure-openai") {
			let finalUrl = url;
			if (finalUrl.includes("octo-router%2F")) {
				finalUrl = finalUrl.replace("octo-router%2F", "");
			}
			if (finalUrl.includes("octo-router/")) {
				finalUrl = finalUrl.replace("octo-router/", "");
			}
			if (finalUrl.includes("bosch-genai%2F")) {
				finalUrl = finalUrl.replace("bosch-genai%2F", "");
			}
			if (finalUrl.includes("bosch-genai/")) {
				finalUrl = finalUrl.replace("bosch-genai/", "");
			}

			// 1. Ensure the mandatory api-version query parameter is present.
			if (!/[?&]api-version=/.test(finalUrl)) {
				finalUrl += (finalUrl.includes("?") ? "&" : "?") + "api-version=" + encodeURIComponent(target.apiVersion);
			}

			// 2. Move the bearer token into the Azure `api-key` header.
			const auth = headers.get("authorization");
			if (auth) {
				headers.set("api-key", auth.replace(/^Bearer\s+/i, ""));
				headers.delete("authorization");
			}

			// 3. Clean payload model if present
			let body = init?.body;
			if (typeof body === "string") {
				try {
					const payload = JSON.parse(body) as Record<string, unknown>;
					if (typeof payload.model === "string" && payload.model) {
						let cleanModel = payload.model;
						if (cleanModel.startsWith("octo-router/")) {
							cleanModel = cleanModel.slice("octo-router/".length);
						} else if (cleanModel.startsWith("bosch-genai/")) {
							cleanModel = cleanModel.slice("bosch-genai/".length);
						}
						payload.model = cleanModel;
						body = JSON.stringify(payload);
					}
				} catch {
					// Leave body untouched on parse failure
				}
			}

			return origFetch.call(globalThis, finalUrl, { ...init, body, headers });
		}

		if (target.kind === "vertex-google") {
			const key = headers.get("x-goog-api-key");
			if (key && !headers.get("authorization")) {
				headers.set("authorization", `Bearer ${key}`);
			}
			console.log(`[octo-router] google → ${url}`);
			return origFetch.call(globalThis, url, { ...init, headers });
		}

		if (target.kind === "vertex-anthropic") {
			const key = headers.get("x-api-key");
			if (key) {
				headers.set("authorization", `Bearer ${key}`);
				headers.delete("x-api-key");
			}
			let finalUrl = url;
			let body = init?.body;
			const messagesIdx = url.indexOf("/v1/messages");
			if (messagesIdx >= 0 && typeof body === "string") {
				try {
					const payload = JSON.parse(body) as Record<string, unknown>;
					const model =
						typeof payload.model === "string" && payload.model ? payload.model : target.modelId;
					if (model) {
						let cleanModel = model;
						if (cleanModel.startsWith("octo-router/")) {
							cleanModel = cleanModel.slice("octo-router/".length);
						} else if (cleanModel.startsWith("bosch-genai/")) {
							cleanModel = cleanModel.slice("bosch-genai/".length);
						}
						if (!url.includes("sap-ai-core")) {
							delete payload.model; // Vertex routes by URL; a body model field is rejected.
						} else {
							payload.model = cleanModel; // SAP AI Core requires the model field in the body.
						}
						payload.anthropic_version = "vertex-2023-10-16";
						const method = payload.stream === true ? "streamRawPredict" : "rawPredict";
						delete payload.stream; // Vertex rejects stream in body
						finalUrl = `${url.slice(0, messagesIdx)}/models/${encodeURIComponent(cleanModel)}:${method}`;
						body = JSON.stringify(payload);
						console.log(`[octo-router] vertex-anthropic → ${finalUrl}`);
					}
				} catch {
					// Leave request untouched on parse failure
				}
			}
			return injectSseEvents(origFetch.call(globalThis, finalUrl, { ...init, body, headers }), isStreaming);
		}

		if (target.kind === "bedrock-anthropic") {
			console.log("[DEBUG-interceptor] Entering bedrock-anthropic fetch interceptor. Original URL:", url);
			const key = headers.get("x-api-key");
			if (key) {
				headers.set("authorization", `Bearer ${key}`);
				headers.delete("x-api-key");
			}
			let finalUrl = url;
			let body = init?.body;
			const messagesIdx = url.indexOf("/v1/messages");
			if (messagesIdx >= 0 && typeof body === "string") {
				try {
					const payload = JSON.parse(body) as Record<string, unknown>;
					const model =
						typeof payload.model === "string" && payload.model ? payload.model : target.modelId;
					if (model) {
						let cleanModel = model;
						if (cleanModel.startsWith("octo-router/")) {
							cleanModel = cleanModel.slice("octo-router/".length);
						} else if (cleanModel.startsWith("bosch-genai/")) {
							cleanModel = cleanModel.slice("bosch-genai/".length);
						}
						
						payload.anthropic_version = "bedrock-2023-05-31";
						const method = payload.stream === true ? "invoke-with-response-stream" : "invoke";
						delete payload.stream; // Bedrock rejects stream in body
						
						if (url.includes("sap-ai-core")) {
							payload.model = cleanModel; // SAP AI Core requires the model field in the body.
							// For SAP AI Core, reconstructed URL is just base + "/" + method (no model or models in path!)
							finalUrl = `${url.slice(0, messagesIdx)}/${method}`;
						} else {
							delete payload.model; // Standard Bedrock/Gateway rejects model in body
							if (url.includes("bedrock-runtime")) {
								// Standard Bedrock format: /model/{modelId}/invoke or /invoke-with-response-stream
								finalUrl = `${url.slice(0, messagesIdx)}/model/${encodeURIComponent(cleanModel)}/${method}`;
							} else {
								// Gateway publisher style: /models/{modelId}:invoke or :invoke-with-response-stream
								finalUrl = `${url.slice(0, messagesIdx)}/models/${encodeURIComponent(cleanModel)}:${method}`;
							}
						}
						body = JSON.stringify(payload);
						console.log(`[octo-router] bedrock-anthropic → ${finalUrl}`);
					}
				} catch (err) {
					console.error("[DEBUG-interceptor] Failed to parse request body:", err);
				}
			}
			console.log("[DEBUG-interceptor] Final constructed URL:", finalUrl);
			console.log("[DEBUG-interceptor] Final request headers:", JSON.stringify(Object.fromEntries(headers.entries())));
			console.log("[DEBUG-interceptor] Final request body:", body);

			return injectSseEvents(origFetch.call(globalThis, finalUrl, { ...init, body, headers }).then((res) => {
				console.log("[DEBUG-interceptor] Received response status:", res.status);
				console.log("[DEBUG-interceptor] Received response headers:", JSON.stringify(Object.fromEntries(res.headers.entries())));
				return res;
			}).catch((err) => {
				console.error("[DEBUG-interceptor] Network request failed:", err);
				throw err;
			}), isStreaming);
		}

		return origFetch.call(globalThis, url, { ...init, headers });
	};
}

function injectSseEvents(p: Promise<Response>, isStreaming: boolean): Promise<Response> {
	if (!isStreaming) return p;
	return p.then((res) => {
		if (!res.ok || !res.body) return res;
		
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		const encoder = new TextEncoder();
		let buffer = "";

		const stream = new ReadableStream({
			async pull(controller) {
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						if (buffer.trim()) {
							const processed = processSseBuffer(buffer);
							if (processed.chunk) controller.enqueue(processed.chunk);
						}
						controller.close();
						break;
					}
					
					buffer += decoder.decode(value, { stream: true });
					const processed = processSseBuffer(buffer);
					buffer = processed.rest;
					if (processed.chunk) {
						controller.enqueue(processed.chunk);
						break; // Yield control back to consumer
					}
				}
			},
			cancel() {
				void reader.cancel();
			}
		});

		const newHeaders = new Headers(res.headers);
		newHeaders.set("content-type", "text/event-stream; charset=utf-8");

		return new Response(stream, {
			status: res.status,
			statusText: res.statusText,
			headers: newHeaders
		});
	});
}

function processSseBuffer(buffer: string): { chunk: Uint8Array | null, rest: string } {
	const encoder = new TextEncoder();
	let output = "";
	let rest = buffer;
	
	while (true) {
		const boundary = rest.indexOf("\n");
		if (boundary < 0) break;
		
		const line = rest.slice(0, boundary).trim();
		rest = rest.slice(boundary + 1);
		
		// If the line starts with data: and doesn't have a matching event: prefix line before it,
		// we inject the matching event: <type> header dynamically on the fly!
		if (line.startsWith("data: ")) {
			const dataVal = line.slice("data: ".length).trim();
			try {
				const parsed = JSON.parse(dataVal) as Record<string, any>;
				const type = parsed.type;
				if (typeof type === "string") {
					output += `event: ${type}\n${line}\n\n`;
					continue;
				}
			} catch {
				// Ignore JSON parse error and pass through as-is
			}
		}
		
		if (line) {
			output += line + "\n";
		} else {
			output += "\n";
		}
	}
	
	return {
		chunk: output ? encoder.encode(output) : null,
		rest
	};
}
