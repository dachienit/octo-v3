//import { spawn } from "child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "child_process";
import { SearchSupport } from "./search/runner.js";
import type { GlobOptions, GlobResult, GrepOptions, GrepResult } from "./search/types.js";

export type ContainerRuntime = "docker" | "podman" | "octo-box";
export type SandboxConfig = { type: "host" } | {
	type: ContainerRuntime;
	container?: string;
	workspacePath?: string;
	usersPath?: string;
};

export function parseSandboxArg(value: string): SandboxConfig {
	if (value === "host") {
		return { type: "host" };
	}
	for (const runtime of ["docker", "podman", "octo-box"] as const) {
		if (value === runtime) return { type: runtime };
		const prefix = `${runtime}:`;
		if (!value.startsWith(prefix)) continue;
		const container = value.slice(prefix.length);
		if (!container) {
			console.error(`Error: ${runtime} sandbox requires container name (e.g., ${runtime}:octo-sandbox)`);
			process.exit(1);
		}
		return { type: runtime, container };
	}
	console.error(`Error: Invalid sandbox type '${value}'. Use 'host', 'docker', 'podman', 'octo-box', 'docker:<container-name>', 'podman:<container-name>' or 'octo-box:<container-name>'`);
	process.exit(1);
}

export async function validateSandbox(config: SandboxConfig): Promise<void> {
	if (config.type === "host") {
		return;
	}

	try {
		await execSimple(runtimeCommand(config.type), ["--version"]);
	} catch {
		console.error(`Error: ${runtimeLabel(config.type)} is not installed or not in PATH`);
		process.exit(1);
	}

	if (!config.container) {
		console.log(`  ${runtimeLabel(config.type)} runtime is available; workspace containers will start on demand.`);
		return;
	}

	try {
		const result = await execSimple(runtimeCommand(config.type), ["inspect", "-f", "{{.State.Running}}", config.container]);
		if (result.trim() !== "true") {
			console.error(`Error: Container '${config.container}' is not running.`);
			console.error(`Start it with: ${runtimeCommand(config.type)} start ${config.container}`);
			process.exit(1);
		}
	} catch {
		console.error(`Error: Container '${config.container}' does not exist.`);
		console.error(`Create it with: ./${config.type}.sh create <data-dir>`);
		process.exit(1);
	}

	console.log(`  ${runtimeLabel(config.type)} container '${config.container}' is running.`);
}

function execSimple(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d) => {
			stdout += d;
		});
		child.stderr?.on("data", (d) => {
			stderr += d;
		});
		child.on("close", (code) => {
			if (code === 0) resolve(stdout);
			else reject(new Error(stderr || `Exit code ${code}`));
		});
	});
}

/**
 * `searchRoots` are extra directories `glob`/`grep` cover on top of `cwd` when
 * the model does not name a path. They do not affect `bash`, `read` or `write`.
 */
export function createExecutor(config: SandboxConfig, cwd?: string, searchRoots: string[] = []): Executor {
	if (config.type === "host") {
		return new HostExecutor(cwd, searchRoots);
	}
	if (!config.container) throw new Error(`${config.type} executor requires a resolved container name`);
	return new ContainerExecutor(config.type, config.container, cwd, searchRoots);
}

export interface Executor {
	exec(command: string, options?: ExecOptions): Promise<ExecResult>;
	spawn(command: string, args?: string[], options?: SpawnOptions): ChildProcessWithoutNullStreams;
	/**
	 * Spawn a long-running command through the environment's shell and return the
	 * live handle. Unlike `spawn`, the command string is shell-interpreted, so
	 * pipes and redirects work. Used for background shells; stdin is closed, so
	 * the returned handle has no writable stdin.
	 */
	spawnShell(command: string, options?: SpawnOptions): ChildProcess;
	/**
	 * Best-effort termination of a process tree started by `spawnShell`, including
	 * children. Each implementation owns the platform details (process groups and
	 * `taskkill` on the host, killing the in-container tree for containers).
	 */
	terminateShell(child: ChildProcess): Promise<void>;
	getWorkspacePath(hostPath: string): string;
	/**
	 * Resolves a tool argument against the executor's working directory, the same
	 * way `readFile` does. Exposed so callers can key caches on a canonical path:
	 * `glob` reports absolute paths while a model typically passes a relative one,
	 * and the two must agree on what names the same file.
	 */
	resolvePath(path: string): string;
	readFile(path: string): Promise<Buffer>;
	writeFile(path: string, content: string): Promise<void>;
	/** Find files by glob pattern, newest first. */
	glob(options: GlobOptions): Promise<GlobResult>;
	/** Search file contents by regular expression. */
	grep(options: GrepOptions): Promise<GrepResult>;
}

export interface ExecOptions {
	timeout?: number;
	signal?: AbortSignal;
}

export interface SpawnOptions {
	cwd?: string;
	env?: Record<string, string>;
	signal?: AbortSignal;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

/** Shell invocation for the host platform, shared by `exec` and `spawnShell`. */
function hostShell(): { shell: string; shellArgs: string[]; isWin: boolean } {
	const isWin = process.platform === "win32";
	return {
		isWin,
		shell: isWin ? "powershell" : "sh",
		shellArgs: isWin ? ["-NoProfile", "-NonInteractive", "-Command"] : ["-c"],
	};
}

/**
 * Runs a process to completion and collects its output.
 *
 * Takes an argv array rather than a command string on purpose: passing a
 * composed string through a host shell means the payload has to survive that
 * shell's quoting rules, and PowerShell's differ from POSIX. Callers that need a
 * shell add it themselves as argv[0].
 */
function runProcess(
	file: string,
	args: string[],
	options?: ExecOptions & { cwd?: string; detached?: boolean },
): Promise<ExecResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(file, args, {
			cwd: options?.cwd,
			detached: options?.detached ?? false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;

		const timeoutHandle =
			options?.timeout && options.timeout > 0
				? setTimeout(() => {
						timedOut = true;
						killProcessTree(child.pid);
					}, options.timeout * 1000)
				: undefined;

		const onAbort = () => killProcessTree(child.pid);

		if (options?.signal) {
			if (options.signal.aborted) {
				onAbort();
			} else {
				options.signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		child.stdout?.on("data", (data) => {
			stdout += data.toString();
			if (stdout.length > 10 * 1024 * 1024) {
				stdout = stdout.slice(0, 10 * 1024 * 1024);
			}
		});

		child.stderr?.on("data", (data) => {
			stderr += data.toString();
			if (stderr.length > 10 * 1024 * 1024) {
				stderr = stderr.slice(0, 10 * 1024 * 1024);
			}
		});

		child.on("close", (code) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (options?.signal) {
				options.signal.removeEventListener("abort", onAbort);
			}

			if (options?.signal?.aborted) {
				reject(new Error(`${stdout}\n${stderr}\nCommand aborted`.trim()));
				return;
			}

			if (timedOut) {
				reject(new Error(`${stdout}\n${stderr}\nCommand timed out after ${options?.timeout} seconds`.trim()));
				return;
			}

			resolve({ stdout, stderr, code: code ?? 0 });
		});
	});
}

class HostExecutor implements Executor {
	private readonly search = new SearchSupport(this, {
		scriptDir: tmpdir(),
		joinPath: join,
		resolveCwd: () => this.cwd ?? process.cwd(),
		resolveExtraRoots: () => this.searchRoots,
	});

	constructor(private cwd?: string, private readonly searchRoots: string[] = []) {}

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		const { shell, shellArgs, isWin } = hostShell();
		return runProcess(shell, [...shellArgs, command], {
			...options,
			cwd: this.cwd,
			// A process group on POSIX lets the whole tree be killed on timeout.
			detached: !isWin,
		});
	}

	getWorkspacePath(hostPath: string): string {
		return hostPath;
	}

	resolvePath(path: string): string {
		return isAbsolute(path) ? path : resolve(this.cwd ?? process.cwd(), path);
	}

	async readFile(path: string): Promise<Buffer> {
		return fsReadFile(this.resolvePath(path));
	}

	async writeFile(path: string, content: string): Promise<void> {
		const resolved = this.resolvePath(path);
		await mkdir(dirname(resolved), { recursive: true });
		await fsWriteFile(resolved, content, "utf-8");
	}
	spawn(command: string, args: string[] = [], options?: SpawnOptions): ChildProcessWithoutNullStreams {
		const child = spawn(command, args, {
			cwd: options?.cwd ?? this.cwd,
			env: { ...process.env, ...(options?.env ?? {}) },
			stdio: ["pipe", "pipe", "pipe"],
		});
		options?.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
		return child;
	}

	spawnShell(command: string, options?: SpawnOptions): ChildProcess {
		const { shell, shellArgs, isWin } = hostShell();
		const child = spawn(shell, [...shellArgs, command], {
			cwd: options?.cwd ?? this.cwd,
			env: { ...process.env, ...(options?.env ?? {}) },
			// A process group on POSIX lets the whole tree be killed later.
			detached: !isWin,
			stdio: ["ignore", "pipe", "pipe"],
		});
		options?.signal?.addEventListener("abort", () => killProcessTree(child.pid), { once: true });
		return child;
	}

	async terminateShell(child: ChildProcess): Promise<void> {
		killProcessTree(child.pid);
	}

	glob(options: GlobOptions): Promise<GlobResult> {
		return this.search.glob(options);
	}

	grep(options: GrepOptions): Promise<GrepResult> {
		return this.search.grep(options);
	}
}

/**
 * Maps a container background shell to the in-container file holding its PID.
 * `<runtime> exec` does not kill the remote process when the client dies, so the
 * PID has to be recorded at start time to be able to terminate it later.
 */
const containerShellPidFiles = new WeakMap<ChildProcess, string>();

class ContainerExecutor implements Executor {
	private readonly search = new SearchSupport(this, {
		scriptDir: "/tmp",
		joinPath: posix.join,
		resolveCwd: () => this.cwd ?? "/workspace",
		resolveExtraRoots: () => this.searchRoots,
	});

	constructor(
		private runtime: ContainerRuntime,
		private container: string,
		private cwd?: string,
		private readonly searchRoots: string[] = [],
	) {}

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		const wrappedCommand = this.cwd
			? `mkdir -p ${shellEscape(this.cwd)} && cd ${shellEscape(this.cwd)} && ${command}`
			: command;
		// The script is one argv element handed straight to the container runtime.
		// Composing a single string for the host shell instead would corrupt it:
		// `shellEscape` produces POSIX quoting, and on a Windows host the string
		// would first be parsed by PowerShell, which escapes quotes differently.
		return runProcess(
			runtimeCommand(this.runtime),
			["exec", this.container, "sh", "-c", wrappedCommand],
			{ ...options, detached: process.platform !== "win32" },
		);
	}

	getWorkspacePath(_hostPath: string): string {
		return "/workspace";
	}

	resolvePath(path: string): string {
		return path.startsWith("/") ? path : posix.join(this.cwd ?? "/workspace", path);
	}

	async readFile(path: string): Promise<Buffer> {
		const resolved = this.resolvePath(path);
		// base64 keeps binary (e.g. images) intact across the shell boundary.
		const result = await this.exec(`base64 < ${shellEscape(resolved)}`);
		if (result.code !== 0) {
			throw new Error(result.stderr || `Failed to read file: ${path}`);
		}
		return Buffer.from(result.stdout.replace(/\s/g, ""), "base64");
	}

	async writeFile(path: string, content: string): Promise<void> {
		const resolved = this.resolvePath(path);
		const dir = posix.dirname(resolved);
		// Base64-encode on the host and decode in the container: avoids all shell
		// escaping/binary pitfalls (the b64 payload contains no shell metacharacters).
		const b64 = Buffer.from(content, "utf-8").toString("base64");
		const cmd = `mkdir -p ${shellEscape(dir)} && printf '%s' ${shellEscape(b64)} | base64 -d > ${shellEscape(resolved)}`;
		const result = await this.exec(cmd);
		if (result.code !== 0) {
			throw new Error(result.stderr || `Failed to write file: ${path}`);
		}
	}
	spawn(command: string, args: string[] = [], options?: SpawnOptions): ChildProcessWithoutNullStreams {
		const commandLine = [command, ...args].map(shellEscape).join(" ");
		return this.spawnInContainer(`exec ${commandLine}`, options);
	}

	spawnShell(command: string, options?: SpawnOptions): ChildProcess {
		// `echo $$` records the wrapper shell's PID; the command runs as its child,
		// so `pkill -P` plus a direct kill takes down the whole tree later.
		const pidFile = `/tmp/octo-shell-${randomBytes(6).toString("hex")}.pid`;
		const child = this.spawnInContainer(`echo $$ > ${shellEscape(pidFile)}\n${command}`, options);
		containerShellPidFiles.set(child, pidFile);
		return child;
	}

	async terminateShell(child: ChildProcess): Promise<void> {
		child.kill("SIGTERM");
		const pidFile = containerShellPidFiles.get(child);
		if (!pidFile) return;
		const escaped = shellEscape(pidFile);
		const snippet = [
			`p=$(cat ${escaped} 2>/dev/null)`,
			`if [ -n "$p" ]; then pkill -TERM -P "$p" 2>/dev/null; kill -TERM "$p" 2>/dev/null; fi`,
			`rm -f ${escaped}`,
			"exit 0",
		].join("; ");
		try {
			await this.exec(snippet, { timeout: 15 });
		} catch {
			// Terminating is best-effort; the container may already be gone.
		}
	}

	/**
	 * `<runtime> exec -i <container> sh -c <script>` with the cwd prepared. The
	 * script is passed as a single argv element straight to Node's `spawn`, so no
	 * host shell sees it and no host-side escaping is involved.
	 */
	private spawnInContainer(script: string, options?: SpawnOptions): ChildProcessWithoutNullStreams {
		const cwd = options?.cwd ?? this.cwd;
		const wrappedCommand = cwd ? `mkdir -p ${shellEscape(cwd)} && cd ${shellEscape(cwd)} && ${script}` : script;
		const containerArgs = ["exec", "-i"];
		for (const [key, value] of Object.entries(options?.env ?? {})) {
			containerArgs.push("--env", `${key}=${value}`);
		}
		containerArgs.push(this.container, "sh", "-c", wrappedCommand);
		const child = spawn(runtimeCommand(this.runtime), containerArgs, {
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env
		});
		options?.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
		return child;
	}

	glob(options: GlobOptions): Promise<GlobResult> {
		return this.search.glob(options);
	}

	grep(options: GrepOptions): Promise<GrepResult> {
		return this.search.grep(options);
	}
}

function runtimeCommand(runtime: ContainerRuntime): string {
	return runtime === "octo-box" ? "box" : runtime;
}

function runtimeLabel(runtime: ContainerRuntime): string {
	return runtime === "docker" ? "Docker" : runtime === "podman" ? "Podman" : "Octo Box";
}

export function killProcessTree(pid: number | undefined): void {
	if (pid === undefined) return;
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
			});
		} catch {
			// Ignore errors
		}
	} else {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}

function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}
