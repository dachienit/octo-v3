// Whole-tree durability for the data root via the objectstore-service HTTP gateway.
//
// On Cloud Foundry the container filesystem is ephemeral, so every file under the
// data root (auth.sqlite, users/, workspaces/**) is lost on restart/restage
// (templates/ is excluded — regenerated from the bundled package on boot).
// We mirror the whole data root through the shared HTTP gateway
// (objectstore-service), which fronts the SAP Object Store bucket with its own binding:
//   - boot                → restore()  : download the boot-critical set onto the FS,
//                           before WorkspaceStore / auth.sqlite touch the data root
//   - workspace opened    → hydrateWorkspace(id) : that workspace's bulk, once
//   - SIGTERM / SIGINT    → snapshot() : full tree upload + delete-sync
//   - workspace refresh   → snapshot({ workspaceId }) : that workspace's subtree only
//
// Downloads run concurrently and boot is lazy by default: the cost of a restore is one
// HTTPS round-trip per file, so a tree of a few thousand small session files used to
// take over a minute serially and got the app killed by CF's startup health check.
//
// octo holds no S3 credentials and binds no objectstore service; all object I/O is
// HTTP calls to the gateway with an x-api-key header.
//
// Keys are the fixed deployment prefix plus the dataRoot-relative path:
//   <CORE_SERVICE_OBJECTSTORE_PREFIX><rel>
//   e.g.  robert-bosch-gmbh-rb-bd-vn-hub-d-bt234d00/octo/auth.sqlite
// The prefix must match the scope bound to the gateway API key (403 otherwise).
//
// Single-writer: the whole prefix maps to one shared local data root. Do NOT scale
// octo-srv instances > 1 while the mirror is active — two instances would snapshot
// over each other. Delete-sync only runs once restore() has succeeded, so a failed
// restore never wipes the bucket.

import { access, mkdir, readdir, readFile, stat, writeFile } from "fs/promises";
import { dirname, join, relative, sep } from "path";

// A snapshot of the mirror's runtime state, surfaced via GET /objectstore/status
// so operators can confirm the backend is live even after logs have rotated.
// Contains no secrets — only the gateway/bucket label and operation counters.
export interface ObjectStoreStatus {
	bucket: string;
	prefix: string;
	restoreCompleted: boolean;
	restoredCount: number;
	/** false once boot only downloaded the boot-critical set (lazy restore). */
	fullyHydrated: boolean;
	/** Workspace ids whose subtree has been pulled down on demand this process. */
	hydratedWorkspaces: string[];
	lastSnapshotAt?: string;
	lastSnapshotUploaded?: number;
	lastSnapshotDeleted?: number;
	lastError?: string;
}

// The objectstore-tester app writes its self-test keys under <prefix>/_tester/. Never
// restore them onto our FS and never delete them during delete-sync.
const TESTER_PREFIX = "_tester/";

// Transient/working files that should never be mirrored (matched against the
// dataRoot-relative, forward-slash path).
const SKIP_FILE_PATTERNS = [/\.wal$/, /\.shm$/, /\.lock$/, /(^|[\\/])last_prompt\.jsonl$/];

// templates/ is regenerated from the bundled package templates on every
// boot (WorkspaceStore constructor) — never mirror it. Existing templates/** keys
// already in the bucket are intentionally left untouched (deleteSync also skips them).
const TEMPLATES_PREFIX = "templates/";

//IYH1HC sapgit init
// Git internals are never mirrored. `sapgit clone` makes every SAP connection folder
// a git repository, and a repo is thousands of tiny files: the cost here is one HTTPS
// round-trip per file, not the bytes (see RESTORE_CONCURRENCY below — a ~3k-file tree
// was already enough to fail the CF startup check).
//
// The deciding argument is correctness, not cost. Restore is neither ordered nor
// atomic, so a half-downloaded .git (refs present, packfile still pending under lazy
// restore) is a *corrupt* repository, which is strictly worse than no repository at
// all. The history is therefore container-local and does not survive a restart —
// acceptable because a connection folder is a re-fetchable projection of the SAP
// system, which is the same reason disconnect deletes it outright (http.ts,
// handleSapDeleteConnection). Do not "fix" this by mirroring .git.
const SKIP_DIR_SEGMENTS = new Set([".git"]);

// A relative path (e.g. "workspaces/ws_1/sessions/s_1/log.jsonl") that must not be
// mirrored — a transient file, git internals, or the tester's reserved subtree.
function shouldSkip(relPath: string): boolean {
	if (relPath.startsWith(TESTER_PREFIX)) return true;
	if (relPath.startsWith(TEMPLATES_PREFIX)) return true;
	// Segment-wise, so a file merely *named* ".git"-something is not caught, and the
	// check holds at any depth (artifacts/<conn>/.git/**).
	if (relPath.split("/").some((segment) => SKIP_DIR_SEGMENTS.has(segment))) return true;
	return SKIP_FILE_PATTERNS.some((re) => re.test(relPath));
}

function parsePositiveIntEnv(name: string, fallback: number): number {
	const parsed = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// How many object downloads run at once during restore/hydrate. The boot used to
// download strictly one-at-a-time, which is what made a ~3k-file tree take over a
// minute and get the app killed by the Cloud Foundry startup health check: the cost
// is one HTTPS round-trip per file, not the bytes.
const RESTORE_CONCURRENCY = parsePositiveIntEnv("CORE_SERVICE_OBJECTSTORE_RESTORE_CONCURRENCY", 16);

// Per-request deadline. Without one, Node's fetch inherits undici's 300s headers
// timeout, so a dropped connection hangs the whole boot in total silence.
const REQUEST_TIMEOUT_MS = parsePositiveIntEnv("CORE_SERVICE_OBJECTSTORE_REQUEST_TIMEOUT_MS", 60_000);

// Any single gateway call slower than this is logged with its key — the way to spot
// one oversized artifact stalling a restore that is otherwise healthy.
const SLOW_REQUEST_MS = 3_000;

// Log restore progress every N files so a slow restore is visible while it runs
// instead of only in the summary line at the end.
const RESTORE_PROGRESS_EVERY = 100;

// Lazy restore: boot downloads only what the first screen needs, and each workspace's
// bulk (sessions/artifacts/events/skills) arrives on first access. Set to "false" to
// go back to downloading the whole tree at boot.
const LAZY_RESTORE = (process.env.CORE_SERVICE_OBJECTSTORE_LAZY_RESTORE ?? "true").toLowerCase() !== "false";

// Scope key for the boot-critical set (auth DB + users + workspace metadata), as
// opposed to the per-workspace scope keys "workspaces/<id>".
const ROOT_SCOPE = "";

// Which dataRoot-relative paths the process cannot serve correctly without, and so
// must be on disk before the first request:
//   - auth.sqlite            opened by auth.init()
//   - users/**               each user's auth.json
//   - workspace/members.json listWorkspaces() reads these for EVERY workspace
//   - sessions/*/session.json  WorkspaceStore.findSession() locates a session by
//     scanning the local workspaces tree. If these were lazy, a known session id would
//     look missing and ensureSession() would create an empty session over it, orphaning
//     the real history — a correctness bug, not just a slow path. They are tiny
//     metadata files; the bulk (log.jsonl, trail.jsonl, attachments) stays lazy.
// Everything else under a workspace is deferred to hydrateWorkspace().
function isBootCritical(relPath: string): boolean {
	if (relPath === "auth.sqlite") return true;
	if (relPath.startsWith("users/")) return true;
	if (/^workspaces\/[^/]+\/(workspace|members)\.json$/.test(relPath)) return true;
	return /^workspaces\/[^/]+\/sessions\/[^/]+\/session\.json$/.test(relPath);
}

// The workspace id owning a dataRoot-relative path, or undefined when the path is not
// inside a workspace.
function workspaceIdOf(relPath: string): string | undefined {
	return /^workspaces\/([^/]+)\//.exec(relPath)?.[1];
}

// Normalize the fixed key prefix: strip surrounding whitespace and leading slashes,
// force exactly one trailing slash. Throws on empty — an empty prefix would mirror
// against the bucket root, which the prefix-scoped API key rejects anyway.
function normalizePrefix(raw: string): string {
	const clean = raw.trim().replace(/^\/+/, "").replace(/\/+$/, "");
	if (!clean) throw new Error("[object-store] CORE_SERVICE_OBJECTSTORE_PREFIX must not be empty");
	return `${clean}/`;
}

// Resolve the gateway store from the environment. Returns undefined when no gateway
// URL is configured (→ caller runs ephemeral). A gateway URL without a prefix is a
// config bug and throws — even with ALLOW_EPHEMERAL — rather than mirroring under a
// wrong/empty scope.
export function resolveObjectStoreGateway(dataRoot: string): ObjectStoreGateway | undefined {
	const gatewayUrl = process.env.CORE_SERVICE_OBJECTSTORE_GATEWAY_URL;
	if (!gatewayUrl) return undefined;
	const rawPrefix = process.env.CORE_SERVICE_OBJECTSTORE_PREFIX;
	if (!rawPrefix || !rawPrefix.trim()) {
		throw new Error(
			"[object-store] CORE_SERVICE_OBJECTSTORE_GATEWAY_URL is set but CORE_SERVICE_OBJECTSTORE_PREFIX is missing — " +
				"set it to the full key prefix bound to the gateway API key.",
		);
	}
	return new ObjectStoreGateway({
		gatewayUrl,
		dataRoot,
		prefix: normalizePrefix(rawPrefix),
		apiKey: process.env.CORE_SERVICE_OBJECTSTORE_GATEWAY_API_KEY || undefined,
	});
}

interface FileStamp {
	mtimeMs: number;
	size: number;
}

interface GatewayListPage {
	objects?: Array<{ key?: string }>;
	nextToken?: string;
}

export class ObjectStoreGateway {
	private readonly gatewayUrl: string;
	private readonly apiKey: string | undefined;
	private readonly dataRoot: string;
	// The fixed key prefix every object lives under (normalized, trailing slash).
	private readonly prefix: string;
	// Per-file stamp of the last successfully uploaded version — lets snapshot()
	// skip unchanged files. In-memory only (rebuilt over the process lifetime).
	private readonly uploaded = new Map<string, FileStamp>();
	// Serializes snapshots so a refresh and shutdown snapshot never overlap
	// (which would race on the same keys). Each call chains after the last.
	private snapshotChain: Promise<void> = Promise.resolve();
	// Becomes true once restore() finishes. Delete-sync is gated on this so an
	// ephemeral boot (restore skipped/failed) can never wipe the bucket.
	private restoreCompleted = false;
	// Subtrees fully downloaded onto the local FS by this process: ROOT_SCOPE for the
	// boot-critical set, "workspaces/<id>" per hydrated workspace. Delete-sync is
	// confined to these — under lazy restore, "no local file" means "not fetched yet"
	// for everything else, and deleting those keys would destroy the bucket.
	private readonly hydrated = new Set<string>();
	// True after a full (non-lazy) restore: every key is then backed by a local file,
	// so delete-sync may consider the whole prefix.
	private fullyHydrated = false;
	// In-flight hydrations, keyed by scope, so concurrent requests for the same
	// workspace share one download instead of racing on the same files.
	private readonly hydrating = new Map<string, Promise<void>>();
	private restoredCount = 0;
	private lastSnapshotAt: string | undefined;
	private lastSnapshotUploaded = 0;
	private lastSnapshotDeleted = 0;
	private lastError: string | undefined;

	constructor(opts: { gatewayUrl: string; dataRoot: string; prefix: string; apiKey?: string }) {
		this.gatewayUrl = opts.gatewayUrl.replace(/\/+$/, "");
		this.apiKey = opts.apiKey;
		this.dataRoot = opts.dataRoot;
		this.prefix = opts.prefix;
	}

	get bucketName(): string {
		try {
			return `gateway:${new URL(this.gatewayUrl).host}`;
		} catch {
			return `gateway:${this.gatewayUrl}`;
		}
	}

	status(): ObjectStoreStatus {
		return {
			bucket: this.bucketName,
			prefix: this.prefix,
			restoreCompleted: this.restoreCompleted,
			restoredCount: this.restoredCount,
			fullyHydrated: this.fullyHydrated,
			hydratedWorkspaces: [...this.hydrated].filter((s) => s !== ROOT_SCOPE).map((s) => s.slice("workspaces/".length)),
			lastSnapshotAt: this.lastSnapshotAt,
			lastSnapshotUploaded: this.lastSnapshotUploaded,
			lastSnapshotDeleted: this.lastSnapshotDeleted,
			lastError: this.lastError,
		};
	}

	// Throws if the gateway is not reachable/ready — used to choose fail-fast vs
	// ephemeral.
	async verify(): Promise<void> {
		const startedAt = Date.now();
		console.log(`[object-store] verify ${this.bucketName} prefix=${this.prefix} apiKey=${this.apiKey ? "set" : "MISSING"}`);
		const res = await this.gwFetch("/health", { method: "GET" });
		if (!res.ok) throw new Error(`gateway /health returned ${res.status}`);
		const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
		if (!data.ok) throw new Error("gateway reports object store not bound (ok=false)");
		console.log(`[object-store] verify ok in ${Date.now() - startedAt}ms`);
	}

	// Download mirrored objects back onto the local FS. Runs once at boot, before
	// WorkspaceStore / auth.sqlite touch the data root. Only files are written; empty
	// dirs are recreated by WorkspaceStore on demand.
	//
	// Under lazy restore the boot pass takes only the boot-critical set (see
	// isBootCritical) and each workspace's bulk is fetched later by
	// hydrateWorkspace(). Downloads run concurrently — one round-trip per file
	// serialized was what pushed a ~35MB tree past Cloud Foundry's 60s startup check.
	async restore(): Promise<void> {
		const scope = LAZY_RESTORE ? "boot" : "all";
		const keys = await this.collectKeys(this.prefix, (rel) => scope === "all" || isBootCritical(rel));
		const restored = await this.download(keys, `restore(${scope})`);
		this.restoredCount = restored;
		this.restoreCompleted = true;
		this.hydrated.add(ROOT_SCOPE);
		if (scope === "all") this.fullyHydrated = true;
		console.log(
			`[object-store] restore(${scope}) complete: ${restored} file(s) from ${this.prefix} via ${this.bucketName}` +
				(scope === "boot" ? " — workspace content is fetched on first access" : ""),
		);
	}

	// Pull one workspace's subtree down on first access. Memoized per workspace, so
	// concurrent requests share a single download and a hydrated workspace costs
	// nothing. A failed hydration is not memoized — the next request retries.
	//
	// Registering the scope in `hydrated` is also what permits delete-sync to touch
	// this workspace's keys later; see deleteSync.
	hydrateWorkspace(workspaceId: string): Promise<void> {
		if (this.fullyHydrated || !workspaceId) return Promise.resolve();
		const scopeKey = `workspaces/${workspaceId}`;
		if (this.hydrated.has(scopeKey)) return Promise.resolve();
		const inFlight = this.hydrating.get(scopeKey);
		if (inFlight) return inFlight;

		const task = (async () => {
			const startedAt = Date.now();
			const keys = await this.collectKeys(`${this.prefix}${scopeKey}/`, () => true);
			const restored = await this.download(keys, `hydrate(${workspaceId})`);
			this.hydrated.add(scopeKey);
			console.log(`[object-store] hydrated workspace ${workspaceId}: ${restored} file(s) in ${Date.now() - startedAt}ms`);
		})();

		this.hydrating.set(scopeKey, task);
		// Drop the memo on failure so the scope is never marked hydrated by a partial
		// download (which would let delete-sync wipe the rest of the workspace).
		return task.finally(() => this.hydrating.delete(scopeKey));
	}

	// List every mirrored key under a key prefix that `accept` keeps, judged on the
	// dataRoot-relative path. Folder markers, transients and the tester subtree are
	// dropped here so callers only ever see real files.
	private async collectKeys(keyPrefix: string, accept: (relPath: string) => boolean): Promise<string[]> {
		const keys: string[] = [];
		for await (const key of this.listKeys(keyPrefix)) {
			const rel = key.startsWith(this.prefix) ? key.slice(this.prefix.length) : undefined;
			if (rel === undefined || rel === "" || shouldSkip(rel)) continue;
			if (!accept(rel)) continue;
			keys.push(key);
		}
		return keys;
	}

	// Download the given keys onto the local FS with RESTORE_CONCURRENCY workers.
	// Best-effort per file: one failure is logged and the rest continue, matching the
	// previous sequential behaviour. Returns how many files landed on disk.
	private async download(keys: string[], label: string): Promise<number> {
		const startedAt = Date.now();
		let cursor = 0;
		let restored = 0;
		let bytesTotal = 0;

		const worker = async (): Promise<void> => {
			// Plain index bump is safe: JS is single-threaded between awaits, so each
			// worker claims a distinct key.
			while (cursor < keys.length) {
				const key = keys[cursor++];
				const bytes = await this.restoreOne(key);
				if (bytes === undefined) continue;
				restored++;
				bytesTotal += bytes;
				if (restored % RESTORE_PROGRESS_EVERY === 0) {
					console.log(
						`[object-store] ${label} progress: ${restored}/${keys.length} file(s), ${bytesTotal} bytes, +${Date.now() - startedAt}ms`,
					);
				}
			}
		};

		console.log(`[object-store] ${label}: ${keys.length} object(s) to download, concurrency ${RESTORE_CONCURRENCY}`);
		await Promise.all(Array.from({ length: Math.min(RESTORE_CONCURRENCY, keys.length) }, worker));
		console.log(`[object-store] ${label}: ${restored} file(s), ${bytesTotal} bytes in ${Date.now() - startedAt}ms`);
		return restored;
	}

	// Fetch a single object onto the local FS. Returns the byte count written, or
	// undefined when the object was missing or the download failed.
	private async restoreOne(key: string): Promise<number | undefined> {
		const rel = key.startsWith(this.prefix) ? key.slice(this.prefix.length) : undefined;
		if (rel === undefined || rel === "") return undefined;
		const localPath = join(this.dataRoot, ...rel.split("/"));
		try {
			const res = await this.gwFetch(`/objects/${encodeURIComponent(key)}`, { method: "GET" });
			if (res.status === 404) return undefined;
			if (!res.ok) throw new Error(`GET object returned ${res.status}`);
			const bytes = new Uint8Array(await res.arrayBuffer());
			await mkdir(dirname(localPath), { recursive: true });
			await writeFile(localPath, bytes);
			// Seed the stamp so snapshot() doesn't immediately re-upload a file we
			// just downloaded.
			try {
				const st = await stat(localPath);
				this.uploaded.set(localPath, { mtimeMs: st.mtimeMs, size: st.size });
			} catch {
				// ignore stat failure
			}
			return bytes.byteLength;
		} catch (err) {
			console.warn(`[object-store] restore failed for ${key}:`, err instanceof Error ? err.message : err);
			return undefined;
		}
	}

	// Upload changed files. Default (no workspaceId) = full data root, followed by
	// delete-sync. A workspaceId limits to that workspace's subtree, with no
	// delete-sync. Best-effort: a single file error is logged, not thrown.
	// Serialized via chain.
	snapshot(opts?: { workspaceId?: string; sessionId?: string }): Promise<void> {
		const prev = this.snapshotChain;
		this.snapshotChain = (async () => {
			await prev.catch(() => {});
			await this.doSnapshot(opts);
		})();
		return this.snapshotChain;
	}

	// Targeted delete of one mirrored object. Needed because workspace-scoped
	// snapshots never delete-sync, so a locally deleted file would otherwise be
	// restored from the bucket on the next boot. Serialized via chain.
	deleteObject(absPath: string): Promise<void> {
		const prev = this.snapshotChain;
		this.snapshotChain = (async () => {
			await prev.catch(() => {});
			const rel = relative(this.dataRoot, absPath).split(sep).join("/");
			if (rel.startsWith("..") || shouldSkip(rel)) return;
			const res = await this.gwFetch(`/objects/${encodeURIComponent(`${this.prefix}${rel}`)}`, { method: "DELETE" });
			if (!res.ok && res.status !== 404) throw new Error(`DELETE object returned ${res.status}`);
			this.uploaded.delete(absPath);
		})();
		return this.snapshotChain;
	}

	// Targeted delete of every mirrored object under one local directory (used when
	// a workspace folder is deleted). Serialized via chain like deleteObject.
	deleteObjectsUnder(absDir: string): Promise<void> {
		const prev = this.snapshotChain;
		this.snapshotChain = (async () => {
			await prev.catch(() => {});
			const rel = relative(this.dataRoot, absDir).split(sep).join("/");
			if (!rel || rel.startsWith("..")) return;
			const keyPrefix = `${this.prefix}${rel}/`;
			for await (const key of this.listKeys(keyPrefix)) {
				const relKey = key.startsWith(this.prefix) ? key.slice(this.prefix.length) : undefined;
				if (!relKey || shouldSkip(relKey)) continue;
				const res = await this.gwFetch(`/objects/${encodeURIComponent(key)}`, { method: "DELETE" });
				if (!res.ok && res.status !== 404) throw new Error(`DELETE object returned ${res.status}`);
				this.uploaded.delete(join(this.dataRoot, ...relKey.split("/")));
			}
		})();
		return this.snapshotChain;
	}

	private async doSnapshot(opts?: { workspaceId?: string; sessionId?: string }): Promise<void> {
		const prefix = this.prefix;
		const isFull = !opts?.workspaceId;
		// A full snapshot may copy auth.sqlite; checkpoint it first so the WAL is
		// folded back into the main file and the copy is self-contained.
		if (isFull) await this.checkpointAuthDb();

		const roots = this.resolveSnapshotRoots(opts);
		let uploaded = 0;
		for (const root of roots) {
			const files = await this.walk(root);
			for (const filePath of files) {
				const rel = relative(this.dataRoot, filePath).split(sep).join("/");
				if (shouldSkip(rel)) continue;
				try {
					const st = await stat(filePath);
					const prevStamp = this.uploaded.get(filePath);
					if (prevStamp && prevStamp.mtimeMs === st.mtimeMs && prevStamp.size === st.size) continue;
					const bytes = await readFile(filePath);
					const res = await this.gwFetch(`/objects/${encodeURIComponent(`${prefix}${rel}`)}`, {
						method: "PUT",
						body: bytes,
						headers: { "content-type": "application/octet-stream" },
					});
					if (!res.ok) throw new Error(`PUT object returned ${res.status}`);
					this.uploaded.set(filePath, { mtimeMs: st.mtimeMs, size: st.size });
					uploaded++;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					console.warn(`[object-store] snapshot failed for ${rel}:`, message);
					this.lastError = message;
				}
			}
		}

		let deleted = 0;
		// Delete-sync only on a full snapshot, and only once this process has
		// restored — an ephemeral boot must never wipe the bucket.
		if (isFull && this.restoreCompleted) deleted = await this.deleteSync(prefix);

		this.lastSnapshotAt = new Date().toISOString();
		this.lastSnapshotUploaded = uploaded;
		this.lastSnapshotDeleted = deleted;
		if (uploaded > 0 || deleted > 0) {
			const scope = opts?.workspaceId ? ` (${opts.workspaceId}${opts.sessionId ? `/${opts.sessionId}` : ""})` : "";
			console.log(`[object-store] snapshot uploaded ${uploaded}, deleted ${deleted} file(s)${scope}`);
		}
	}

	// Is this key's subtree backed by local files, i.e. does a missing local file
	// actually mean "deleted"?
	//
	// This is the guard that makes lazy restore safe. Without it, every workspace the
	// user did not open this session has no local files, and delete-sync would read
	// that as "deleted locally" and erase the whole workspace from the bucket on the
	// next shutdown snapshot.
	private isHydrated(relPath: string): boolean {
		if (this.fullyHydrated) return true;
		const workspaceId = workspaceIdOf(relPath);
		// Workspace metadata comes down with the boot-critical set, so it is covered by
		// the root scope; the rest of a workspace needs its own hydration.
		if (workspaceId && !isBootCritical(relPath)) return this.hydrated.has(`workspaces/${workspaceId}`);
		return this.hydrated.has(ROOT_SCOPE);
	}

	// Remove bucket keys whose local file no longer exists (file deleted locally).
	// Scoped to the fixed prefix and to hydrated subtrees, skips excluded/tester keys.
	// Returns the count deleted.
	private async deleteSync(prefix: string): Promise<number> {
		let deleted = 0;
		let skippedUnhydrated = 0;
		for await (const key of this.listKeys(prefix)) {
			const rel = key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
			if (rel === undefined || rel === "" || shouldSkip(rel)) continue;
			if (!this.isHydrated(rel)) {
				skippedUnhydrated++;
				continue;
			}
			const localPath = join(this.dataRoot, ...rel.split("/"));
			if (await this.exists(localPath)) continue;
			try {
				const res = await this.gwFetch(`/objects/${encodeURIComponent(key)}`, { method: "DELETE" });
				if (!res.ok && res.status !== 404) throw new Error(`DELETE object returned ${res.status}`);
				this.uploaded.delete(localPath);
				deleted++;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.warn(`[object-store] delete-sync failed for ${key}:`, message);
				this.lastError = message;
			}
		}
		if (skippedUnhydrated > 0) {
			console.log(`[object-store] delete-sync skipped ${skippedUnhydrated} key(s) in workspaces not hydrated this session`);
		}
		return deleted;
	}

	// Async-iterate every object key under a prefix, paging through the gateway's
	// nextToken. Skips folder-marker keys (ending in "/").
	private async *listKeys(prefix: string): AsyncGenerator<string> {
		let token: string | undefined;
		let page = 0;
		let total = 0;
		const startedAt = Date.now();
		do {
			const params = new URLSearchParams({ prefix });
			if (token) params.set("token", token);
			const res = await this.gwFetch(`/objects?${params.toString()}`, { method: "GET" });
			if (!res.ok) throw new Error(`list objects returned ${res.status}`);
			const body = (await res.json()) as GatewayListPage;
			const objects = body.objects ?? [];
			page++;
			total += objects.length;
			// Paging is the first network work a boot does; logging each page is what
			// tells a blocked connection (page 1 never arrives) apart from a merely
			// large tree (pages keep coming).
			console.log(`[object-store] list page ${page}: ${objects.length} key(s), ${total} total, +${Date.now() - startedAt}ms`);
			for (const obj of objects) {
				if (obj.key && !obj.key.endsWith("/")) yield obj.key;
			}
			token = body.nextToken;
		} while (token);
	}

	private async gwFetch(path: string, init: RequestInit): Promise<Response> {
		const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
		if (this.apiKey) headers["x-api-key"] = this.apiKey;
		const startedAt = Date.now();
		try {
			const res = await fetch(`${this.gatewayUrl}${path}`, {
				...init,
				headers,
				// Without a deadline this inherits undici's 300s headers timeout, which
				// is how a blocked gateway hangs a boot with nothing in the log.
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			const elapsed = Date.now() - startedAt;
			if (elapsed > SLOW_REQUEST_MS) {
				console.warn(`[object-store] SLOW ${init.method ?? "GET"} ${decodeURIComponent(path)} → ${res.status} in ${elapsed}ms`);
			}
			return res;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`${init.method ?? "GET"} ${decodeURIComponent(path)} failed after ${Date.now() - startedAt}ms: ${message}`);
		}
	}

	// Fold the SQLite WAL back into auth.sqlite so a whole-file copy is consistent.
	// Best-effort: a missing DB or checkpoint error is logged, not thrown. Opens a
	// short-lived second connection (WAL mode permits this) and closes immediately.
	private async checkpointAuthDb(): Promise<void> {
		const dbPath = join(this.dataRoot, "auth.sqlite");
		if (!(await this.exists(dbPath))) return;
		try {
			// node:sqlite is experimental; import it lazily so its warning is only
			// emitted when an auth DB is actually present.
			const { DatabaseSync } = await import("node:sqlite");
			const db = new DatabaseSync(dbPath);
			try {
				db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			} finally {
				db.close();
			}
		} catch (err) {
			console.warn("[object-store] auth.sqlite checkpoint failed:", err instanceof Error ? err.message : err);
		}
	}

	// Build the list of local directories to scan for a snapshot.
	private resolveSnapshotRoots(opts?: { workspaceId?: string; sessionId?: string }): string[] {
		if (opts?.workspaceId) {
			// Workspace refresh: mirror the whole workspace subtree (workspace.json,
			// members.json, sessions/, artifacts/, events/, skills/) so membership and
			// metadata stay in sync, not just the session being viewed.
			return [join(this.dataRoot, "workspaces", opts.workspaceId)];
		}
		// Full snapshot: the entire data root (auth.sqlite, users/, workspaces/**).
		// walk() filters files; shouldSkip() filters transients and templates/.
		return [this.dataRoot];
	}

	// Recursively list all file paths under dir. Missing dirs yield [].
	private async walk(dir: string): Promise<string[]> {
		let dirents;
		try {
			dirents = await readdir(dir, { withFileTypes: true });
		} catch {
			return [];
		}
		const out: string[] = [];
		for (const ent of dirents) {
			const full = join(dir, ent.name);
			if (ent.isDirectory()) {
				// shouldSkip() would drop these files anyway; not descending saves a
				// full recursive scan of every connection folder's git object store on
				// every snapshot. //IYH1HC sapgit init
				if (SKIP_DIR_SEGMENTS.has(ent.name)) continue;
				out.push(...(await this.walk(full)));
			} else if (ent.isFile()) {
				out.push(full);
			}
		}
		return out;
	}

	private async exists(path: string): Promise<boolean> {
		try {
			await access(path);
			return true;
		} catch {
			return false;
		}
	}
}
