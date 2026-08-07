/**
 * Runs the portable search engine through an `Executor`.
 *
 * The engine program is materialized once per executor with `writeFile` (which
 * already handles the shell/base64 boundary in every implementation), then
 * invoked as `node "<script>" "<base64 job>"`. Both arguments are quoted and the
 * payload is pure base64, so the command needs no shell-specific escaping and
 * behaves identically under PowerShell, POSIX `sh`, and BusyBox `sh`.
 */

import type { ExecResult } from "../sandbox.js";
import { SEARCH_ENGINE_SOURCE, SEARCH_ENGINE_VERSION } from "./engine-source.js";
import type { GlobOptions, GlobResult, GrepOptions, GrepResult, SearchEnvelope, SearchJob } from "./types.js";

/** Ceiling on a single search; a full-tree scan on a cold cache can be slow. */
const SEARCH_TIMEOUT_SECONDS = 120;

interface SearchHost {
	exec(command: string, options?: { timeout?: number; signal?: AbortSignal }): Promise<ExecResult>;
	writeFile(path: string, content: string): Promise<void>;
}

export interface SearchSupportOptions {
	/** Absolute directory the engine program is written to (host tmp or /tmp). */
	scriptDir: string;
	/** Joins `scriptDir` with a filename using the target platform's separator. */
	joinPath: (dir: string, name: string) => string;
	/** Working directory relative paths in a job resolve against. */
	resolveCwd: () => string;
	/**
	 * Directories searched in addition to the cwd when the caller does not name
	 * a `path` — currently the session's attachments folder, which sits outside
	 * the artifacts cwd. Missing directories are dropped by the engine.
	 */
	resolveExtraRoots?: () => string[];
}

/**
 * Shared glob/grep implementation. Both `HostExecutor` and `ContainerExecutor`
 * delegate here so there is exactly one behavior to reason about; a future
 * remote executor may override `glob`/`grep` with a native backend instead.
 */
export class SearchSupport {
	private materialized?: Promise<string>;

	constructor(
		private readonly host: SearchHost,
		private readonly options: SearchSupportOptions,
	) {}

	async glob(options: GlobOptions): Promise<GlobResult> {
		const { signal, ...rest } = options;
		const envelope = await this.run({ kind: "glob", cwd: this.options.resolveCwd(), extraRoots: this.extraRoots(), ...rest }, signal);
		if (!envelope.ok) throw new Error(envelope.error);
		if (envelope.kind !== "glob") throw new Error(`Search engine returned a ${envelope.kind} result for a glob job`);
		return envelope.result;
	}

	async grep(options: GrepOptions): Promise<GrepResult> {
		const { signal, ...rest } = options;
		const envelope = await this.run({ kind: "grep", cwd: this.options.resolveCwd(), extraRoots: this.extraRoots(), ...rest }, signal);
		if (!envelope.ok) throw new Error(envelope.error);
		if (envelope.kind !== "grep") throw new Error(`Search engine returned a ${envelope.kind} result for a grep job`);
		return envelope.result;
	}

	private extraRoots(): string[] | undefined {
		const roots = this.options.resolveExtraRoots?.();
		return roots && roots.length > 0 ? roots : undefined;
	}

	/** Written once per executor; the version is in the filename so upgrades land. */
	private ensureScript(): Promise<string> {
		if (!this.materialized) {
			const scriptPath = this.options.joinPath(this.options.scriptDir, `octo-fs-search-${SEARCH_ENGINE_VERSION}.cjs`);
			this.materialized = this.host
				.writeFile(scriptPath, SEARCH_ENGINE_SOURCE)
				.then(() => scriptPath)
				.catch((err) => {
					// Allow a later call to retry instead of caching the failure forever.
					this.materialized = undefined;
					throw err;
				});
		}
		return this.materialized;
	}

	private async run(job: SearchJob, signal?: AbortSignal): Promise<SearchEnvelope> {
		const scriptPath = await this.ensureScript();
		const payload = Buffer.from(JSON.stringify(job), "utf-8").toString("base64");
		const result = await this.host.exec(`node "${scriptPath}" "${payload}"`, {
			timeout: SEARCH_TIMEOUT_SECONDS,
			signal,
		});

		const stdout = result.stdout.trim();
		if (result.code !== 0 && !stdout) {
			const detail = result.stderr.trim() || `exit code ${result.code}`;
			throw new Error(
				`Search engine failed to run (${detail}). The search tools require Node.js to be available in the execution environment.`,
			);
		}

		try {
			return JSON.parse(stdout) as SearchEnvelope;
		} catch {
			const preview = stdout.slice(0, 500) || result.stderr.trim().slice(0, 500);
			throw new Error(`Search engine returned unparseable output: ${preview || "(empty)"}`);
		}
	}
}
