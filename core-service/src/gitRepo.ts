//IYH1HC sapgit init
// The single place git is spawned in core-service, plus the "make this folder a
// repository" primitive shared by the SAP connect flow (http.ts) and the `sapgit`
// capability tool.
//
// Deliberately domain-neutral: nothing here knows about SAP, ADT or connections.
// The caller supplies the folder, the ignore lines and the commit message.

import { spawnSync } from "child_process";
import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import * as log from "./log.js";

export interface GitResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Run one git command in `cwd`. Never throws: a missing binary surfaces as a
 * non-zero exit code with the spawn error in `stderr`, which is what every caller
 * already branches on.
 */
export function runGit(cwd: string, args: string[]): GitResult {
	const res = spawnSync("git", args, { cwd, encoding: "utf8" });
	return {
		stdout: res.stdout || "",
		stderr: res.stderr || (res.error ? res.error.message : ""),
		exitCode: res.status ?? 1,
	};
}

// Probed once per process. `git --version` is cheap but this sits on the connect
// path, and the answer cannot change while the process lives.
let gitAvailable: boolean | undefined;

/**
 * Whether a `git` binary is on PATH. Git is not part of the Node buildpack's
 * runtime image, so on Cloud Foundry this can legitimately be false — every
 * caller must degrade rather than fail.
 */
export function isGitAvailable(): boolean {
	if (gitAvailable === undefined) {
		gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
	}
	return gitAvailable;
}

export type GitFileStatus =
	| "conflicted"
	| "deleted"
	| "modified"
	| "renamed"
	| "added"
	| "untracked"
	| "ignored";

export interface GitStatusResult {
	/** Whether a `git` binary is on PATH. False on Cloud Foundry is legitimate. */
	available: boolean;
	/** Whether `dir` is a repository. False until a caller has initialized one. */
	repo: boolean;
	branch: string;
	/** Keyed by path relative to `dir`, forward slashes. */
	entries: Record<string, GitFileStatus>;
	/** Set when the entry list hit `MAX_STATUS_ENTRIES` and was cut short. */
	truncated: boolean;
}

// A repository whose working tree is in this state is not one a human is reading
// file by file — it is a broken clone or a failed commit. Past this point the list
// stops being information and starts being payload.
const MAX_STATUS_ENTRIES = 5000;

/**
 * Map one porcelain `XY` status pair to a single status.
 *
 * Order matters: the first matching rule wins, so the more alarming states are
 * tested before the ones they subsume. A file both staged-modified and
 * worktree-deleted is "deleted" to whoever is looking at the tree.
 */
function classifyPorcelain(x: string, y: string): GitFileStatus {
	const xy = `${x}${y}`;
	if (xy === "??") return "untracked";
	if (xy === "!!") return "ignored";
	if (x === "U" || y === "U" || xy === "AA" || xy === "DD") return "conflicted";
	if (x === "D" || y === "D") return "deleted";
	if (x === "R" || x === "C") return "renamed";
	if (x === "A") return "added";
	return "modified";
}

/**
 * Read the working-tree status of `dir` as a flat path → status map.
 *
 * Non-throwing and cheap to call on a folder that is not a repository: both the
 * missing-binary and the missing-`.git` cases return before anything is spawned,
 * because callers use this to decorate a UI, where "no answer" must render as
 * "nothing to say" rather than as an error.
 */
export function readGitStatus(dir: string): GitStatusResult {
	const empty: GitStatusResult = { available: true, repo: false, branch: "", entries: {}, truncated: false };
	if (!isGitAvailable()) return { ...empty, available: false };
	if (!existsSync(join(dir, ".git"))) return empty;

	// `-z` is not optional. ADT folder names contain spaces ("Source Code Library")
	// and object file names contain `#`; porcelain v1 quotes and escapes such paths
	// on its own, so a line-based parse would hand back mangled keys. NUL-separated
	// records are the only form that survives verbatim.
	//
	// `--ignored=matching` lists the files that match an ignore pattern without
	// descending into ignored directories — enough to dim `.gitignore`d entries that
	// are deliberately still shown, without walking a tree nobody asked for.
	const res = runGit(dir, ["status", "--porcelain=v1", "-z", "-uall", "--ignored=matching"]);
	if (res.exitCode !== 0) return empty;

	const entries: Record<string, GitFileStatus> = {};
	let truncated = false;
	const fields = res.stdout.split("\0");
	for (let i = 0; i < fields.length; i++) {
		const record = fields[i];
		if (!record || record.length < 4) continue;
		const x = record[0]!;
		const y = record[1]!;
		// An ignored *directory* is reported as `.adt/`, with the trailing slash, while
		// every other entry is a plain file path. Callers match these keys against tree
		// nodes, whose paths never carry one — so normalize rather than make each caller
		// remember the exception.
		const path = record.slice(3).replace(/\/+$/, "");
		// A rename or copy spends a second NUL-separated field on its origin path.
		// Skipping it here is what keeps every later record aligned; without this the
		// whole rest of the list shifts by one and decorates the wrong files.
		if (x === "R" || x === "C" || y === "R" || y === "C") i++;
		if (!path) continue;
		if (Object.keys(entries).length >= MAX_STATUS_ENTRIES) {
			truncated = true;
			break;
		}
		entries[path] = classifyPorcelain(x, y);
	}

	const branchRes = runGit(dir, ["branch", "--show-current"]);
	return {
		available: true,
		repo: true,
		branch: branchRes.exitCode === 0 ? branchRes.stdout.trim() : "",
		entries,
		truncated,
	};
}

export interface EnsureGitRepoOptions {
	/** Repo-local `user.name`. Without an identity every commit fails on a host with no global git config. */
	authorName?: string;
	/** Repo-local `user.email`. */
	authorEmail?: string;
	/** Lines written to `.gitignore`, but only when the file does not exist yet. */
	ignore?: string[];
	/** Message for the root commit. Omit to leave the repo without a HEAD. */
	initialCommitMessage?: string;
}

export interface EnsureGitRepoResult {
	initialized: boolean;
	reason?: "already" | "git-missing" | "init-failed";
}

/**
 * Make `dir` a git repository with a root commit, if it is not one already.
 *
 * Idempotent and non-throwing by design: this runs as a side effect of creating a
 * SAP connection, and a git problem must never be the reason a connect fails. Every
 * failure past `git init` is logged and swallowed — a partially set-up repository is
 * still more useful than none.
 *
 * The root commit is not cosmetic. `sapgit` decides *what to push to SAP* from
 * `git diff --name-only` and a `<default>...HEAD` branch diff; both are degenerate
 * in a repository that has no HEAD, so the folder would look unchanged.
 */
export function ensureGitRepo(dir: string, opts: EnsureGitRepoOptions = {}): EnsureGitRepoResult {
	if (existsSync(join(dir, ".git"))) return { initialized: false, reason: "already" };
	if (!isGitAvailable()) {
		log.logWarning("[git] git is not available on this host", `${dir} was not initialized as a repository`);
		return { initialized: false, reason: "git-missing" };
	}

	// `-b` needs git >= 2.28; older builds reject the flag outright, so fall back to
	// whatever the host's default branch is rather than leaving the folder untracked.
	let init = runGit(dir, ["init", "-b", "main"]);
	if (init.exitCode !== 0) init = runGit(dir, ["init"]);
	if (init.exitCode !== 0) {
		log.logWarning("[git] git init failed", `${dir}: ${init.stderr.trim()}`);
		return { initialized: false, reason: "init-failed" };
	}

	// Repo-local, never --global: two users of the same server must not overwrite
	// each other's identity, and nothing here may touch the host's git config.
	if (opts.authorName) runGit(dir, ["config", "user.name", opts.authorName]);
	if (opts.authorEmail) runGit(dir, ["config", "user.email", opts.authorEmail]);

	if (opts.ignore?.length) {
		const gitignore = join(dir, ".gitignore");
		// Never overwrite: an existing file is the user's, and they may have added
		// their own patterns to it.
		if (!existsSync(gitignore)) {
			try {
				writeFileSync(gitignore, `${opts.ignore.join("\n")}\n`);
			} catch (err) {
				log.logWarning("[git] could not write .gitignore", `${gitignore}: ${(err as Error).message}`);
			}
		}
	}

	if (opts.initialCommitMessage) {
		runGit(dir, ["add", "-A"]);
		// --allow-empty: the folder may hold nothing but ignored files, and a repo
		// without a root commit is exactly the degenerate case described above.
		const commit = runGit(dir, ["commit", "--allow-empty", "-m", opts.initialCommitMessage]);
		if (commit.exitCode !== 0) {
			log.logWarning("[git] initial commit failed", `${dir}: ${(commit.stderr || commit.stdout).trim()}`);
		}
	}

	return { initialized: true };
}
