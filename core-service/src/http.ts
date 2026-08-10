import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { Dirent, type Stats, appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "path";
import {
	getModel,
	getModels,
	cancelAcpJob,
	connectorHomeHasFiles,
	ensureConnectorHome,
	getConnectorHome,
	getConnectorRuntime,
	getProviderAuthStatus,
	listAcpJobs,
	listConnectorRuntimes,
	loginProvider,
	resolveWebSearchConfig,
	safeConnectorUserId,
	SessionStateStore,
	TOOL_CATALOG,
	type ConnectorRuntime,
} from "@octo/core-agent";
import express from "express";
import JSZip from "jszip";
import { CoreServiceAuth } from "./auth.js";
import { getAppHeader, getAppTitle } from "./branding.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { prepareBoschAnthropicEndpoint, prepareBoschGoogleEndpoint, prepareBoschOpenAIEndpoint } from "./extensions/bosch-genai-adapter.js";
import { GithubSsoProvider, loadSsoConfig } from "./sso.js";
import type { ObjectStoreGateway } from "./object-store.js";
import {
	ADT_TREE_FILE,
	LOCAL_OBJECTS_ROOT,
	applyPlan,
	initialManifest,
	manifestView,
	planChildren,
	readManifest,
	writeManifest,
	type AdtListResult,
} from "./sapTree.js";
import { listLocalSapSystems, type SapLocalSystem } from "./sapLandscape.js";
import * as log from "./log.js";
import { getWorkspaceSandboxStatus } from "./sandbox-manager.js";
import type { BotContext, BotHandler } from "./types.js";
import { truncateToolResult, type AgentTrailEvent, type AgentUsage } from "./agent-events.js"; 
import { TrailStore, readTrail } from "./trail-store.js";
import { WorkspaceDatabase } from "./workspace-database.js";
import { WorkspaceStore } from "./workspaces.js";
import type { SapConnection, WorkspaceRole } from "./workspaces.js";
import type { SandboxConfig } from "@octo/core-agent";

const localRequire = createRequire(import.meta.url);

interface SapRemoteDest {
	Name: string;
	Type?: string;
	URL?: string;
	Authentication?: string;
	ProxyType?: string;
	Description?: string;
}

// ============================================================================
// HTTP context adapter
// ============================================================================

type SseEmitter = (event: object) => void;

interface PendingAuthLogin {
	userId: string;
	status: "pending" | "complete" | "error";
	createdAt: number;
	url?: string;
	instructions?: string;
	userCode?: string;
	verificationUri?: string;
	error?: string;
	resolveManualCode?: (value: string) => void;
	rejectManualCode?: (err: Error) => void;
}

const LLM_KEY_PROVIDERS: ReadonlyArray<{ id: string; label: string }> = [
	{ id: "openai", label: "OpenAI" },
	{ id: "google", label: "Google Gemini" },
	{ id: "anthropic", label: "Anthropic" },
];
type ConnectorLoginMode = NonNullable<ConnectorRuntime["loginModes"]>[number];
type JsonObject = Record<string, unknown>;

interface PendingAgentWorkerLogin {
	userId: string;
	connectorId: string;
	status: "pending" | "complete" | "error";
	createdAt: number;
	output: string;
	url?: string;
	error?: string;
	child?: ChildProcessWithoutNullStreams;
	autoConfirmed?: boolean;
}

const BINARY_MIME_TYPES: Record<string, string> = {
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	ppt: "application/vnd.ms-powerpoint",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	xls: "application/vnd.ms-excel",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	zip: "application/zip",
};

/**
 * An `@`-mention from the composer: a scope plus a path relative to it. Deliberately
 * not a filesystem path — the server maps the scope to a root itself, so a client
 * cannot name a location the scopes do not reach.
 */
type MentionPayload = { scope?: "artifacts" | "attachments"; path?: string };

/** More than this in one message is a mistake, not an intent. */
const MAX_MENTIONS = 20;

/** Same reasoning for `/skill` invocations: a message driven by ten skills has no driver. */
const MAX_SKILL_INVOCATIONS = 5;

// Skill folder upload limits. The Express JSON body cap (50mb of base64 is roughly
// 37mb of bytes) is the hard ceiling, so stay well below it.
const MAX_SKILL_UPLOAD_FILES = 500;
const MAX_SKILL_UPLOAD_BYTES = 25 * 1024 * 1024;
// Junk that folder pickers hand over but a skill never needs.
const SKILL_UPLOAD_SKIP_NAMES = new Set([".DS_Store", "Thumbs.db"]);
const SKILL_UPLOAD_SKIP_DIRS = new Set([".git", "node_modules"]);

export function createHttpContext(opts: {
	channelId: string;
	userName: string;
	text: string;
	ts: string;
	send: SseEmitter;
	workingDir: string;
	attachments?: Array<{ local: string }>;
	mentions?: Array<{ local: string; type: "file" | "directory" }>;
	skills?: Array<{ name: string; local: string }>;
	userId?: string;
	authFilePath?: string;
	model?: { provider: string; modelId: string; apiKey?: string; baseUrl?: string; apiType?: string };
	structured?: boolean;
}): BotContext {
	const { channelId, userName, text, ts, send, workingDir, attachments = [], mentions = [], skills = [], userId = "web-user", authFilePath, model, structured = false } = opts;

	const logToFile = (entry: object) => {
		const dir = join(workingDir, "sessions", channelId);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	};

	let emitAgentEvent: ((event: AgentTrailEvent) => void) | undefined;
	let flushAgentEvents: (() => void) | undefined;
	if (structured) {
		const trailStore = new TrailStore(join(workingDir, "sessions", channelId), ts);
		const FLUSH_MS = 40;
		const FLUSH_CHARS = 2048;
		let seq = 0;
		const nextSeq = () => ++seq;
		const pendingDeltas = new Map<string, { kind: "text" | "thinking"; delta: string }>();
		let flushTimer: ReturnType<typeof setTimeout> | null = null;

		const flushDeltas = () => {
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
			for (const [blockId, p] of pendingDeltas) {
				send({ type: "block", seq: nextSeq(), phase: "delta", blockId, kind: p.kind, delta: p.delta });
			}
			pendingDeltas.clear();
		};

		emitAgentEvent = (event: AgentTrailEvent) => {
			if (event.type === "block" && event.phase === "delta") {
				const pending = pendingDeltas.get(event.blockId);
				if (pending) pending.delta += event.delta;
				else pendingDeltas.set(event.blockId, { kind: event.kind, delta: event.delta });
				if ((pendingDeltas.get(event.blockId)?.delta.length ?? 0) >= FLUSH_CHARS) {
					flushDeltas();
				} else if (!flushTimer) {
					flushTimer = setTimeout(flushDeltas, FLUSH_MS);
				}
				return;
			}
			// Flush buffered deltas before any non-delta event to preserve total order.
			flushDeltas();
			const stamped = { ...event, seq: nextSeq() } as AgentTrailEvent;
			trailStore.append(stamped);
			if (stamped.type === "tool" && stamped.phase === "end") {
				const { text: resultText, truncated } = truncateToolResult(stamped.result);
				send({ ...stamped, result: resultText, resultTruncated: truncated });
			} else if (stamped.type === "tool" && stamped.phase === "update") {
				send({ ...stamped, partialResult: truncateToolResult(stamped.partialResult).text });
			} else {
				send(stamped);
			}
		};
		flushAgentEvents = flushDeltas;
	}

	return {
		message: {
			text,
			rawText: text,
			user: userId,
			userName,
			channel: channelId,
			ts,
			attachments,
			mentions,
			skills,
		},
		authFilePath,
		model,
		channelName: channelId,
		channels: [{ id: channelId, name: channelId }],
		users: [{ id: userId, userName, displayName: userName }],

		respond: async (responseText: string, shouldLog = true) => {
			if (!structured) send({ type: "delta", text: responseText });
			if (shouldLog) {
				const responseTs = (Date.now() / 1000).toFixed(6);
				logToFile({ date: new Date().toISOString(), ts: responseTs, user: "bot", text: responseText, attachments: [], isBot: true });
			}
		},

		replaceMessage: async (responseText: string) => {
			send({ type: "replace", text: responseText });
			const responseTs = (Date.now() / 1000).toFixed(6);
			logToFile({ date: new Date().toISOString(), ts: responseTs, user: "bot", text: responseText, attachments: [], isBot: true, isFinal: true });
		},

		respondInThread: async (responseText: string) => {
			if (!structured) send({ type: "thread", text: responseText });
			const responseTs = (Date.now() / 1000).toFixed(6);
			logToFile({ date: new Date().toISOString(), ts: responseTs, user: "bot", text: responseText, attachments: [], isBot: true, isThread: true });
		},

		setTyping: async (isTyping: boolean) => {
			send({ type: "status", status: isTyping ? "thinking" : "idle" });
		},

		uploadFile: async (filePath: string, title?: string) => {
			send({ type: "file", path: filePath, title });
		},

		setWorking: async (working: boolean) => {
			send({ type: "status", status: working ? "working" : "idle" });
		},

		deleteMessage: async () => {
			send({ type: "delete" });
		},

		emitAgentEvent,
		flushAgentEvents,
	};
}

// ============================================================================
// HTTP SSE Server
// ============================================================================

/**
 * HTTP server that exposes the bot via Server-Sent Events.
 *
 * Endpoints:
 *   POST /chat              – { channelId, text, userName? }  → SSE stream
 *   POST /stop              – { channelId }                   → { ok, message }
 *   GET  /status/:channelId                                   → { running }
 *   GET  /sessions                                            → SessionInfo[]
 *   GET  /messages/:channelId                                 → ChatMessage[]
 *   GET  /file?path=...                                       → raw file
 *   GET  /artifact-url?path=...                               → { url }
 *   GET  /artifacts/*                                         → static files from {workingDir}/artifacts/
 *
 * SSE event shapes:
 *   { type: "status",  status: "thinking"|"working"|"idle"|"stopped" }
 *   { type: "delta",   text: string }
 *   { type: "replace", text: string }
 *   { type: "thread",  text: string }
 *   { type: "file",    path: string, title?: string }
 *   { type: "delete" }
 *   { type: "done",    stopReason: string }
 *   { type: "error",   message: string }
 *
 * IYH1HC stream add — structured trail events (only when the client POSTs structured:true;
 * `delta`/`thread` are then suppressed, all other legacy events keep flowing):
 *   { type: "turn",   seq, phase: "start"|"end", turnIndex, ts }
 *   { type: "block",  seq, phase: "start"|"delta"|"end", blockId, kind: "text"|"thinking", delta?/content?, ts? }
 *   { type: "tool",   seq, phase: "call"|"start"|"update"|"end", toolCallId, toolName, args?, label?,
 *                     partialResult?, result?, resultTruncated?, isError?, durationMs?, ts? }
 *   { type: "skill",  seq, name, path, toolCallId, ts }
 *   { type: "usage",  seq, scope: "message"|"run", usage: {input,output,cacheRead,cacheWrite,cost}, contextTokens?, contextWindow? }
 *   { type: "compaction", seq, phase: "start"|"end", reason?, tokensBefore?, aborted? }
 *   { type: "retry",  seq, attempt, maxAttempts, errorMessage? }
 * Full definitions: ./agent-events.ts; audit persistence: ./trail-store.ts (trail.jsonl).
 */
export class HttpServer {
	private port: number;
	private workingDir: string;
	// Injected by finishStart() — they depend on a restored data root, which is not
	// available yet when the port is opened.
	private handler!: BotHandler;
	private workspaceStore!: WorkspaceStore;
	private sandboxConfig: SandboxConfig;
	private features: { agentWorkers: boolean; reminders: boolean; connection: boolean; tools: boolean; llmProviders: string[] | null; appTitle: string; appHeader: string };
	private auth: CoreServiceAuth;
	private pendingAuthLogins = new Map<string, PendingAuthLogin>();
	private sso: GithubSsoProvider | null;
	private pendingAgentWorkerLogins = new Map<string, PendingAgentWorkerLogin>();
	private getObjectStoreStatus?: () => unknown;
	private objectStore?: ObjectStoreGateway;
	private app?: express.Express;
	// Flipped by finishStart(). Until then every route except /health answers 503:
	// the port is open from the first moment so the platform health check passes, but
	// nothing is served off a data root that is still being restored.
	private ready = false;
	private phase = "starting";

	constructor(config: { port: number; workingDir: string; sandboxConfig: SandboxConfig; features?: { agentWorkers?: boolean; reminders?: boolean; connection?: boolean; tools?: boolean; llmProviders?: string[] | null; appTitle?: string; appHeader?: string } }) {
		this.port = config.port;
		this.workingDir = config.workingDir;
		this.sandboxConfig = config.sandboxConfig;
		this.features = {
			agentWorkers: config.features?.agentWorkers !== false,
			reminders: config.features?.reminders !== false,
			connection: config.features?.connection !== false,
			tools: config.features?.tools !== false,
			llmProviders: config.features?.llmProviders ?? null,
			appTitle: config.features?.appTitle ?? getAppTitle(),
			appHeader: config.features?.appHeader ?? getAppHeader(),
		};
		this.auth = new CoreServiceAuth(config.workingDir);
		const ssoConfig = loadSsoConfig();
		this.sso = ssoConfig ? new GithubSsoProvider(ssoConfig) : null;
		if (this.sso) log.logInfo(`SSO enabled: ${ssoConfig?.provider} (${ssoConfig?.label})`);
	}

	/**
	 * Phase 1 — open the port straight away, before the data root is restored.
	 *
	 * The boot used to bind only after the whole object-store tree had been downloaded,
	 * so a tree that took longer than Cloud Foundry's startup health check (60s by
	 * default) got the app killed before it ever listened. Binding first decouples
	 * "process is alive" from "data is ready", whatever the tree grows to.
	 *
	 * Only the readiness probe is answered until finishStart() runs; everything else
	 * gets 503 so no request is ever served off a half-restored data root.
	 */
	startListening(): void {
		const app = express();
		this.app = app;
		app.use(express.json({ limit: "50mb" }));

		// CORS goes on before the readiness gate so a warm-up 503 still reaches the
		// browser as a 503 rather than as an opaque CORS failure.
		app.use((_req, res, next) => {
			const origin = _req.header("Origin");
			res.setHeader("Access-Control-Allow-Origin", origin || "*");
			res.setHeader("Access-Control-Allow-Methods", "POST, GET, PATCH, PUT, DELETE, OPTIONS");
			res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-User-Id, Authorization");
			res.setHeader("Access-Control-Allow-Credentials", "true");
			next();
		});
		app.options("/{*path}", (_req, res) => { res.sendStatus(204); });

		// Readiness gate. A middleware (not a catch-all route) so the real routes
		// registered later by finishStart() are not shadowed by it.
		app.use((req, res, next) => {
			if (this.ready || req.path === "/health") {
				next();
				return;
			}
			res.status(503).json({ error: "warming up", phase: this.phase });
		});

		app.get("/health", (_req, res) => {
			const status = this.getObjectStoreStatus?.() as Record<string, unknown> | undefined;
			res.json({ ok: true, ready: this.ready, phase: this.phase, objectStore: status ?? null });
		});

		app.listen(this.port, () => {
			log.logInfo(`HTTP server listening on port ${this.port} (warming up — routes answer 503 until ready)`);
		});
	}

	setPhase(phase: string): void {
		this.phase = phase;
	}

	/**
	 * Phase 2 — mount the real routes onto the already-listening server and go ready.
	 * Express allows registering routes after listen(), so this needs no rebind.
	 */
	async finishStart(deps: {
		workspaceStore: WorkspaceStore;
		handler: BotHandler;
		objectStore?: ObjectStoreGateway;
		getObjectStoreStatus?: () => unknown;
	}): Promise<void> {
		this.workspaceStore = deps.workspaceStore;
		this.handler = deps.handler;
		this.objectStore = deps.objectStore;
		this.getObjectStoreStatus = deps.getObjectStoreStatus;

		const app = this.app;
		if (!app) throw new Error("finishStart() called before startListening()");

		this.phase = "opening auth store";
		await this.auth.init();
		this.phase = "mounting routes";

		// CORS and the JSON body parser are already mounted by startListening().
		app.use(this.auth.initialize());

		// Static artifact files — serves {workingDir}/artifacts/ at /artifacts/
		const artifactsDir = join(this.workingDir, "artifacts");

		app.post("/auth/register", (req, res) => this.auth.register(req, res));
		app.post("/auth/login", (req, res, next) => this.auth.login(req, res, next));
		app.get("/auth/me", (req, res, next) => this.auth.requireAuth(req, res, next), (req, res) => this.auth.me(req, res));
		app.post("/auth/logout", (req, res, next) => this.auth.requireAuth(req, res, next), (req, res) => this.auth.logout(req, res));

		app.get("/auth/sso/config", (req, res) => this.handleSsoConfig(req, res));
		app.get("/auth/sso/login", (req, res) => this.handleSsoLogin(req, res));
		app.get("/auth/sso/callback", (req, res) => { void this.handleSsoCallback(req, res); });

		app.get("/objectstore/status", (_req, res) => {
			const status = this.getObjectStoreStatus?.();
			res.json(status ? { mode: "mirror", ...status } : { mode: "ephemeral" });
		});

		app.use((req, res, next) => this.auth.requireAuth(req, res, next));
		app.use("/artifacts", express.static(artifactsDir, { fallthrough: false }));
		// Everything below reads workspace content off disk, so the mirror for that
		// workspace has to be materialized first.
		app.use(this.hydrateWorkspaceMiddleware());

		// API routes
		app.get("/features", (_req, res) => this.handleFeatures(res));
		app.get("/workspaces",      (req, res) => this.handleWorkspaces(req, res));
		app.get("/workspace-templates", (_req, res) => res.json(this.workspaceStore.listWorkspaceTemplates()));
		app.post("/workspaces",     (req, res) => this.handleCreateWorkspace(req, res));
		app.get("/workspaces/:workspaceId/settings", (req, res) => this.handleWorkspaceSettings(req, res));
		app.patch("/workspaces/:workspaceId/settings", (req, res) => this.handleUpdateWorkspaceSettings(req, res));
		app.get("/workspaces/:workspaceId/sap-adt/destinations", (req, res) => { void this.handleSapListDestinations(req, res); });
		app.get("/workspaces/:workspaceId/sap-adt/local-systems", (req, res) => { void this.handleSapListLocalSystems(req, res); });
		app.post("/workspaces/:workspaceId/sap-adt/connections", (req, res) => { void this.handleSapCreateConnection(req, res); });
		app.delete("/workspaces/:workspaceId/sap-adt/connections/:name", (req, res) => { void this.handleSapDeleteConnection(req, res); });
		app.post("/workspaces/:workspaceId/sap-adt/connections/:name/test", (req, res) => { void this.handleSapTestConnection(req, res); });
		app.get("/workspaces/:workspaceId/sap-adt/connections/:name/nodes", (req, res) => { void this.handleSapListNodes(req, res); });
		app.get("/workspaces/:workspaceId/sap-adt/connections/:name/source", (req, res) => { void this.handleSapGetSource(req, res); });
		app.post("/workspaces/:workspaceId/sap-adt/connections/:name/tree/expand", (req, res) => { void this.handleSapExpandTree(req, res); });
		app.post("/workspaces/:workspaceId/sap-adt/connections/:name/tree/hydrate", (req, res) => { void this.handleSapHydrateFile(req, res); });
		app.get("/workspaces/:workspaceId/sap-adt/connections/:name/tree/manifest", (req, res) => { void this.handleSapTreeManifest(req, res); });
		app.get("/workspaces/:workspaceId/sandbox", (req, res) => { void this.handleWorkspaceSandbox(req, res); });
		app.get("/workspaces/:workspaceId/events", (req, res) => this.handleWorkspaceEvents(req, res));
		app.delete("/workspaces/:workspaceId/events/:filename", (req, res) => this.handleDeleteWorkspaceEvent(req, res));
		app.get("/database/tables", (req, res) => this.handleDatabaseTables(req, res));
		app.get("/database/tables/:tableName/rows", (req, res) => this.handleDatabaseRows(req, res));
		app.get("/auth/openai-codex/status", (req, res) => this.handleAuthStatus(req, res));
		app.post("/auth/openai-codex/login", (req, res) => { void this.handleCodexLogin(req, res); });
		app.get("/auth/openai-codex/login/:loginId", (req, res) => this.handleCodexLoginStatus(req, res));
		app.post("/auth/openai-codex/login/:loginId/code", (req, res) => this.handleCodexLoginCode(req, res));
		app.get("/tools", (req, res) => this.handleToolCatalog(req, res));
		app.get("/llm/config", (req, res) => this.handleLlmConfig(req, res));
		app.get("/llm/active-models", (req, res) => this.handleLlmActiveModels(req, res));
		app.put("/llm/providers/:provider/key", (req, res) => this.handleSetProviderKey(req, res));
		app.delete("/llm/providers/:provider/key", (req, res) => this.handleDeleteProviderKey(req, res));
		app.put("/llm/providers/:provider/models", (req, res) => this.handleSetActiveModels(req, res));
		app.get("/llm/custom-models", (req, res) => this.handleListCustomModels(req, res));
		app.post("/llm/custom-models", (req, res) => this.handleCreateCustomModel(req, res));
		app.put("/llm/custom-models/:id", (req, res) => this.handleUpdateCustomModel(req, res));
		app.delete("/llm/custom-models/:id", (req, res) => this.handleDeleteCustomModel(req, res));
		app.get("/auth/connectors", (req, res) => this.handleConnectors(req, res));
		app.get("/auth/connectors/:connector/status", (req, res) => this.handleConnectorStatus(req, res));
		app.post("/auth/connectors/:connector/login", (req, res) => this.handleConnectorLogin(req, res));
		app.get("/auth/connectors/:connector/login/:loginId", (req, res) => this.handleConnectorLoginStatus(req, res));
		app.post("/auth/connectors/:connector/login/:loginId/input", (req, res) => this.handleConnectorLoginInput(req, res));
		app.post("/auth/connectors/:connector/logout", (req, res) => this.handleConnectorLogout(req, res));
		app.post("/connectors/:connector/exec", (req, res) => this.handleConnectorExec(req, res));
		app.get("/auth/agent-workers", (req, res) => this.handleAgentWorkers(req, res));
		app.get("/auth/agent-workers/:agent/status", (req, res) => this.handleAgentWorkerStatus(req, res));
		app.post("/auth/agent-workers/:agent/login", (req, res) => this.handleAgentWorkerLogin(req, res));
		app.get("/auth/agent-workers/:agent/login/:loginId", (req, res) => this.handleAgentWorkerLoginStatus(req, res));
		app.post("/auth/agent-workers/:agent/login/:loginId/input", (req, res) => this.handleAgentWorkerLoginInput(req, res));
		app.post("/auth/agent-workers/:agent/logout", (req, res) => this.handleAgentWorkerLogout(req, res));
		app.get("/workspaces/:workspaceId/sessions", (req, res) => this.handleWorkspaceSessions(req, res));
		app.post("/workspaces/:workspaceId/sessions", (req, res) => this.handleCreateSession(req, res));
		app.post("/workspaces/:workspaceId/skills", (req, res) => this.handleUploadSkill(req, res));
		app.post("/sessions/:sessionId/messages", (req, res) => { void this.handleChat(req, res, req.params.sessionId); });
		app.post("/chat",           (req, res) => { void this.handleChat(req, res); });
		app.post("/stop",           (req, res) => { void this.handleStop(req, res); });
		app.get("/status/:id",      (req, res) => this.handleStatus(req, req.params.id, res));
		app.get("/sessions/:id/mode", (req, res) => this.handleSessionMode(req, decodeURIComponent(req.params.id), res));
		app.patch("/sessions/:id/mode", (req, res) => this.handleSetSessionMode(req, decodeURIComponent(req.params.id), res));
		app.get("/sessions/:id/acp-jobs", (req, res) => this.handleAcpJobs(req, decodeURIComponent(req.params.id), res));
		app.post("/sessions/:id/acp-jobs/:jobId/cancel", (req, res) => this.handleCancelAcpJob(req, decodeURIComponent(req.params.id), decodeURIComponent(req.params.jobId), res));
		app.get("/sessions",        (req, res) => this.handleSessions(req, res));
		app.delete("/sessions/:id", (req, res) => { void this.handleDeleteSession(req, decodeURIComponent(req.params.id), res); });
		app.delete("/workspaces/:workspaceId/sessions/:sessionId", (req, res) => { void this.handleDeleteSession(req, decodeURIComponent(req.params.sessionId), res); });
		app.get("/messages/:id",    (req, res) => this.handleMessages(req, decodeURIComponent(req.params.id), res));
		app.get("/sessions/:id/messages", (req, res) => this.handleMessages(req, decodeURIComponent(req.params.id), res));
		app.get("/file",            (req, res) => this.handleFile(req, String(req.query.path ?? ""), res));
		app.delete("/file",         (req, res) => this.handleDeleteFile(req, String(req.query.path ?? ""), res));
		app.get("/artifact-url",    (req, res) => this.handleArtifactUrl(req, String(req.query.path ?? ""), res));
		app.get("/workspace/:id",   (req, res) => this.handleWorkspace(req, decodeURIComponent(req.params.id), res));
		app.get("/sessions/:id/workspace", (req, res) => this.handleWorkspace(req, decodeURIComponent(req.params.id), res));

		this.phase = "ready";
		this.ready = true;
		log.logInfo(`HTTP SSE server ready on port ${this.port}`);
		log.logInfo(`Artifacts served from: ${artifactsDir}`);
	}

	/**
	 * Pulls a workspace's mirrored content down the first time a request touches it.
	 *
	 * Boot only restores the metadata skeleton (see isBootCritical in object-store.ts),
	 * so the bulk of a workspace — session logs, artifacts, events, skills — has to
	 * arrive before a handler reads it off disk. Doing it in one middleware keeps the
	 * handlers unaware of the mirror, and hydrateWorkspace() is memoized so this costs
	 * nothing after the first hit.
	 */
	private hydrateWorkspaceMiddleware(): express.Handler {
		return (req, res, next) => {
			const store = this.objectStore;
			if (!store) {
				next();
				return;
			}
			const workspaceId = this.resolveWorkspaceForHydration(req);
			if (!workspaceId) {
				next();
				return;
			}
			void store
				.hydrateWorkspace(workspaceId)
				.then(() => next())
				.catch((err) => {
					// Serving a half-empty workspace would look like data loss to the
					// user, so fail the request loudly instead.
					log.logWarning(`[object-store] hydrate failed for ${workspaceId}`, err instanceof Error ? err.message : String(err));
					res.status(503).json({ error: "Workspace content is temporarily unavailable" });
				});
		};
	}

	/**
	 * Best-effort workspace id for the request being served. This runs as app-level
	 * middleware, where `req.params` is not populated yet, so the path is matched by
	 * hand. Returning undefined simply means "nothing to hydrate".
	 */
	private resolveWorkspaceForHydration(req: express.Request): string | undefined {
		// /workspaces/<workspaceId>/...
		const byPath = /^\/workspaces\/([^/]+)/.exec(req.path);
		if (byPath) return decodeURIComponent(byPath[1]);

		const body = (req.body ?? {}) as { workspaceId?: string; sessionId?: string; channelId?: string };
		if (typeof body.workspaceId === "string" && body.workspaceId) return body.workspaceId;
		if (typeof req.query.workspaceId === "string" && req.query.workspaceId) return req.query.workspaceId;

		// ?path=workspaces/<workspaceId>/... — /file, /artifact-url, /database/*
		const queryPath = typeof req.query.path === "string" ? req.query.path : undefined;
		const byQueryPath = queryPath ? /^\/?workspaces[\\/]([^\\/]+)/.exec(queryPath) : null;
		if (byQueryPath) return byQueryPath[1];

		// Session-scoped routes. Note /workspace/<id> (singular) also takes a SESSION
		// id, not a workspace id — see handleWorkspace.
		const bySession = /^\/(?:sessions|messages|status|workspace)\/([^/]+)/.exec(req.path);
		const sessionId = bySession ? decodeURIComponent(bySession[1]) : (body.sessionId ?? body.channelId);
		if (sessionId) {
			// session.json is part of the boot set, so this lookup works without the
			// workspace being hydrated yet.
			return this.workspaceStore.findSession(sessionId)?.workspaceId;
		}

		// GET /sessions with no workspaceId lists the user's default workspace
		// (handleSessions). Its previews and message counts come from each session's
		// log.jsonl, which is deferred content — so resolve the same workspace the
		// handler will. listWorkspaces is read-only; unlike ensureDefaultWorkspace it
		// never creates one as a side effect of routing.
		if (req.path === "/sessions") return this.workspaceStore.listWorkspaces(this.getUserId(req))[0]?.id;

		return undefined;
	}

	// ==========================================================================
	// Handlers
	// ==========================================================================

	private getUserId(req: express.Request, fallback?: string): string {
		return String(req.user?.id || req.header("x-user-id") || req.query.userId || fallback || "web-user");
	}

	private getUserName(req: express.Request, fallback?: string): string {
		return String(req.user?.displayName || req.user?.email || fallback || "user");
	}

	private getUserAuthFilePath(userId: string): string {
		const safeUserId = userId.replace(/[^a-zA-Z0-9._-]/g, "_") || "web-user";
		const dir = join(this.workingDir, "users", safeUserId);
		mkdirSync(dir, { recursive: true });
		return join(dir, "auth.json");
	}

	/**
	 * The containment check behind every path a client supplies: normalize, require
	 * the result to sit inside `<dataRoot>/workspaces/<wsId>/`, and require the user
	 * to be a member of that workspace.
	 *
	 * Pure — it reports a failure instead of writing one. Route handlers that serve a
	 * single file want an HTTP response (see `resolveReadableWorkspaceFile`), but
	 * validating a *list* of paths must be able to drop one entry and keep going.
	 */
	private resolveWorkspacePathForUser(
		req: express.Request,
		filePath: string,
	): { ok: true; resolved: string; workspaceId: string } | { ok: false; status: number; error: string } {
		if (!filePath) return { ok: false, status: 400, error: "Missing path" };

		const root = resolve(this.workingDir);
		const resolved = resolve(isAbsolute(filePath) ? filePath : join(this.workingDir, filePath));

		const relFromRoot = relative(root, resolved);
		if (relFromRoot === "" || relFromRoot.startsWith("..") || isAbsolute(relFromRoot)) {
			return { ok: false, status: 403, error: "Forbidden" };
		}

		const workspaceRoot = resolve(join(this.workingDir, "workspaces"));
		const relFromWorkspaces = relative(workspaceRoot, resolved);
		if (relFromWorkspaces === "" || relFromWorkspaces.startsWith("..") || isAbsolute(relFromWorkspaces)) {
			return { ok: false, status: 403, error: "Forbidden" };
		}

		const workspaceId = relFromWorkspaces.split(/[\\/]/)[0];
		try {
			this.workspaceStore.assertWorkspaceAccess(this.getUserId(req), workspaceId);
		} catch (err) {
			return { ok: false, status: 403, error: err instanceof Error ? err.message : String(err) };
		}
		return { ok: true, resolved, workspaceId };
	}

	private resolveReadableWorkspaceFile(req: express.Request, filePath: string, res: express.Response): string | undefined {
		const outcome = this.resolveWorkspacePathForUser(req, filePath);
		if (!outcome.ok) {
			res.status(outcome.status).json({ error: outcome.error });
			return undefined;
		}
		return outcome.resolved;
	}

	/**
	 * Turns the `@`-mentions a client sent into workspace-relative paths the agent
	 * can resolve.
	 *
	 * The client sends a scope plus a path relative to that scope, never a
	 * filesystem path, so the server owns the mapping to a root. Every result still
	 * goes through the containment guard, because a scope-relative path can climb
	 * out with `..` just as easily. A mention that fails validation, or names
	 * something that no longer exists, is **dropped** rather than failing the whole
	 * message — the user's text is still worth delivering.
	 */
	private resolveMentions(
		req: express.Request,
		mentions: MentionPayload[],
		workspaceRoot: string,
		sessionId: string,
	): Array<{ local: string; type: "file" | "directory" }> {
		const resolved: Array<{ local: string; type: "file" | "directory" }> = [];

		for (const mention of mentions.slice(0, MAX_MENTIONS)) {
			if (!mention || typeof mention.path !== "string" || !mention.path) continue;

			const scopeRoot =
				mention.scope === "attachments" ? join("sessions", sessionId, "attachments") : "artifacts";
			const relativeToWorkspace = join(scopeRoot, mention.path);

			const outcome = this.resolveWorkspacePathForUser(req, join(workspaceRoot, relativeToWorkspace));
			if (!outcome.ok) {
				log.logWarning("[mentions] dropped", `${mention.scope}:${mention.path} (${outcome.error})`);
				continue;
			}

			// The workspace guard alone would still let `../` walk from this session's
			// attachments into a sibling session's, which is precisely the boundary
			// `glob`/`grep` refuse to cross. Require the result to stay in its scope.
			const relFromScope = relative(resolve(join(workspaceRoot, scopeRoot)), outcome.resolved);
			if (relFromScope.startsWith("..") || isAbsolute(relFromScope)) {
				log.logWarning("[mentions] dropped", `${mention.scope}:${mention.path} (outside its scope)`);
				continue;
			}

			let stat: Stats;
			try {
				stat = statSync(outcome.resolved);
			} catch {
				log.logWarning("[mentions] dropped", `${mention.scope}:${mention.path} (not found)`);
				continue;
			}

			const local = relativeToWorkspace.replace(/\\/g, "/");
			if (resolved.some((entry) => entry.local === local)) continue;
			resolved.push({ local, type: stat.isDirectory() ? "directory" : "file" });
		}

		return resolved;
	}

	/**
	 * Writes one uploaded file under the session's attachments and returns the path it was
	 * stored at, relative to that directory — or null when the client's name cannot be
	 * trusted, in which case the file is dropped rather than the message failing.
	 *
	 * A folder upload sends each file's path relative to the picked folder, so the tree is
	 * rebuilt here instead of being flattened into the filename: the agent then greps and
	 * globs it the way it would any other directory. Every segment is sanitized, `.`/`..`
	 * and drive letters are rejected outright, and the result still has to resolve inside
	 * the attachments directory. Only the first segment carries the batch stamp, so a folder
	 * stays one folder and re-uploading it does not overwrite the earlier copy.
	 */
	private storeAttachment(attachDir: string, fileName: unknown, content: unknown, stamp: number): string | null {
		const raw = String(fileName ?? "").replace(/\\/g, "/");
		const segments = raw.split("/").filter((segment) => segment !== "");
		if (segments.length === 0) return null;
		if (segments.some((segment) => segment === "." || segment === ".." || segment.includes(":"))) return null;

		const safeSegments = segments.map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, "_"));
		// Re-check after sanitizing: "…" and friends survive the character filter.
		if (safeSegments.some((segment) => segment === "." || segment === "..")) return null;
		safeSegments[0] = `${stamp}_${safeSegments[0]}`;

		const abs = resolve(join(attachDir, ...safeSegments));
		const rel = relative(resolve(attachDir), abs);
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;

		try {
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, Buffer.from(String(content ?? ""), "base64"));
		} catch (err) {
			log.logWarning("[attachments] write failed", err instanceof Error ? err.message : String(err));
			return null;
		}
		return safeSegments.join("/");
	}

	/**
	 * Turns the `/name` skill invocations a client sent into workspace-relative SKILL.md
	 * paths. Session skills override workspace skills, matching how the agent loads them.
	 *
	 * The client sends names, never paths, so the server owns the mapping — and a name that
	 * resolves to nothing is dropped with a warning rather than failing the message.
	 */
	private resolveSkills(skills: string[], workspaceRoot: string, sessionId: string): Array<{ name: string; local: string }> {
		const resolved: Array<{ name: string; local: string }> = [];

		for (const raw of skills.slice(0, MAX_SKILL_INVOCATIONS)) {
			const name = this.sanitizeConnectionName(raw);
			if (!name || name === "." || name === "..") continue;
			if (resolved.some((entry) => entry.name === name)) continue;

			const candidates = [
				join("sessions", sessionId, "skills", name),
				join("skills", name),
			];
			const scope = candidates.find((candidate) => existsSync(join(workspaceRoot, candidate, "SKILL.md")));
			if (!scope) {
				log.logWarning("[skills] dropped", `${String(raw)} (no SKILL.md)`);
				continue;
			}
			resolved.push({ name, local: `${scope.replace(/\\/g, "/")}/SKILL.md` });
		}

		return resolved;
	}

	private createLoginId(): string {
		return `login_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
	}

	private handleAuthStatus(req: express.Request, res: express.Response): void {
		const userId = this.getUserId(req);
		const status = getProviderAuthStatus(this.getUserAuthFilePath(userId), "openai-codex");
		res.json({ provider: "openai-codex", configured: status.configured, source: status.source, label: status.label });
	}

	private handleSsoConfig(_req: express.Request, res: express.Response): void {
		const hideAuthUi = process.env.CORE_SERVICE_HIDE_AUTH_UI === "true";
		if (!this.sso) {
			res.json({ enabled: false, hideAuthUi });
			return;
		}
		res.json({ enabled: true, provider: this.sso.config.provider, label: this.sso.config.label, loginUrl: "/auth/sso/login", hideAuthUi });
	}

	private handleSsoLogin(_req: express.Request, res: express.Response): void {
		if (!this.sso) {
			res.status(404).json({ error: "SSO is not enabled" });
			return;
		}
		res.redirect(this.sso.createAuthorizeUrl());
	}

	private async handleSsoCallback(req: express.Request, res: express.Response): Promise<void> {
		if (!this.sso) {
			res.status(404).json({ error: "SSO is not enabled" });
			return;
		}
		const redirectBase = this.sso.config.postLoginRedirect;
		try {
			const code = String(req.query.code ?? "");
			const state = req.query.state ? String(req.query.state) : undefined;
			if (req.query.error) throw new Error(String(req.query.error_description || req.query.error));
			if (!code) throw new Error("Missing authorization code");
			if (!this.sso.consumeState(state)) throw new Error("Invalid or expired state");

			const identity = await this.sso.resolveIdentity(code);
			const session = await this.auth.completeFederatedLogin(res, identity);
			res.redirect(`${redirectBase}/#sso_token=${encodeURIComponent(session.token)}`);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log.logWarning("[sso] callback failed", message);
			res.redirect(`${redirectBase}/#sso_error=${encodeURIComponent(message)}`);
		}
	}

	private async handleCodexLogin(req: express.Request, res: express.Response): Promise<void> {
		const { userName } = req.body as { userName?: string };
		const userId = this.getUserId(req, userName);
		const loginId = this.createLoginId();
		const entry: PendingAuthLogin = {
			userId,
			status: "pending",
			createdAt: Date.now(),
		};
		this.pendingAuthLogins.set(loginId, entry);

		const manualCodePromise = new Promise<string>((resolve, reject) => {
			entry.resolveManualCode = resolve;
			entry.rejectManualCode = reject;
		});

		void loginProvider(this.getUserAuthFilePath(userId), "openai-codex", {
			onAuth: (info) => {
				entry.url = info.url;
				entry.instructions = info.instructions;
			},
			onDeviceCode: (info) => {
				entry.userCode = info.userCode;
				entry.verificationUri = info.verificationUri;
			},
			onSelect: async () => undefined,
			onPrompt: async () => manualCodePromise,
			onManualCodeInput: async () => manualCodePromise,
			onProgress: (message) => {
				log.logInfo(`[auth:${loginId}] ${message}`);
			},
		}).then(() => {
			entry.status = "complete";
			entry.resolveManualCode = undefined;
			entry.rejectManualCode = undefined;
		}).catch((err) => {
			entry.status = "error";
			entry.error = err instanceof Error ? err.message : String(err);
			entry.resolveManualCode = undefined;
			entry.rejectManualCode = undefined;
			log.logWarning(`[auth:${loginId}] Codex login failed`, entry.error);
		});

		const started = Date.now();
		while (!entry.url && entry.status === "pending" && Date.now() - started < 5000) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		if (!entry.url) {
			res.status(500).json({ error: entry.error || "Codex login did not produce an auth URL" });
			return;
		}

		res.status(201).json({
			loginId,
			provider: "openai-codex",
			url: entry.url,
			instructions: entry.instructions,
			userCode: entry.userCode,
			verificationUri: entry.verificationUri,
			statusUrl: `/auth/openai-codex/login/${encodeURIComponent(loginId)}`,
			codeUrl: `/auth/openai-codex/login/${encodeURIComponent(loginId)}/code`,
		});
	}

	private handleCodexLoginStatus(req: express.Request, res: express.Response): void {
		const entry = this.pendingAuthLogins.get(String(req.params.loginId));
		if (!entry) {
			res.status(404).json({ error: "Login not found" });
			return;
		}
		res.json({
			status: entry.status,
			provider: "openai-codex",
			url: entry.url,
			instructions: entry.instructions,
			userCode: entry.userCode,
			verificationUri: entry.verificationUri,
			error: entry.error,
			createdAt: entry.createdAt,
		});
	}

	private handleCodexLoginCode(req: express.Request, res: express.Response): void {
		const entry = this.pendingAuthLogins.get(String(req.params.loginId));
		if (!entry) {
			res.status(404).json({ error: "Login not found" });
			return;
		}
		if (entry.status !== "pending" || !entry.resolveManualCode) {
			res.status(409).json({ error: `Login is ${entry.status}` });
			return;
		}
		const { code } = req.body as { code?: string };
		if (!code?.trim()) {
			res.status(400).json({ error: "Missing code or redirect URL" });
			return;
		}
		entry.resolveManualCode(code.trim());
		res.json({ ok: true, status: "pending" });
	}

	// ==========================================================================
	// IYH1HC add: per-user LLM provider key + model selection
	// ==========================================================================

	private isAllowedLlmProvider(provider: string): boolean {
		return LLM_KEY_PROVIDERS.some((p) => p.id === provider);
	}

	private modelLabel(provider: string, modelId: string): string {
		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const m = getModel(provider as any, modelId) as any;
			if (m?.name) return String(m.name);
		} catch { /* unknown model — fall back to id */ }
		return modelId;
	}

	// GET /llm/config → per-provider { id, label, hasKey, models:[{id,name,active}] }. Never returns keys.
	private async handleLlmConfig(req: express.Request, res: express.Response): Promise<void> {
		const userId = this.getUserId(req);
		const store = this.auth.getStore();
		const active = new Set((await store.getActiveModels(userId)).map((m) => `${m.provider}:${m.modelId}`));
		const providers = await Promise.all(LLM_KEY_PROVIDERS.map(async (p) => {
			let models: Array<{ id: string; name: string; active: boolean }> = [];
			try {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				models = (getModels(p.id as any) as any[]).map((m) => ({
					id: String(m.id),
					name: String(m.name ?? m.id),
					active: active.has(`${p.id}:${m.id}`),
				}));
			} catch { models = []; }
			return { id: p.id, label: p.label, hasKey: await store.hasProviderKey(userId, p.id), models };
		}));
		res.json({ providers });
	}

	// GET /llm/active-models → flat [{ provider, modelId, label }] for the chatbox listbox.
	private async handleLlmActiveModels(req: express.Request, res: express.Response): Promise<void> {
		const userId = this.getUserId(req);
		const store = this.auth.getStore();
		const models = (await store.getActiveModels(userId)).map((m) => ({
			provider: m.provider,
			modelId: m.modelId,
			label: this.modelLabel(m.provider, m.modelId),
		}));
		for (const cm of await store.listCustomModels(userId)) {
			models.push({ provider: "custom", modelId: cm.id, label: cm.name });
		}
		res.json({ models });
	}

	// PUT /llm/providers/:provider/key  body { apiKey } → encrypt + store.
	private async handleSetProviderKey(req: express.Request, res: express.Response): Promise<void> {
		const provider = String(req.params.provider);
		if (!this.isAllowedLlmProvider(provider)) {
			res.status(400).json({ error: "Unsupported provider" });
			return;
		}
		const { apiKey } = req.body as { apiKey?: string };
		if (!apiKey || !apiKey.trim()) {
			res.status(400).json({ error: "Missing apiKey" });
			return;
		}
		try {
			const encrypted = encryptSecret(apiKey.trim());
			await this.auth.getStore().setProviderKey(this.getUserId(req), provider, encrypted);
			res.json({ ok: true, hasKey: true });
		} catch (err) {
			res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	// DELETE /llm/providers/:provider/key → forget the stored key.
	private async handleDeleteProviderKey(req: express.Request, res: express.Response): Promise<void> {
		const provider = String(req.params.provider);
		if (!this.isAllowedLlmProvider(provider)) {
			res.status(400).json({ error: "Unsupported provider" });
			return;
		}
		await this.auth.getStore().deleteProviderKey(this.getUserId(req), provider);
		res.json({ ok: true, hasKey: false });
	}

	// PUT /llm/providers/:provider/models  body { modelIds: string[] } → replace active set.
	private async handleSetActiveModels(req: express.Request, res: express.Response): Promise<void> {
		const provider = String(req.params.provider);
		if (!this.isAllowedLlmProvider(provider)) {
			res.status(400).json({ error: "Unsupported provider" });
			return;
		}
		const { modelIds } = req.body as { modelIds?: unknown };
		if (!Array.isArray(modelIds) || modelIds.some((id) => typeof id !== "string")) {
			res.status(400).json({ error: "modelIds must be a string array" });
			return;
		}
		await this.auth.getStore().setActiveModels(this.getUserId(req), provider, modelIds as string[]);
		res.json({ ok: true });
	}

	private isAllowedBaseProvider(provider: string): boolean {
		return LLM_KEY_PROVIDERS.some((p) => p.id === provider);
	}

	private parseCustomModelBody(
		req: express.Request,
		requireKey: boolean,
	): { name: string; baseProvider: string; endpoint: string; apiKey?: string } | { error: string } {
		const { name, baseProvider, endpoint, apiKey } = req.body as {
			name?: string; baseProvider?: string; endpoint?: string; apiKey?: string;
		};
		if (!name || !name.trim()) return { error: "Missing name" };
		if (!baseProvider || !this.isAllowedBaseProvider(baseProvider)) return { error: "Unsupported baseProvider" };
		if (!endpoint || !endpoint.trim()) return { error: "Missing endpoint" };
		if (requireKey && (!apiKey || !apiKey.trim())) return { error: "Missing apiKey" };
		return {
			name: name.trim(),
			baseProvider,
			endpoint: endpoint.trim(),
			apiKey: apiKey && apiKey.trim() ? apiKey.trim() : undefined,
		};
	}

	// GET /llm/custom-models → { customModels: [{ id, name, baseProvider, endpoint }] }. Never returns keys.
	private async handleListCustomModels(req: express.Request, res: express.Response): Promise<void> {
		const customModels = await this.auth.getStore().listCustomModels(this.getUserId(req));
		res.json({ customModels });
	}

	// POST /llm/custom-models  body { name, baseProvider, endpoint, apiKey } → encrypt + store.
	private async handleCreateCustomModel(req: express.Request, res: express.Response): Promise<void> {
		const parsed = this.parseCustomModelBody(req, true);
		if ("error" in parsed) {
			res.status(400).json({ error: parsed.error });
			return;
		}
		try {
			const encryptedKey = encryptSecret(parsed.apiKey as string);
			const id = await this.auth.getStore().addCustomModel(this.getUserId(req), {
				name: parsed.name,
				baseProvider: parsed.baseProvider,
				endpoint: parsed.endpoint,
				encryptedKey,
			});
			res.json({ ok: true, id });
		} catch (err) {
			res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	// PUT /llm/custom-models/:id  body { name, baseProvider, endpoint, apiKey? } → update (key optional).
	private async handleUpdateCustomModel(req: express.Request, res: express.Response): Promise<void> {
		const id = String(req.params.id);
		const userId = this.getUserId(req);
		if (!(await this.auth.getStore().getCustomModel(userId, id))) {
			res.status(404).json({ error: "Custom model not found" });
			return;
		}
		const parsed = this.parseCustomModelBody(req, false);
		if ("error" in parsed) {
			res.status(400).json({ error: parsed.error });
			return;
		}
		try {
			const encryptedKey = parsed.apiKey ? encryptSecret(parsed.apiKey) : undefined;
			await this.auth.getStore().updateCustomModel(userId, id, {
				name: parsed.name,
				baseProvider: parsed.baseProvider,
				endpoint: parsed.endpoint,
				encryptedKey,
			});
			res.json({ ok: true });
		} catch (err) {
			res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	// DELETE /llm/custom-models/:id → forget the custom model.
	private async handleDeleteCustomModel(req: express.Request, res: express.Response): Promise<void> {
		await this.auth.getStore().deleteCustomModel(this.getUserId(req), String(req.params.id));
		res.json({ ok: true });
	}

	private safeUserId(userId: string): string {
		return safeConnectorUserId(userId);
	}

	private getUsersRoot(): string {
		return join(this.workingDir, "users");
	}

	private getConnectorEnv(userId: string, connector: ConnectorRuntime): NodeJS.ProcessEnv {
		const usersRoot = this.getUsersRoot();
		ensureConnectorHome(usersRoot, userId, connector.id);
		return {
			...process.env,
			...connector.env({ userId, usersRoot }),
		};
	}

	private resolveConnector(connectorId: string, kind?: "agent-runtime" | "business-connector"): ConnectorRuntime | undefined {
		const connector = getConnectorRuntime(connectorId);
		if (!connector) return undefined;
		if (kind && connector.kind !== kind) return undefined;
		if (!this.features.agentWorkers && connector.kind === "agent-runtime") return undefined;
		return connector;
	}

	private extractUrl(text: string): string | undefined {
		return text.match(/https?:\/\/[^\s)]+/)?.[0];
	}

	private serializeConnector(req: express.Request, connector: ConnectorRuntime) {
		const userId = this.getUserId(req);
		const usersRoot = this.getUsersRoot();
		return {
			id: connector.id,
			label: connector.label,
			kind: connector.kind,
			authMode: connector.authMode,
			loginModes: connector.loginModes,
			connected: connectorHomeHasFiles(usersRoot, userId, connector.id),
			usedByAgents: connector.usedByAgents ?? [],
			accessPolicy: connector.accessPolicy,
		};
	}

	private handleFeatures(res: express.Response): void {
		res.json({ features: { agentWorkers: this.features.agentWorkers, reminders: this.features.reminders, connection: this.features.connection, tools: this.features.tools, llmProviders: this.features.llmProviders, appTitle: this.features.appTitle, appHeader: this.features.appHeader } });
	}

	private handleConnectors(req: express.Request, res: express.Response): void {
		const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
		if (kind === "agent-runtime" && !this.features.agentWorkers) {
			res.json({ connectors: [] });
			return;
		}
		const connectors = listConnectorRuntimes(kind === "agent-runtime" || kind === "business-connector" ? kind : undefined)
			.filter((connector) => this.features.agentWorkers || connector.kind !== "agent-runtime")
			.map((connector) => this.serializeConnector(req, connector));
		res.json({ connectors });
	}

	private handleConnectorStatus(req: express.Request, res: express.Response): void {
		const connector = this.resolveConnector(String(req.params.connector));
		if (!connector) {
			res.status(404).json({ error: "Unknown connector" });
			return;
		}
		res.json(this.serializeConnector(req, connector));
	}

	private handleConnectorLogin(req: express.Request, res: express.Response): void {
		const connector = this.resolveConnector(String(req.params.connector));
		if (!connector || (!connector.loginModes?.length && (!connector.command || !connector.loginCommand))) {
			res.status(404).json({ error: "Connector login is not configured" });
			return;
		}
		this.startConnectorLogin(req, res, connector);
	}

	private handleConnectorLoginStatus(req: express.Request, res: express.Response): void {
		this.writeConnectorLoginStatus(req, res, String(req.params.connector), "connector");
	}

	private handleConnectorLoginInput(req: express.Request, res: express.Response): void {
		this.writeConnectorLoginInput(req, res, String(req.params.connector));
	}

	private handleConnectorLogout(req: express.Request, res: express.Response): void {
		const connector = this.resolveConnector(String(req.params.connector));
		if (!connector) {
			res.status(404).json({ error: "Unknown connector" });
			return;
		}
		this.logoutConnector(req, res, connector);
	}

	private handleConnectorExec(req: express.Request, res: express.Response): void {
		const connector = this.resolveConnector(String(req.params.connector), "business-connector");
		if (!connector?.command || !connector.accessPolicy.allowedInHost) {
			res.status(404).json({ error: "Connector command proxy is not configured" });
			return;
		}
		const body = req.body as { argv?: unknown; cwd?: unknown; timeoutMs?: unknown };
		const argv = Array.isArray(body.argv) ? body.argv.map(String) : [];
		const timeoutMs = Math.min(Math.max(Number(body.timeoutMs ?? 120000) || 120000, 1000), 300000);
		const cwd = this.resolveConnectorExecCwd(typeof body.cwd === "string" ? body.cwd : undefined);
		if (!cwd) {
			res.status(403).json({ error: "Connector cwd is outside the workspace root" });
			return;
		}
		const userId = this.getUserId(req);
		const child = spawn(connector.command, argv, {
			env: this.getConnectorEnv(userId, connector),
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let responded = false;
		const trim = (text: string) => text.length > 10 * 1024 * 1024 ? text.slice(-10 * 1024 * 1024) : text;
		const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => { stdout = trim(stdout + chunk.toString("utf-8")); });
		child.stderr.on("data", (chunk: Buffer) => { stderr = trim(stderr + chunk.toString("utf-8")); });
		child.on("error", (err) => {
			clearTimeout(timeout);
			responded = true;
			res.status(500).json({ stdout, stderr: stderr || err.message, exitCode: 1, error: err.message });
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			if (responded) return;
			res.json({ stdout, stderr, exitCode: code ?? 0 });
		});
	}

	private resolveConnectorExecCwd(cwd?: string): string | undefined {
		const root = resolve(this.workingDir);
		const resolved = cwd
			? resolve(cwd.startsWith("/") ? cwd : join(this.workingDir, cwd))
			: root;
		if (resolved !== root && !resolved.startsWith(`${root}/`)) return undefined;
		return resolved;
	}

	// ==========================================================================
	// SAP ADT connection management
	// ==========================================================================

	// Run the vendored adt-cli (spawned via the current Node binary + an absolute
	// path to its bin, never a bare PATH lookup). The SAP ADT connector home isolates
	// each user's adt-cli profile store; ADT_USER_JWT carries the request-scoped user
	// token for principal propagation, and ADT_PROFILE selects the connection profile.
	private runAdtCli(
		userId: string,
		argv: string[],
		opts: { userJwt?: string; cwd?: string; profileName?: string; timeoutMs?: number; destinationName?: string; routerBase?: string } = {},
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return new Promise((resolveP) => {
			const connector = this.resolveConnector("sap-adt", "business-connector");
			if (!connector) {
				resolveP({ stdout: "", stderr: "sap-adt connector is not configured", exitCode: 1 });
				return;
			}
			let adtBin: string;
			try {
				adtBin = localRequire.resolve("adt-cli/bin/adt.js");
			} catch (err) {
				resolveP({ stdout: "", stderr: `adt-cli is not installed: ${(err as Error).message}`, exitCode: 1 });
				return;
			}
			const usersRoot = this.getUsersRoot();
			const home = getConnectorHome(usersRoot, userId, connector.id);
			const env: NodeJS.ProcessEnv = {
				...process.env,
				...this.getConnectorEnv(userId, connector),
				// adt-cli persists profiles under ADT_CLI_HOME; set it explicitly because
				// os.homedir() ignores HOME on Windows, which would break local isolation.
				ADT_CLI_HOME: join(home, ".adt-cli"),
			};
			if (opts.userJwt) env.ADT_USER_JWT = opts.userJwt;
			if (opts.profileName) env.ADT_PROFILE = opts.profileName;
			if (opts.destinationName && opts.routerBase) {
				env.destinations = JSON.stringify([
					{
						name: opts.destinationName,
						url: `${opts.routerBase.replace(/\/+$/, "")}/adt-proxy/${encodeURIComponent(opts.destinationName)}`,
						forwardAuthToken: true,
					},
				]);
			}
			const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : this.workingDir;
			const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 120000, 1000), 300000);
			const child = spawn(process.execPath, [adtBin, ...argv], { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			let settled = false;
			const cap = (text: string) => (text.length > 10 * 1024 * 1024 ? text.slice(-10 * 1024 * 1024) : text);
			const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
			child.stdout.on("data", (chunk: Buffer) => { stdout = cap(stdout + chunk.toString("utf-8")); });
			child.stderr.on("data", (chunk: Buffer) => { stderr = cap(stderr + chunk.toString("utf-8")); });
			child.on("error", (err) => {
				clearTimeout(timer);
				if (settled) return;
				settled = true;
				resolveP({ stdout, stderr: stderr || err.message, exitCode: 1 });
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				if (settled) return;
				settled = true;
				resolveP({ stdout, stderr, exitCode: code ?? 0 });
			});
		});
	}

	private extractUserJwt(req: express.Request): string | undefined {
		const match = req.header("Authorization")?.match(/^Bearer\s+(.+)$/i);
		return match?.[1]?.trim();
	}

	private resolveRouterBase(req: express.Request): string | undefined {
		if (process.env.ADT_ROUTER_URL) return process.env.ADT_ROUTER_URL;
		const host = req.header("x-forwarded-host") || req.header("host");
		if (!host) return undefined;
		const proto = req.header("x-forwarded-proto") || "https";
		return `${proto}://${host}`;
	}

	private getConnectionDestination(userId: string, workspaceId: string, name: string): string | undefined {
		return this.workspaceStore.getSapConnections(userId, workspaceId).find((c) => c.name === name)?.destinationName;
	}

	// Connection name doubles as the adt-cli profile name and an on-disk folder name,
	// so it must be filesystem/profile safe.
	private sanitizeConnectionName(raw: unknown): string {
		return String(raw ?? "").trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
	}

	// Resolves req.params.workspaceId against the caller's membership, or sends a
	// 404/403 and returns undefined. Used by every workspace-scoped write handler.
	private assertWorkspaceRole(req: express.Request, res: express.Response, requireWrite: boolean): { userId: string; workspaceId: string } | undefined {
		const userId = this.getUserId(req);
		const workspaceId = String(req.params.workspaceId);
		let role: WorkspaceRole;
		try {
			role = this.workspaceStore.assertWorkspaceAccess(userId, workspaceId);
		} catch {
			res.status(404).json({ error: "Workspace not found or access denied" });
			return undefined;
		}
		if (requireWrite && role === "viewer") {
			res.status(403).json({ error: "Workspace is read-only for viewers" });
			return undefined;
		}
		return { userId, workspaceId };
	}

	// GET /workspaces/:id/sap-adt/destinations
	private async handleSapListDestinations(req: express.Request, res: express.Response): Promise<void> {
		const ctx = this.assertWorkspaceRole(req, res, false);
		if (!ctx) return;
		const userJwt = this.extractUserJwt(req);
		const result = await this.runAdtCli(ctx.userId, ["-q", "auth", "destinations", "list"], { userJwt });
		if (result.exitCode !== 0) {
			res.status(502).json({ error: result.stderr || "Failed to list destinations" });
			return;
		}
		let parsed: { remote?: { error?: string; subaccount?: SapRemoteDest[]; instance?: SapRemoteDest[] } };
		try {
			parsed = JSON.parse(result.stdout);
		} catch {
			res.status(502).json({ error: "Invalid destinations output", raw: result.stdout });
			return;
		}
		const remote = parsed.remote && !parsed.remote.error ? parsed.remote : { subaccount: [], instance: [] };
		const destinations = [...(remote.subaccount ?? []), ...(remote.instance ?? [])].map((d) => ({
			name: d.Name,
			type: d.Type,
			url: d.URL,
			authentication: d.Authentication,
			proxyType: d.ProxyType,
			description: d.Description,
		}));
		res.json({ destinations });
	}

	// GET /workspaces/:id/sap-adt/local-systems
	private async handleSapListLocalSystems(req: express.Request, res: express.Response): Promise<void> {
		const ctx = this.assertWorkspaceRole(req, res, false);
		if (!ctx) return;
		try {
			const systems: SapLocalSystem[] = listLocalSapSystems();
			res.json({ systems });
		} catch (e) {
			res.status(500).json({ error: (e as Error).message || "Failed to read SAP Logon landscape" });
		}
	}

	private async createLocalSsoConnection(ctx: { userId: string; workspaceId: string }, req: express.Request, res: express.Response): Promise<void> {
		const body = req.body as { url?: unknown; spn?: unknown; systemId?: unknown; name?: unknown; client?: unknown; language?: unknown };
		const url = String(body.url ?? "").trim();
		const spn = String(body.spn ?? "").trim();
		if (!url || !spn) {
			res.status(400).json({ error: "url and spn are required for an SSO connection" });
			return;
		}
		const systemId = body.systemId ? String(body.systemId).trim() : undefined;
		const name = this.sanitizeConnectionName(body.name || systemId || url);
		if (!name) {
			res.status(400).json({ error: "A valid connection name is required" });
			return;
		}
		const client = body.client ? String(body.client) : undefined;
		const language = body.language ? String(body.language) : undefined;

		const folder = join(this.workspaceStore.getWorkspaceRoot(ctx.workspaceId), "artifacts", name);
		mkdirSync(folder, { recursive: true });

		const argv = ["-q", "auth", "login", "basicsso", "--url", url, "--spn", spn, "--insecure", "--name", name];
		if (client) argv.push("--client", client);
		if (language) argv.push("--language", language);
		const result = await this.runAdtCli(ctx.userId, argv, { cwd: folder, profileName: name });
		const connected = result.exitCode === 0;

		writeFileSync(
			join(folder, ".adt-connection.json"),
			`${JSON.stringify({ connectionName: name, authType: "sso", url, spn, systemId, client, language }, null, 2)}\n`,
		);

		if (connected) {
			mkdirSync(join(folder, LOCAL_OBJECTS_ROOT), { recursive: true });
			mkdirSync(join(folder, "Artifacts"), { recursive: true });
			writeManifest(folder, initialManifest());
		}

		const connection: SapConnection = {
			name,
			authType: "sso",
			url,
			spn,
			systemId,
			client,
			language,
			status: connected ? "connected" : "error",
			createdAt: new Date().toISOString(),
		};
		const next = this.workspaceStore.getSapConnections(ctx.userId, ctx.workspaceId).filter((c) => c.name !== name);
		next.push(connection);
		this.workspaceStore.setSapConnections(ctx.userId, ctx.workspaceId, next);

		if (!connected) {
			res.status(502).json({ connection, error: result.stderr || "SSO connection verification failed" });
			return;
		}
		res.json({ connection });
	}

	// POST /workspaces/:id/sap-adt/connections
	private async handleSapCreateConnection(req: express.Request, res: express.Response): Promise<void> {
		const ctx = this.assertWorkspaceRole(req, res, true);
		if (!ctx) return;
		if (["local", "sso"].includes(String((req.body as { mode?: unknown }).mode ?? "").trim().toLowerCase())) {
			await this.createLocalSsoConnection(ctx, req, res);
			return;
		}
		const body = req.body as { destination?: unknown; name?: unknown; client?: unknown; language?: unknown };
		const destination = String(body.destination ?? "").trim();
		if (!destination) {
			res.status(400).json({ error: "destination is required" });
			return;
		}
		const name = this.sanitizeConnectionName(body.name || destination);
		if (!name) {
			res.status(400).json({ error: "A valid connection name is required" });
			return;
		}
		const client = body.client ? String(body.client) : undefined;
		const language = body.language ? String(body.language) : undefined;
		const userJwt = this.extractUserJwt(req);

		const folder = join(this.workspaceStore.getWorkspaceRoot(ctx.workspaceId), "artifacts", name);
		mkdirSync(folder, { recursive: true });

		const argv = ["-q", "auth", "login", "destination", "--destination", destination, "--name", name];
		if (client) argv.push("--client", client);
		if (language) argv.push("--language", language);
		if (userJwt) argv.push("--user-jwt", userJwt);
		const result = await this.runAdtCli(ctx.userId, argv, { userJwt, cwd: folder, profileName: name, destinationName: destination, routerBase: this.resolveRouterBase(req) });
		const connected = result.exitCode === 0;

		writeFileSync(
			join(folder, ".adt-connection.json"),
			`${JSON.stringify({ connectionName: name, destination, client, language }, null, 2)}\n`,
		);

		if (connected) {
			mkdirSync(join(folder, LOCAL_OBJECTS_ROOT), { recursive: true });
			mkdirSync(join(folder, "Artifacts"), { recursive: true });
			writeManifest(folder, initialManifest());
		}

		const connection: SapConnection = {
			name,
			destinationName: destination,
			client,
			language,
			status: connected ? "connected" : "error",
			createdAt: new Date().toISOString(),
		};
		const next = this.workspaceStore.getSapConnections(ctx.userId, ctx.workspaceId).filter((c) => c.name !== name);
		next.push(connection);
		this.workspaceStore.setSapConnections(ctx.userId, ctx.workspaceId, next);

		if (!connected) {
			res.status(502).json({ connection, error: result.stderr || "Connection verification failed" });
			return;
		}
		res.json({ connection });
	}

	// DELETE /workspaces/:id/sap-adt/connections/:name
	private async handleSapDeleteConnection(req: express.Request, res: express.Response): Promise<void> {
		const ctx = this.assertWorkspaceRole(req, res, true);
		if (!ctx) return;
		const name = this.sanitizeConnectionName(req.params.name);
		const userJwt = this.extractUserJwt(req);
		// Best-effort profile removal; ignore failures (profile may already be gone).
		await this.runAdtCli(ctx.userId, ["-q", "auth", "profile", "delete", name], { userJwt });
		const next = this.workspaceStore.getSapConnections(ctx.userId, ctx.workspaceId).filter((c) => c.name !== name);
		this.workspaceStore.setSapConnections(ctx.userId, ctx.workspaceId, next);
		res.json({ ok: true }); // the on-disk folder is intentionally kept.
	}

	// POST /workspaces/:id/sap-adt/connections/:name/test
	private async handleSapTestConnection(req: express.Request, res: express.Response): Promise<void> {
		const ctx = this.assertWorkspaceRole(req, res, false);
		if (!ctx) return;
		const name = this.sanitizeConnectionName(req.params.name);
		const userJwt = this.extractUserJwt(req);
		const destinationName = this.getConnectionDestination(ctx.userId, ctx.workspaceId, name);
		const result = await this.runAdtCli(ctx.userId, ["-q", "auth", "login", "test", "--name", name], { userJwt, profileName: name, destinationName, routerBase: this.resolveRouterBase(req) });
		const ok = result.exitCode === 0;
		const connections = this.workspaceStore.getSapConnections(ctx.userId, ctx.workspaceId);
		const conn = connections.find((c) => c.name === name);
		if (conn) {
			conn.status = ok ? "connected" : "error";
			this.workspaceStore.setSapConnections(ctx.userId, ctx.workspaceId, connections);
		}
		res.status(ok ? 200 : 502).json({ ok, status: ok ? "connected" : "error", error: ok ? undefined : result.stderr });
	}

	// GET /workspaces/:id/sap-adt/connections/:name/nodes?package=$TMP[&parentType=][&parentName=]
	private async handleSapListNodes(req: express.Request, res: express.Response): Promise<void> {
		const ctx = this.assertWorkspaceRole(req, res, false);
		if (!ctx) return;
		const name = this.sanitizeConnectionName(req.params.name);
		const pkg = String(req.query.package ?? "$TMP");
		const userJwt = this.extractUserJwt(req);
		const argv = ["-q", "object", "list", "--package", pkg, "--json"];
		if (typeof req.query.parentType === "string" && req.query.parentType) argv.push("--parent-type", req.query.parentType);
		if (typeof req.query.parentName === "string" && req.query.parentName) argv.push("--parent-name", req.query.parentName);
		const destinationName = this.getConnectionDestination(ctx.userId, ctx.workspaceId, name);
		const result = await this.runAdtCli(ctx.userId, argv, { userJwt, profileName: name, destinationName, routerBase: this.resolveRouterBase(req) });
		if (result.exitCode !== 0) {
			res.status(502).json({ error: result.stderr || "Failed to list nodes" });
			return;
		}
		let nodes: unknown;
		try {
			nodes = JSON.parse(result.stdout);
		} catch {
			res.status(502).json({ error: "Invalid nodes output", raw: result.stdout });
			return;
		}
		res.json({ nodes });
	}

	// GET /workspaces/:id/sap-adt/connections/:name/source?uri=...
	private async handleSapGetSource(req: express.Request, res: express.Response): Promise<void> {
		const ctx = this.assertWorkspaceRole(req, res, false);
		if (!ctx) return;
		const name = this.sanitizeConnectionName(req.params.name);
		const uri = String(req.query.uri ?? "");
		if (!uri) {
			res.status(400).json({ error: "uri is required" });
			return;
		}
		const userJwt = this.extractUserJwt(req);
		const destinationName = this.getConnectionDestination(ctx.userId, ctx.workspaceId, name);
		const result = await this.runAdtCli(ctx.userId, ["-q", "object", "source", uri], { userJwt, profileName: name, destinationName, routerBase: this.resolveRouterBase(req) });
		if (result.exitCode !== 0) {
			res.status(502).json({ error: result.stderr || "Failed to read source" });
			return;
		}
		res.json({ source: result.stdout });
	}

	private resolveSapTreeRelKey(workspaceId: string, connName: string, inputPath: string): string | null {
		if (!inputPath) return null;
		let p = String(inputPath).replace(/\\/g, "/").replace(/^\/+/, "");
		const fullPrefix = `workspaces/${workspaceId}/artifacts/`;
		if (p.startsWith(fullPrefix)) p = p.slice(fullPrefix.length);
		else if (p.startsWith("artifacts/")) p = p.slice("artifacts/".length);
		if (p === connName) return "";
		const connPrefix = `${connName}/`;
		if (!p.startsWith(connPrefix)) return null;
		const relKey = p.slice(connPrefix.length);
		if (!relKey || relKey.split("/").some((seg) => seg === "." || seg === "..")) return null;
		return relKey;
	}

	private sapConnDir(workspaceId: string, connName: string): string {
		return join(this.workspaceStore.getWorkspaceRoot(workspaceId), "artifacts", connName);
	}

	// POST /workspaces/:id/sap-adt/connections/:name/tree/expand  body { path }
	private async handleSapExpandTree(req: express.Request, res: express.Response): Promise<void> {
		const ctx = this.assertWorkspaceRole(req, res, false);
		if (!ctx) return;
		const name = this.sanitizeConnectionName(req.params.name);
		const connDir = this.sapConnDir(ctx.workspaceId, name);
		const relKey = this.resolveSapTreeRelKey(ctx.workspaceId, name, String((req.body as { path?: unknown })?.path ?? ""));
		if (relKey == null) {
			res.status(400).json({ error: "Invalid path" });
			return;
		}
		const manifest = readManifest(connDir);
		const entry = manifest.entries[relKey];
		if (!entry || entry.kind !== "package" || !entry.adtParentType || !entry.adtParentName) {
			res.status(404).json({ error: "Not an expandable ADT node" });
			return;
		}
		if (entry.loaded) {
			res.json({ ok: true, alreadyLoaded: true });
			return;
		}
		const userJwt = this.extractUserJwt(req);
		const destinationName = this.getConnectionDestination(ctx.userId, ctx.workspaceId, name);
		const argv = ["-q", "object", "list", "--parent-type", entry.adtParentType, "--parent-name", entry.adtParentName, "--json"];
		const result = await this.runAdtCli(ctx.userId, argv, { userJwt, profileName: name, destinationName, routerBase: this.resolveRouterBase(req) });
		if (result.exitCode !== 0) {
			res.status(502).json({ error: result.stderr || "Failed to expand node" });
			return;
		}
		let listed: AdtListResult;
		try {
			listed = JSON.parse(result.stdout) as AdtListResult;
		} catch {
			res.status(502).json({ error: "Invalid object list output", raw: result.stdout });
			return;
		}
		const plan = planChildren(listed);
		applyPlan(connDir, relKey, plan, manifest);
		entry.loaded = true;
		writeManifest(connDir, manifest);
		res.json({ ok: true, count: plan.length });
	}

	// POST /workspaces/:id/sap-adt/connections/:name/tree/hydrate  body { path }
	private async handleSapHydrateFile(req: express.Request, res: express.Response): Promise<void> {
		const ctx = this.assertWorkspaceRole(req, res, false);
		if (!ctx) return;
		const name = this.sanitizeConnectionName(req.params.name);
		const connDir = this.sapConnDir(ctx.workspaceId, name);
		const relKey = this.resolveSapTreeRelKey(ctx.workspaceId, name, String((req.body as { path?: unknown })?.path ?? ""));
		if (!relKey) {
			res.status(400).json({ error: "Invalid path" });
			return;
		}
		const manifest = readManifest(connDir);
		const entry = manifest.entries[relKey];
		if (!entry || entry.kind !== "object" || !entry.adtUri) {
			res.status(404).json({ error: "Not an ADT-backed file" });
			return;
		}
		const abs = join(connDir, relKey);
		const existing = existsSync(abs) ? readFileSync(abs, "utf8") : "";
		if (existing.length > 0) {
			res.json({ source: existing, cached: true });
			return;
		}
		const userJwt = this.extractUserJwt(req);
		const destinationName = this.getConnectionDestination(ctx.userId, ctx.workspaceId, name);
		const result = await this.runAdtCli(ctx.userId, ["-q", "object", "source", entry.adtUri], { userJwt, profileName: name, destinationName, routerBase: this.resolveRouterBase(req) });
		if (result.exitCode !== 0) {
			res.status(502).json({ error: result.stderr || "Failed to read source" });
			return;
		}
		writeFileSync(abs, result.stdout);
		res.json({ source: result.stdout });
	}

	// GET /workspaces/:id/sap-adt/connections/:name/tree/manifest
	private handleSapTreeManifest(req: express.Request, res: express.Response): void {
		const ctx = this.assertWorkspaceRole(req, res, false);
		if (!ctx) return;
		const name = this.sanitizeConnectionName(req.params.name);
		const connDir = this.sapConnDir(ctx.workspaceId, name);
		res.json({ manifest: manifestView(readManifest(connDir)) });
	}

	private handleAgentWorkers(req: express.Request, res: express.Response): void {
		if (!this.features.agentWorkers) {
			res.json({ agents: [] });
			return;
		}
		res.json({
			agents: listConnectorRuntimes("agent-runtime").map((connector) => this.serializeConnector(req, connector)),
		});
	}

	private handleAgentWorkerStatus(req: express.Request, res: express.Response): void {
		if (!this.features.agentWorkers) {
			res.status(404).json({ error: "Agent workers are disabled" });
			return;
		}
		const agent = String(req.params.agent);
		const connector = this.resolveConnector(agent, "agent-runtime");
		if (!connector) {
			res.status(404).json({ error: "Unknown agent worker" });
			return;
		}
		res.json(this.serializeConnector(req, connector));
	}

	private isJsonObject(value: unknown): value is JsonObject {
		return Boolean(value) && typeof value === "object" && !Array.isArray(value);
	}

	private writeGeminiAuthSettings(home: string, authType: "oauth-personal" | "vertex-ai"): void {
		const settingsDir = join(home, ".gemini");
		const settingsPath = join(settingsDir, "settings.json");
		mkdirSync(settingsDir, { recursive: true });

		let settings: JsonObject = {};
		if (existsSync(settingsPath)) {
			try {
				const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
				if (this.isJsonObject(parsed)) settings = parsed;
			} catch {
				settings = {};
			}
		}

		const security = this.isJsonObject(settings.security) ? settings.security : {};
		const auth = this.isJsonObject(security.auth) ? security.auth : {};

		settings.selectedAuthType = authType;
		settings.security = {
			...security,
			auth: {
				...auth,
				selectedType: authType,
			},
		};

		writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
	}

	private prepareConnectorLogin(
		userId: string,
		connector: ConnectorRuntime,
		selectedMode: ConnectorLoginMode | undefined,
		home: string,
	): NodeJS.ProcessEnv {
		const env = this.getConnectorEnv(userId, connector);
		if (connector.id !== "gemini") return env;

		const authType = selectedMode?.id === "gcloud-adc" ? "vertex-ai" : "oauth-personal";
		this.writeGeminiAuthSettings(home, authType);

		if (authType === "vertex-ai") {
			delete env.GEMINI_API_KEY;
			delete env.GOOGLE_API_KEY;
			env.GOOGLE_GENAI_USE_VERTEXAI = "true";
			return env;
		}

		delete env.GEMINI_API_KEY;
		delete env.GOOGLE_API_KEY;
		delete env.GOOGLE_GENAI_USE_VERTEXAI;
		delete env.GOOGLE_GENAI_USE_GCA;
		return env;
	}

	private maybeAutoConfirmConnectorLogin(
		entry: PendingAgentWorkerLogin,
		connector: ConnectorRuntime,
		selectedMode: ConnectorLoginMode | undefined,
	): void {
		if (
			entry.autoConfirmed ||
			!entry.child ||
			connector.id !== "gemini" ||
			selectedMode?.id !== "gemini-cli"
		) return;

		if (!/Opening authentication page in your browser\.\s*Do you want to continue\?\s*\[Y\/n\]:/i.test(entry.output)) {
			return;
		}

		entry.autoConfirmed = true;
		entry.child.stdin.write("Y\n");
	}

	private startConnectorLogin(req: express.Request, res: express.Response, connector: ConnectorRuntime): void {
		const userId = this.getUserId(req);
		const loginId = this.createLoginId();

		const { loginMode } = req.body as { loginMode?: string };
		const selectedMode =
			connector.loginModes?.find((mode) => mode.id === loginMode) ??
			connector.loginModes?.[0];

		const command = selectedMode?.command ?? connector.command;
		const args = selectedMode?.args ?? connector.loginCommand;

		if (!command || !args) {
			res.status(404).json({ error: "Connector login is not configured" });
			return;
		}

		const entry: PendingAgentWorkerLogin = {
			userId,
			connectorId: connector.id,
			status: "pending",
			createdAt: Date.now(),
			output: "",
		};
		this.pendingAgentWorkerLogins.set(loginId, entry);

		const home = ensureConnectorHome(this.getUsersRoot(), userId, connector.id);
		const env = this.prepareConnectorLogin(userId, connector, selectedMode, home);

		const child = spawn(command, args, {
			env,
			cwd: home,
			stdio: ["pipe", "pipe", "pipe"],
		});
		entry.child = child;
		const onData = (chunk: Buffer) => {
			entry.output += chunk.toString("utf-8");
			if (entry.output.length > 20000) entry.output = entry.output.slice(-20000);
			entry.url = entry.url ?? this.extractUrl(entry.output);
			this.maybeAutoConfirmConnectorLogin(entry, connector, selectedMode);
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("error", (err) => {
			entry.status = "error";
			entry.error = err.message;
		});
		child.on("exit", (code) => {
			entry.status = code === 0 ? "complete" : "error";
			if (code !== 0) entry.error = `Login exited with code ${code}`;
			entry.child = undefined;
		});

		res.status(201).json({
			loginId,
			loginMode: selectedMode?.id,
			agent: connector.id,
			connector: connector.id,
			label: connector.label,
			status: entry.status,
			url: entry.url,
			output: entry.output,
			statusUrl: `/auth/connectors/${encodeURIComponent(connector.id)}/login/${encodeURIComponent(loginId)}`,
			inputUrl: `/auth/connectors/${encodeURIComponent(connector.id)}/login/${encodeURIComponent(loginId)}/input`,
		});
	}

	private handleAgentWorkerLogin(req: express.Request, res: express.Response): void {
		if (!this.features.agentWorkers) {
			res.status(404).json({ error: "Agent workers are disabled" });
			return;
		}
		const agent = String(req.params.agent);
		const connector = this.resolveConnector(agent, "agent-runtime");
		if (!connector || (!connector.loginModes?.length && (!connector.command || !connector.loginCommand))) {
			res.status(404).json({ error: "Unknown agent worker" });
			return;
		}
		this.startConnectorLogin(req, res, connector);
	}

	private writeConnectorLoginStatus(req: express.Request, res: express.Response, connectorId: string, fieldName: "agent" | "connector"): void {
		const entry = this.pendingAgentWorkerLogins.get(String(req.params.loginId));
		if (!entry || entry.connectorId !== connectorId) {
			res.status(404).json({ error: "Login not found" });
			return;
		}
		res.json({
			status: entry.status,
			[fieldName]: entry.connectorId,
			loginMode: (entry as any).loginMode,
			url: entry.url,
			output: entry.output,
			error: entry.error,
			createdAt: entry.createdAt,
		});
	}

	private handleAgentWorkerLoginStatus(req: express.Request, res: express.Response): void {
		if (!this.features.agentWorkers) {
			res.status(404).json({ error: "Agent workers are disabled" });
			return;
		}
		this.writeConnectorLoginStatus(req, res, String(req.params.agent), "agent");
	}

	private writeConnectorLoginInput(req: express.Request, res: express.Response, connectorId: string): void {
		const entry = this.pendingAgentWorkerLogins.get(String(req.params.loginId));
		if (!entry || entry.connectorId !== connectorId) {
			res.status(404).json({ error: "Login not found" });
			return;
		}
		const { input } = req.body as { input?: string };
		if (entry.status !== "pending" || !entry.child || input === undefined) {
			res.status(409).json({ error: `Login is ${entry.status}` });
			return;
		}
		entry.child.stdin.write(`${input}\n`);
		res.json({ ok: true, status: entry.status });
	}

	private handleAgentWorkerLoginInput(req: express.Request, res: express.Response): void {
		if (!this.features.agentWorkers) {
			res.status(404).json({ error: "Agent workers are disabled" });
			return;
		}
		this.writeConnectorLoginInput(req, res, String(req.params.agent));
	}

	private logoutConnector(req: express.Request, res: express.Response, connector: ConnectorRuntime): void {
		const userId = this.getUserId(req);
		const home = getConnectorHome(this.getUsersRoot(), userId, connector.id);

		const removeHome = () => {
			try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
		};

		if (connector.command && connector.logoutCommand) {
			const child = spawn(connector.command, connector.logoutCommand, {
				env: this.getConnectorEnv(userId, connector),
				cwd: home,
				stdio: ["ignore", "ignore", "ignore"],
			});
			child.once("exit", removeHome);
			child.once("error", removeHome);
			res.json({ ok: true });
		} else {
			removeHome();
			res.json({ ok: true });
		}
	}

	private handleAgentWorkerLogout(req: express.Request, res: express.Response): void {
		if (!this.features.agentWorkers) {
			res.status(404).json({ error: "Agent workers are disabled" });
			return;
		}
		const agent = String(req.params.agent);
		const connector = this.resolveConnector(agent, "agent-runtime");
		if (!connector) {
			res.status(404).json({ error: "Unknown agent worker" });
			return;
		}
		this.logoutConnector(req, res, connector);
	}

	private handleWorkspaces(req: express.Request, res: express.Response): void {
		const userId = this.getUserId(req);
		this.workspaceStore.ensureDefaultWorkspace(userId);
		res.json(this.workspaceStore.listWorkspaces(userId));
	}

	private handleCreateWorkspace(req: express.Request, res: express.Response): void {
		const { name, userName, templateId, type } = req.body as { name?: string; userName?: string; templateId?: string; type?: string };
		const userId = this.getUserId(req, userName);
		const workspace = this.workspaceStore.createWorkspace({ name: name || "New workspace", userId, templateId: templateId ?? type });
		res.status(201).json(workspace);
	}

	/**
	 * The primitive tool catalog for the workspace settings Tools tab. Global,
	 * not workspace-scoped — a workspace stores only which of these it enables.
	 * `available` is false for a tool whose backing capability is not configured,
	 * so the UI can stop the user enabling something that will never register.
	 */
	private handleToolCatalog(_req: express.Request, res: express.Response): void {
		const webSearchConfigured = resolveWebSearchConfig() !== undefined;
		res.json({
			// `promptGuidance` is prose for the model, not the UI; drop it.
			tools: TOOL_CATALOG.map(({ promptGuidance: _promptGuidance, ...entry }) => ({
				...entry,
				available: entry.name === "web_search" ? webSearchConfigured : true,
				unavailableReason:
					entry.name === "web_search" && !webSearchConfigured
						? "Set WEB_SEARCH_PROVIDER and WEB_SEARCH_API_KEY to enable web search."
						: undefined,
			})),
		});
	}

	private handleWorkspaceSettings(req: express.Request, res: express.Response): void {
		try {
			res.json(this.workspaceStore.getWorkspaceSettings(this.getUserId(req), String(req.params.workspaceId)));
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	private handleUpdateWorkspaceSettings(req: express.Request, res: express.Response): void {
		try {
			res.json(this.workspaceStore.updateWorkspaceSettings(this.getUserId(req), String(req.params.workspaceId), req.body ?? {}));
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	private async handleWorkspaceSandbox(req: express.Request, res: express.Response): Promise<void> {
		try {
			const userId = this.getUserId(req);
			const workspaceId = String(req.params.workspaceId);
			this.workspaceStore.assertWorkspaceAccess(userId, workspaceId);
			const workspaceRoot = this.workspaceStore.getWorkspaceRoot(workspaceId);
			res.json(await getWorkspaceSandboxStatus(this.sandboxConfig, {
				workspaceId,
				workspaceRoot,
				dataRoot: this.workingDir,
				usersRoot: join(this.workingDir, "users"),
				memberUserIds: this.workspaceStore.getWorkspaceMembers(workspaceId).map((member) => member.userId),
				image: this.workspaceStore.getWorkspaceSandboxImage(workspaceId),
			}));
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	private handleWorkspaceEvents(req: express.Request, res: express.Response): void {
		if (!this.features.reminders) {
			res.json({ events: [] });
			return;
		}
		try {
			const userId = this.getUserId(req);
			const workspaceId = String(req.params.workspaceId);
			this.workspaceStore.assertWorkspaceAccess(userId, workspaceId);
			const eventsDir = join(this.workspaceStore.getWorkspaceRoot(workspaceId), "events");
			if (!existsSync(eventsDir)) {
				res.json({ events: [] });
				return;
			}

			const events = readdirSync(eventsDir, { withFileTypes: true })
				.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
				.map((entry) => {
					const filePath = join(eventsDir, entry.name);
					const content = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
					let data: Record<string, unknown> = {};
					let valid = true;
					let error: string | undefined;
					try {
						data = JSON.parse(content) as Record<string, unknown>;
					} catch (err) {
						valid = false;
						error = err instanceof Error ? err.message : String(err);
					}
					return {
						filename: entry.name,
						type: typeof data.type === "string" ? data.type : "unknown",
						channelId: typeof data.channelId === "string" ? data.channelId : "",
						text: typeof data.text === "string" ? data.text : "",
						at: typeof data.at === "string" ? data.at : undefined,
						schedule: typeof data.schedule === "string" ? data.schedule : undefined,
						timezone: typeof data.timezone === "string" ? data.timezone : undefined,
						modifiedAt: existsSync(filePath) ? Math.round(statSync(filePath).mtimeMs) : 0,
						valid,
						error,
					};
				})
				.sort((a, b) => a.filename.localeCompare(b.filename));
			res.json({ events });
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	private handleDeleteWorkspaceEvent(req: express.Request, res: express.Response): void {
		if (!this.features.reminders) {
			res.status(403).json({ error: "Reminders are disabled" });
			return;
		}
		try {
			const userId = this.getUserId(req);
			const workspaceId = String(req.params.workspaceId);
			const filename = basename(decodeURIComponent(String(req.params.filename)));
			if (!filename || filename !== decodeURIComponent(String(req.params.filename)) || !filename.endsWith(".json")) {
				res.status(400).json({ error: "Invalid event filename" });
				return;
			}
			this.workspaceStore.assertWorkspaceAccess(userId, workspaceId);
			const filePath = join(this.workspaceStore.getWorkspaceRoot(workspaceId), "events", filename);
			if (existsSync(filePath)) rmSync(filePath, { force: true });
			res.json({ ok: true });
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	private getDatabaseFromFile(req: express.Request, res: express.Response): WorkspaceDatabase | undefined {
		const dbPath = String(req.query.path ?? "");
		const resolved = this.resolveReadableWorkspaceFile(req, dbPath, res);
		if (!resolved) return undefined;
		if (!resolved.toLowerCase().endsWith(".duckdb")) {
			res.status(400).json({ error: "Not a DuckDB file" });
			return undefined;
		}
		return new WorkspaceDatabase(resolved);
	}

	private handleDatabaseTables(req: express.Request, res: express.Response): void {
		const db = this.getDatabaseFromFile(req, res);
		if (!db) return;
		res.json({
			database: db.filename,
			available: db.exists,
			tables: db.listTables(),
		});
	}

	private handleDatabaseRows(req: express.Request, res: express.Response): void {
		const db = this.getDatabaseFromFile(req, res);
		if (!db) return;
		const tableName = decodeURIComponent(String(req.params.tableName));
		const table = db.getTableRows(tableName, {
			limit: Number(req.query.limit ?? 100),
			offset: Number(req.query.offset ?? 0),
		});
		if (!table) {
			res.status(404).json({ error: "Table not found" });
			return;
		}
		res.json(table);
	}

	private handleWorkspaceSessions(req: express.Request, res: express.Response): void {
		const userId = this.getUserId(req);
		const workspaceId = String(req.params.workspaceId);
		try {
			res.json(this.workspaceStore.listSessions(userId, workspaceId));
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	// Permanently delete a session: abort any active run, evict in-memory state,
	// remove the session dir, and propagate the delete to the object-store mirror
	// (a workspace-scoped snapshot alone would restore it on next boot).
	private async handleDeleteSession(req: express.Request, sessionId: string, res: express.Response): Promise<void> {
		const userId = this.getUserId(req);
		const session = this.workspaceStore.findSession(sessionId);
		if (!session) {
			res.status(404).json({ error: "Session not found" });
			return;
		}
		try {
			this.workspaceStore.assertWorkspaceAccess(userId, session.workspaceId);
			await this.handler.disposeSession?.(sessionId);
			const result = this.workspaceStore.deleteSession(userId, sessionId);
			if (!result) {
				res.status(404).json({ error: "Session not found" });
				return;
			}
			void this.objectStore?.deleteObjectsUnder(result.sessionRoot)
				.catch((err) => log.logWarning("[object-store] delete propagation error", err instanceof Error ? err.message : String(err)));
			res.json({ ok: true });
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	private handleCreateSession(req: express.Request, res: express.Response): void {
		const { title, userName } = req.body as { title?: string; userName?: string };
		const userId = this.getUserId(req, userName);
		const workspaceId = String(req.params.workspaceId);
		try {
			const session = this.workspaceStore.createSession({ workspaceId, userId, title });
			res.status(201).json(session);
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	private async handleChat(req: express.Request, res: express.Response, routeSessionId?: string): Promise<void> {
		type AttachmentPayload = { fileName: string; mimeType: string; content: string };
		const { channelId, sessionId: bodySessionId, workspaceId, text, userName = "user", attachments = [], mentions = [], skills = [], model: modelSel, structured = false } = req.body as {
			channelId?: string; sessionId?: string; workspaceId?: string; text?: string; userName?: string; attachments?: AttachmentPayload[];
			mentions?: MentionPayload[];
			/** Skill names the user invoked with `/name`. */
			skills?: string[];
			model?: { provider?: string; modelId?: string };
			structured?: boolean;
		};
		const sessionId = routeSessionId || bodySessionId || channelId;
		const userId = this.getUserId(req, userName);
		const resolvedUserName = this.getUserName(req, userName);

		let resolvedModel: BotContext["model"];
		if (modelSel?.provider && modelSel?.modelId && this.isAllowedLlmProvider(modelSel.provider)) {
			const encrypted = await this.auth.getStore().getProviderKey(userId, modelSel.provider);
			let apiKey: string | undefined;
			if (encrypted) {
				try {
					apiKey = decryptSecret(encrypted);
				} catch (err) {
					log.logWarning("[llm] failed to decrypt provider key", err instanceof Error ? err.message : String(err));
				}
			}
			resolvedModel = { provider: modelSel.provider, modelId: modelSel.modelId, apiKey };
		} else if (modelSel?.provider === "custom" && modelSel?.modelId) {
			const cm = await this.auth.getStore().getCustomModel(userId, modelSel.modelId);
			if (cm) {
				let apiKey: string | undefined;
				try {
					apiKey = decryptSecret(cm.encryptedKey);
				} catch (err) {
					log.logWarning("[llm] failed to decrypt custom model key", err instanceof Error ? err.message : String(err));
				}
				// For an OpenAI base provider, use the classic Chat Completions API and normalise
				// the endpoint. The OpenAI client appends /chat/completions and drops any query, so
				// the user's full Azure URL (…/deployments/<dep>/chat/completions?api-version=…) is
				// reduced to its deployment base here; the bosch-genai fetch adapter re-attaches the
				// api-version query + api-key header at request time. The Responses API default
				// ({endpoint}/responses) is not exposed by these gateways → 404.
				// google/anthropic ride the farm's Vertex publisher endpoint
				// (api/google/v1/publishers/{pub}/models/{id}:{method}); the adapter splits the
				// pasted URL into the SDK baseUrl + real model id and bridges auth/body at fetch
				// time. Falls back to cm.name when the URL carries no model segment.
				const isOpenAiBase = cm.baseProvider === "openai";
				let baseUrl: string;
				let modelId = cm.name;
				if (isOpenAiBase) {
					baseUrl = prepareBoschOpenAIEndpoint(cm.endpoint);
				} else if (cm.baseProvider === "google") {
					const g = prepareBoschGoogleEndpoint(cm.endpoint);
					baseUrl = g.baseUrl;
					modelId = g.modelId ?? cm.name;
				} else {
					const a = prepareBoschAnthropicEndpoint(cm.endpoint);
					baseUrl = a.baseUrl;
					modelId = a.modelId ?? cm.name;
				}
				resolvedModel = {
					provider: cm.baseProvider,   // openai|google|anthropic → drives header/body format
					modelId,
					apiKey,
					baseUrl,
					apiType: isOpenAiBase ? "openai-completions" : undefined,
				};
			}
		}
		// make the per-run model resolution visible in the server log so users
		// can verify the picker selection drives the outbound call (model self-reports lie).
		// A selection that cannot be resolved silently falls back to the default env model —
		// surface that as a warning instead of leaving it invisible.
		if (modelSel?.provider && modelSel?.modelId) {
			if (resolvedModel) {
				log.logInfo(
					`[llm] run model: ${resolvedModel.provider}/${resolvedModel.modelId}` +
					(resolvedModel.baseUrl ? ` @ ${resolvedModel.baseUrl}` : ""),
				);
			} else {
				log.logWarning(
					`[llm] model selection ${modelSel.provider}/${modelSel.modelId} could not be resolved; falling back to the default model`,
				);
			}
		}

		if (!sessionId || !text) {
			res.status(400).json({ error: "Missing sessionId or text" });
			return;
		}

		const session = this.workspaceStore.ensureSession({ sessionId, workspaceId, userId });
		try {
			this.workspaceStore.assertWorkspaceAccess(userId, session.workspaceId);
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
			return;
		}
		const workspaceRoot = this.workspaceStore.getWorkspaceRoot(session.workspaceId);

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		res.flushHeaders();
		res.write(":ok\n\n");

		const send: SseEmitter = (event) => {
			if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
		};

		const ts = (Date.now() / 1000).toFixed(6);
		const channelDir = join(workspaceRoot, "sessions", sessionId);
		if (!existsSync(channelDir)) mkdirSync(channelDir, { recursive: true });

		const savedAttachments: Array<{ local: string }> = [];
		if (attachments.length > 0) {
			const attachDir = join(channelDir, "attachments");
			if (!existsSync(attachDir)) mkdirSync(attachDir, { recursive: true });
			// One stamp for the whole batch: a picked folder keeps its files together under
			// a single stamped root instead of scattering them across per-file directories.
			const stamp = Date.now();
			for (const att of attachments) {
				const stored = this.storeAttachment(attachDir, att.fileName, att.content, stamp);
				if (!stored) {
					log.logWarning("[attachments] dropped", String(att.fileName));
					continue;
				}
				savedAttachments.push({ local: `sessions/${sessionId}/attachments/${stored}` });
			}
		}

		const resolvedMentions = mentions.length > 0 ? this.resolveMentions(req, mentions, workspaceRoot, sessionId) : [];
		const resolvedSkills = skills.length > 0 ? this.resolveSkills(skills, workspaceRoot, sessionId) : [];

		const ctx = createHttpContext({
			channelId: sessionId,
			userName: resolvedUserName,
			text,
			ts,
			send,
			workingDir: workspaceRoot,
			attachments: savedAttachments,
			mentions: resolvedMentions,
			skills: resolvedSkills,
			userId,
			authFilePath: this.getUserAuthFilePath(userId),
			model: resolvedModel,
			structured,
		});

		appendFileSync(
			join(channelDir, "log.jsonl"),
			`${JSON.stringify({ date: new Date().toISOString(), ts, user: userId, userName: resolvedUserName, text, attachments: savedAttachments, mentions: resolvedMentions, skills: resolvedSkills, isBot: false })}\n`,
		);

		log.logInfo(`[${sessionId}] HTTP: Starting run: ${text.substring(0, 50)}`);

		try {
			await this.handler.handleEvent(sessionId, ctx);
			ctx.flushAgentEvents?.();
			send({ type: "done" });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.logWarning(`[${sessionId}] HTTP run error`, msg);
			send({ type: "error", message: msg });
		} finally {
			ctx.flushAgentEvents?.();
			res.end();
		}
	}

	private async handleStop(req: express.Request, res: express.Response): Promise<void> {
		const { channelId } = req.body as { channelId?: string };
		if (!channelId) {
			res.status(400).json({ error: "Missing channelId" });
			return;
		}
		const session = this.workspaceStore.findSession(channelId);
		if (!session) {
			res.status(404).json({ error: "Session not found" });
			return;
		}
		try {
			this.workspaceStore.assertWorkspaceAccess(this.getUserId(req), session.workspaceId);
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
			return;
		}

		if (this.handler.isRunning(channelId)) {
			await this.handler.handleStop(channelId, async () => {}, async () => {});
			res.json({ ok: true, message: "Stopping..." });
		} else {
			res.json({ ok: false, message: "Nothing running" });
		}
	}

	private handleStatus(req: express.Request, channelId: string, res: express.Response): void {
		const session = this.workspaceStore.findSession(channelId);
		if (!session) {
			res.status(404).json({ error: "Session not found" });
			return;
		}
		try {
			this.workspaceStore.assertWorkspaceAccess(this.getUserId(req), session.workspaceId);
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
			return;
		}
		res.json({ running: this.handler.isRunning(channelId) });
	}

	private getAuthorizedSession(req: express.Request, channelId: string, res: express.Response) {
		const session = this.workspaceStore.findSession(channelId);
		if (!session) {
			res.status(404).json({ error: "Session not found" });
			return undefined;
		}
		try {
			this.workspaceStore.assertWorkspaceAccess(this.getUserId(req), session.workspaceId);
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
			return undefined;
		}
		return session;
	}

	/** Resolves the session-state store for a session, or null when unauthorized. */
	private getSessionStateStore(
		req: express.Request,
		channelId: string,
		res: express.Response,
	): SessionStateStore | null {
		const session = this.getAuthorizedSession(req, channelId, res);
		if (!session) return null;
		const workspaceRoot = this.workspaceStore.getWorkspaceRoot(session.workspaceId);
		return new SessionStateStore(channelId, join(workspaceRoot, "sessions", channelId));
	}

	private handleSessionMode(req: express.Request, channelId: string, res: express.Response): void {
		const store = this.getSessionStateStore(req, channelId, res);
		if (!store) return;
		res.json({ mode: store.getMode(), todos: store.getTodos() });
	}

	/**
	 * Switches a session between normal and plan mode. In plan mode the agent is
	 * restricted to read-only tools until it calls `exit_plan_mode`.
	 */
	private handleSetSessionMode(req: express.Request, channelId: string, res: express.Response): void {
		const requested = (req.body as { mode?: unknown } | undefined)?.mode;
		if (requested !== "plan" && requested !== "default") {
			res.status(400).json({ ok: false, error: 'mode must be "plan" or "default"' });
			return;
		}
		const store = this.getSessionStateStore(req, channelId, res);
		if (!store) return;
		store.setMode(requested);
		res.json({ ok: true, mode: store.getMode() });
	}

	private handleAcpJobs(req: express.Request, channelId: string, res: express.Response): void {
		const session = this.getAuthorizedSession(req, channelId, res);
		if (!session) return;
		if (!this.features.agentWorkers) {
			res.json({ jobs: [] });
			return;
		}
		const workspaceRoot = this.workspaceStore.getWorkspaceRoot(session.workspaceId);
		res.json({ jobs: listAcpJobs(workspaceRoot, channelId) });
	}

	private handleCancelAcpJob(req: express.Request, channelId: string, jobId: string, res: express.Response): void {
		const session = this.getAuthorizedSession(req, channelId, res);
		if (!session) return;
		if (!this.features.agentWorkers) {
			res.status(403).json({ ok: false, error: "Agent workers are disabled" });
			return;
		}
		const workspaceRoot = this.workspaceStore.getWorkspaceRoot(session.workspaceId);
		const ok = cancelAcpJob(workspaceRoot, jobId);
		res.json({ ok });
	}

	private handleArtifactUrl(req: express.Request, filePath: string, res: express.Response): void {
		const resolved = this.resolveReadableWorkspaceFile(req, filePath, res);
		if (!resolved) {
			return;
		}
		let url: string | null = null;

		const tunnelUrlFile = "/tmp/artifacts-url.txt";
		if (existsSync(tunnelUrlFile)) {
			try {
				const tunnelUrl = readFileSync(tunnelUrlFile, "utf-8").trim();
				if (tunnelUrl && !tunnelUrl.includes("localhost") && !tunnelUrl.includes("127.0.0.1")) {
					url = `${tunnelUrl}/file?path=${encodeURIComponent(resolved)}`;
				}
			} catch { /* use local fallback */ }
		}

		res.json({ url });
	}

	private handleWorkspace(req: express.Request, channelId: string, res: express.Response): void {
		type WorkspaceNode = { name: string; path: string; type: "file" | "directory"; children?: WorkspaceNode[] };

		const makeTree = (rootPath: string, relativeBase: string): WorkspaceNode[] => {
			if (!existsSync(rootPath)) return [];
			const walk = (absDir: string, relDir: string): WorkspaceNode[] => {
				const entries = readdirSync(absDir, { withFileTypes: true })
					.filter((e: Dirent) => e.name !== ADT_TREE_FILE && e.name !== ".adt-connection.json")
					.sort((a: Dirent, b: Dirent) => {
						if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
						return a.name.localeCompare(b.name);
					});
				return entries.map((entry) => {
					const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
					const normalizedPath = relativeBase ? `${relativeBase}/${relPath}` : relPath;
					if (entry.isDirectory()) {
						return {
							name: entry.name,
							path: normalizedPath,
							type: "directory" as const,
							children: walk(join(absDir, entry.name), relPath),
						};
					}
					return { name: entry.name, path: normalizedPath, type: "file" as const };
				});
			};
			return walk(rootPath, "");
		};

		const userId = this.getUserId(req);
		const session = this.workspaceStore.findSession(channelId) ?? this.workspaceStore.ensureSession({ sessionId: channelId, userId });
		try {
			this.workspaceStore.assertWorkspaceAccess(userId, session.workspaceId);
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
			return;
		}
		void this.objectStore?.snapshot({ workspaceId: session.workspaceId, sessionId: channelId })
			.catch((err) => log.logWarning("[object-store] workspace snapshot error", err instanceof Error ? err.message : String(err)));
		const workspaceRoot = this.workspaceStore.getWorkspaceRoot(session.workspaceId);
		const artifactsRoot = join(workspaceRoot, "artifacts");
		const workspaceSkillsRoot = join(workspaceRoot, "skills");
		// This session's uploads. Not rendered in the sidebar, but the @-mention
		// picker needs them: a file uploaded earlier in the conversation is exactly
		// the kind of thing a user wants to point at again.
		const attachmentsRoot = join(workspaceRoot, "sessions", channelId, "attachments");

		res.json({
			artifacts: makeTree(artifactsRoot, `workspaces/${session.workspaceId}/artifacts`),
			skills: makeTree(workspaceSkillsRoot, `workspaces/${session.workspaceId}/skills`),
			attachments: makeTree(attachmentsRoot, `workspaces/${session.workspaceId}/sessions/${channelId}/attachments`),
		});
	}

	private handleFile(req: express.Request, filePath: string, res: express.Response): void {
		const resolved = this.resolveReadableWorkspaceFile(req, filePath, res);
		if (!resolved) {
			return;
		}

		if (!existsSync(resolved)) {
			res.status(404).json({ error: "Not found" });
			return;
		}

		if (statSync(resolved).isDirectory()) {
			if (req.query.download === "1") {
				void this.sendFolderZip(resolved, res);
			} else {
				res.status(400).json({ error: "Path is a directory" });
			}
			return;
		}

		const ext = extname(resolved).slice(1).toLowerCase();
		const mimeType = BINARY_MIME_TYPES[ext];
		if (mimeType) {
			res.type(mimeType);
		} else if (["abap", "cds", "csn"].includes(ext)) {
			res.type("text/plain");
		}
		if (req.query.download === "1") {
			res.attachment(basename(resolved));
		}

		res.sendFile(resolved);
	}

	// Send a folder to the client as a .zip archive. Artifact folders are small,
	// so the archive is built in memory rather than streamed.
	private async sendFolderZip(dir: string, res: express.Response): Promise<void> {
		try {
			const zip = new JSZip();
			const addDir = (absDir: string, relDir: string) => {
				for (const entry of readdirSync(absDir, { withFileTypes: true })) {
					const abs = join(absDir, entry.name);
					const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
					if (entry.isDirectory()) {
						addDir(abs, rel);
					} else if (entry.isFile()) {
						zip.file(rel, readFileSync(abs));
					}
				}
			};
			addDir(dir, "");
			const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
			res.type("application/zip");
			res.attachment(`${basename(dir)}.zip`);
			res.send(buffer);
		} catch (err) {
			res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	// Delete a workspace file or folder (recursive) and propagate the delete to the
	// object-store mirror (a workspace-scoped snapshot alone would restore it on next boot).
	private handleDeleteFile(req: express.Request, filePath: string, res: express.Response): void {
		const resolved = this.resolveReadableWorkspaceFile(req, filePath, res);
		if (!resolved) {
			return;
		}

		if (!existsSync(resolved)) {
			res.status(404).json({ error: "Not found" });
			return;
		}
		const isDirectory = statSync(resolved).isDirectory();

		try {
			rmSync(resolved, isDirectory ? { recursive: true, force: true } : {});
		} catch (err) {
			res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
			return;
		}
		const propagate = isDirectory
			? this.objectStore?.deleteObjectsUnder(resolved)
			: this.objectStore?.deleteObject(resolved);
		void propagate?.catch((err) => log.logWarning("[object-store] delete propagation error", err instanceof Error ? err.message : String(err)));
		res.json({ ok: true });
	}

	// POST /workspaces/:workspaceId/skills
	// Writes an uploaded skill folder into workspaces/<id>/skills/<name>/, preserving the
	// client's relative paths. Bytes arrive base64-encoded in the JSON body, matching the
	// chat attachment convention (there is no multipart parser in this service).
	private handleUploadSkill(req: express.Request, res: express.Response): void {
		const ctx = this.assertWorkspaceRole(req, res, true);
		if (!ctx) return;

		const { folderName, overwrite = false, files } = req.body as {
			folderName?: unknown;
			overwrite?: boolean;
			files?: Array<{ path?: unknown; content?: unknown }>;
		};

		if (!Array.isArray(files) || files.length === 0) {
			res.status(400).json({ error: "No files to upload" });
			return;
		}
		if (files.length > MAX_SKILL_UPLOAD_FILES) {
			res.status(413).json({ error: `Too many files (${files.length}); the limit is ${MAX_SKILL_UPLOAD_FILES}` });
			return;
		}

		const skillName = this.sanitizeConnectionName(folderName);
		if (!skillName || skillName === "." || skillName === "..") {
			res.status(400).json({ error: "Invalid skill folder name" });
			return;
		}

		const skillRoot = join(this.workspaceStore.getWorkspaceRoot(ctx.workspaceId), "skills", skillName);

		// Validate and decode everything up front so a bad payload cannot leave a
		// half-written skill behind. Paths are relative to the picked folder: absolute
		// paths, drive letters and "." / ".." segments are all rejected rather than
		// normalized away.
		const planned: Array<{ abs: string; bytes: Buffer }> = [];
		const skipped: string[] = [];
		let totalBytes = 0;
		for (const file of files) {
			const raw = String(file?.path ?? "").replace(/\\/g, "/");
			const segments = raw.split("/");
			// Folder pickers prefix every path with the picked folder itself.
			if (segments.length > 1 && this.sanitizeConnectionName(segments[0]) === skillName) segments.shift();
			if (segments.length === 0 || segments.some((seg) => seg === "" || seg === "." || seg === ".." || seg.includes(":"))) {
				res.status(400).json({ error: `Invalid file path: ${raw}` });
				return;
			}
			if (SKILL_UPLOAD_SKIP_NAMES.has(segments[segments.length - 1]) || segments.some((seg) => SKILL_UPLOAD_SKIP_DIRS.has(seg))) {
				skipped.push(segments.join("/"));
				continue;
			}
			const abs = resolve(join(skillRoot, ...segments));
			const rel = relative(skillRoot, abs);
			if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
				res.status(400).json({ error: `Invalid file path: ${raw}` });
				return;
			}
			const bytes = Buffer.from(String(file?.content ?? ""), "base64");
			totalBytes += bytes.byteLength;
			if (totalBytes > MAX_SKILL_UPLOAD_BYTES) {
				res.status(413).json({ error: `Skill folder is too large; the limit is ${Math.floor(MAX_SKILL_UPLOAD_BYTES / (1024 * 1024))} MB` });
				return;
			}
			planned.push({ abs, bytes });
		}

		if (planned.length === 0) {
			res.status(400).json({ error: "No files to upload" });
			return;
		}

		// Checked after validation so a malformed payload reports the real problem
		// instead of a conflict on a name it was never allowed to write.
		if (existsSync(skillRoot) && !overwrite) {
			res.status(409).json({ error: `Skill "${skillName}" already exists`, code: "exists", skillName });
			return;
		}

		try {
			// Replace rather than merge, so files dropped from the new version do not
			// linger. The mirror delete matters too: a workspace snapshot alone would
			// restore the stale files on the next boot.
			if (existsSync(skillRoot)) {
				rmSync(skillRoot, { recursive: true, force: true });
				void this.objectStore
					?.deleteObjectsUnder(skillRoot)
					.catch((err) => log.logWarning("[object-store] skill replace propagation error", err instanceof Error ? err.message : String(err)));
			}
			for (const entry of planned) {
				mkdirSync(dirname(entry.abs), { recursive: true });
				writeFileSync(entry.abs, entry.bytes);
			}
		} catch (err) {
			res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
			return;
		}

		void this.objectStore
			?.snapshot({ workspaceId: ctx.workspaceId })
			.catch((err) => log.logWarning("[object-store] skill upload propagation error", err instanceof Error ? err.message : String(err)));

		res.json({
			ok: true,
			skillName,
			path: `workspaces/${ctx.workspaceId}/skills/${skillName}`,
			fileCount: planned.length,
			skipped,
		});
	}

	private handleMessages(req: express.Request, channelId: string, res: express.Response): void {
		type ContextEntry = { type: string; timestamp?: string; message?: Record<string, any> };
		type ReplayBlock =
			| { kind: "thinking"; content: string }
			| { kind: "text"; content: string }
			| {
				kind: "tool";
				toolCallId: string;
				toolName: string;
				label?: string;
				args: Record<string, any>;
				result?: string;
				resultTruncated?: boolean;
				isError?: boolean;
				durationMs?: number;
				skill?: { name: string; path: string };
			};
		type ChatMessage = {
			role: "user" | "assistant";
			text: string;
			attachments?: string[];
			/** Basenames of files/folders the user tagged with @ on this turn. */
			mentions?: string[];
			thread?: string;
			files?: Array<{ path: string; title?: string }>;
			blocks?: ReplayBlock[];
			usage?: AgentUsage;
			model?: string;
		};

		const formatArgs = (args: Record<string, any>): string => {
			const lines: string[] = [];
			for (const [key, value] of Object.entries(args)) {
				if (key === "label") continue;
				if (key === "path" && typeof value === "string") {
					const range = args.offset !== undefined && args.limit !== undefined
						? `:${args.offset}-${args.offset + args.limit}` : "";
					lines.push(value + range);
					continue;
				}
				if (key === "offset" || key === "limit") continue;
				const str = typeof value === "string" ? value : JSON.stringify(value);
				lines.push(str.length > 300 ? str.slice(0, 300) + "…" : str);
			}
			return lines.join("\n");
		};

		const userId = this.getUserId(req);
		const session = this.workspaceStore.findSession(channelId) ?? this.workspaceStore.ensureSession({ sessionId: channelId, userId });
		try {
			this.workspaceStore.assertWorkspaceAccess(userId, session.workspaceId);
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
			return;
		}
		const workspaceRoot = this.workspaceStore.getWorkspaceRoot(session.workspaceId);
		const contextFile = join(workspaceRoot, "sessions", channelId, "context.jsonl");
		const messages: ChatMessage[] = [];

		const trailDurations = new Map<string, number>();
		const trailSkills = new Map<string, { name: string; path: string }>();
		for (const record of readTrail(join(workspaceRoot, "sessions", channelId))) {
			const ev = record.event;
			if (ev.type === "tool" && ev.phase === "end") trailDurations.set(ev.toolCallId, ev.durationMs);
			else if (ev.type === "skill") trailSkills.set(ev.toolCallId, { name: ev.name, path: ev.path });
		}

		if (existsSync(contextFile)) {
			try {
				const lines = readFileSync(contextFile, "utf-8").trim().split("\n").filter(Boolean);
				const entries: ContextEntry[] = [];
				for (const line of lines) {
					try { entries.push(JSON.parse(line)); } catch { /* skip */ }
				}

				type ToolCall = { id: string; name: string; label?: string; args: Record<string, any> };
				type ToolResult = { toolCallId: string; toolName: string; text: string; isError: boolean };
				type Turn = { userText: string; attachments: string[]; mentions: string[]; toolCalls: ToolCall[]; toolResults: ToolResult[]; assistantTexts: string[]; blocks: ReplayBlock[]; usage?: AgentUsage; model?: string };
				const normalizeAttachedFilePath = (rawPath: string): string => {
					const dockerWorkspacePrefix = `/workspace/workspaces/${session.workspaceId}/`;
					if (rawPath === `/workspace/workspaces/${session.workspaceId}`) return workspaceRoot;
					if (rawPath.startsWith(dockerWorkspacePrefix)) return join(workspaceRoot, rawPath.slice(dockerWorkspacePrefix.length));
					if (rawPath === "/workspace") return workspaceRoot;
					if (rawPath.startsWith("/workspace/")) return join(workspaceRoot, rawPath.slice("/workspace/".length));
					if (isAbsolute(rawPath)) return rawPath;
					if (rawPath.startsWith("workspaces/")) return rawPath;
					if (rawPath.startsWith("artifacts/") || rawPath.startsWith("sessions/") || rawPath.startsWith("skills/")) {
						return join(workspaceRoot, rawPath);
					}
					return join(workspaceRoot, "artifacts", rawPath);
				};

				const stripPrefix = (text: string) =>
					text.replace(/^(?:\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] )?\[[^\]]+\]: /, "");

				const basenameOf = (p: string) => p.split(/[/\\]/).pop() ?? p;

				/**
				 * Both trailing blocks are appended to the user message by the agent, so
				 * they must be lifted back out here or they render as message text.
				 * Mention lines carry a `file:`/`dir:` tag that is stripped for display.
				 */
				const extractAttachments = (text: string): { text: string; attachments: string[]; mentions: string[] } => {
					let rest = text;
					let attachments: string[] = [];
					let mentions: string[] = [];

					const attachMatch = rest.match(/<attachments>\n([\s\S]*?)\n<\/attachments>/);
					if (attachMatch) {
						attachments = attachMatch[1].split("\n").filter(Boolean).map(basenameOf);
						rest = rest.replace(/\n\n<attachments>[\s\S]*?<\/attachments>/, "");
					}

					const mentionMatch = rest.match(/<mentions>\n([\s\S]*?)\n<\/mentions>/);
					if (mentionMatch) {
						mentions = mentionMatch[1]
							.split("\n")
							.filter(Boolean)
							.map((line) => basenameOf(line.replace(/^(?:file|dir):\s*/, "")));
						rest = rest.replace(/\n\n<mentions>[\s\S]*?<\/mentions>/, "");
					}

					// Skills need no chips of their own: the `/name` the user typed is still
					// in the text. Only the appended block has to go.
					rest = rest.replace(/\n\n<skills>[\s\S]*?<\/skills>/, "");

					return { text: rest.trim(), attachments, mentions };
				};

				const turns: Turn[] = [];

				for (const entry of entries) {
					if (entry.type !== "message" || !entry.message) continue;
					const msg = entry.message;

					if (msg.role === "user") {
						const textPart = (msg.content as any[])?.find((c: any) => c.type === "text");
						if (!textPart?.text) continue;
						const { text: cleanText, attachments, mentions: turnMentions } = extractAttachments(stripPrefix(textPart.text));
						turns.push({ userText: cleanText, attachments, mentions: turnMentions, toolCalls: [], toolResults: [], assistantTexts: [], blocks: [] });
					} else if (msg.role === "assistant") {
						if (turns.length === 0) continue;
						const turn = turns[turns.length - 1];
						for (const part of (msg.content as any[]) || []) {
							if (part.type === "toolCall") {
								turn.toolCalls.push({ id: part.id, name: part.name, label: part.arguments?.label, args: part.arguments ?? {} });
								turn.blocks.push({
									kind: "tool",
									toolCallId: part.id,
									toolName: part.name,
									label: part.arguments?.label,
									args: part.arguments ?? {},
									durationMs: trailDurations.get(part.id),
									skill: trailSkills.get(part.id),
								});
							} else if (part.type === "text" && part.text?.trim()) {
								turn.assistantTexts.push(part.text.trim());
								turn.blocks.push({ kind: "text", content: part.text.trim() });
							} else if (part.type === "thinking" && part.thinking?.trim()) {
								turn.blocks.push({ kind: "thinking", content: part.thinking.trim() });
							}
						}
						if (msg.model) {
							turn.model = msg.provider ? `${msg.provider}/${msg.responseModel || msg.model}` : String(msg.responseModel || msg.model);
						}
						if (msg.usage) {
							const u = msg.usage as AgentUsage;
							if (!turn.usage) {
								turn.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
							}
							turn.usage.input += u.input ?? 0;
							turn.usage.output += u.output ?? 0;
							turn.usage.cacheRead += u.cacheRead ?? 0;
							turn.usage.cacheWrite += u.cacheWrite ?? 0;
							if (u.cost) {
								turn.usage.cost.input += u.cost.input ?? 0;
								turn.usage.cost.output += u.cost.output ?? 0;
								turn.usage.cost.cacheRead += u.cost.cacheRead ?? 0;
								turn.usage.cost.cacheWrite += u.cost.cacheWrite ?? 0;
								turn.usage.cost.total += u.cost.total ?? 0;
							}
						}
					} else if (msg.role === "toolResult") {
						if (turns.length === 0) continue;
						const turn = turns[turns.length - 1];
						const text = (msg.content as any[])?.find((c: any) => c.type === "text")?.text ?? "";
						turn.toolResults.push({ toolCallId: msg.toolCallId, toolName: msg.toolName, text, isError: msg.isError });
						const toolBlock = turn.blocks.find(
							(b) => b.kind === "tool" && b.toolCallId === msg.toolCallId && b.result === undefined,
						) as Extract<ReplayBlock, { kind: "tool" }> | undefined;
						if (toolBlock) {
							const { text: truncatedResult, truncated } = truncateToolResult(text);
							toolBlock.result = truncatedResult;
							toolBlock.resultTruncated = truncated;
							toolBlock.isError = msg.isError;
						}
					}
				}

				for (const turn of turns) {
					messages.push({
						role: "user",
						text: turn.userText,
						attachments: turn.attachments.length > 0 ? turn.attachments : undefined,
						mentions: turn.mentions.length > 0 ? turn.mentions : undefined,
					});

					const mainText = turn.assistantTexts[turn.assistantTexts.length - 1] ?? "";
					const threadParts: string[] = [];
					const files: Array<{ path: string; title?: string }> = [];

					for (const tc of turn.toolCalls) {
						const result = turn.toolResults.find((r) => r.toolCallId === tc.id);
						let block = `**${result?.isError ? "✗" : "✓"} ${tc.name}**`;
						if (tc.label) block += `: ${tc.label}`;
						const argsStr = formatArgs(tc.args);
						if (argsStr) block += `\n\`\`\`\n${argsStr}\n\`\`\``;
						if (result) {
							const resultStr = result.text;
							block += `\n**Result:**\n\`\`\`\n${resultStr.slice(0, 500)}${resultStr.length > 500 ? "\n…" : ""}\n\`\`\``;
						}
						threadParts.push(block);
						if (tc.name === "attach" && tc.args.path) {
							files.push({
								path: normalizeAttachedFilePath(tc.args.path as string),
								title: tc.args.title as string | undefined,
							});
						}
					}

					const thread = threadParts.length > 0 ? threadParts.join("\n\n") : undefined;
					if (mainText || thread || turn.blocks.length > 0) {
						messages.push({
							role: "assistant",
							text: mainText,
							thread,
							files: files.length > 0 ? files : undefined,
							blocks: turn.blocks.length > 0 ? turn.blocks : undefined,
							usage: turn.usage,
							model: turn.model,
						});
					}
				}
			} catch { /* unreadable file */ }
		}

		res.json(messages);
	}

	private handleSessions(req: express.Request, res: express.Response): void {
		const userId = this.getUserId(req);
		const workspaceId = String(req.query.workspaceId || this.workspaceStore.ensureDefaultWorkspace(userId).id);
		try {
			res.json(this.workspaceStore.listSessions(userId, workspaceId));
		} catch (err) {
			res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
		}
	}
}
