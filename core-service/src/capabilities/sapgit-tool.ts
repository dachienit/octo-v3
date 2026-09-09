import { randomBytes } from "crypto";
import { basename, resolve, join, relative, isAbsolute, dirname } from "path";
import * as fs from "fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import * as log from "../log.js";
import { currentTurn, executeAdt } from "./adt-tool.js";
//IYH1HC sapgit init
import { ensureGitRepo, runGit } from "../gitRepo.js";
import { CONNECTION_GITIGNORE, readManifest, writeManifest, planChildren, sanitizeFolderName, applyPlan } from "../sapTree.js";

const MAX_OUTPUT_CHARS = 60_000;

const sapGitSchema = {
	type: "object",
	properties: {
		command: {
			type: "string",
			enum: ["clone", "pull", "push", "activate", "status", "diff", "add", "commit", "log", "branch", "switch", "merge", "restore", "check", "create"],
			description: "The sapgit command to run."
		},
		connectionName: {
			type: "string",
			description: "The name of the SAP connection folder under artifacts/ (e.g. 'SYS')."
		},
		packageName: {
			type: "string",
			description: "The name of the SAP package (required only for 'clone' and 'create', e.g. 'ZCUSTOM_PACKAGE')."
		},
		files: {
			type: "array",
			items: { type: "string" },
			description: "Specific files to stage, diff, push, activate, or check. If omitted, applies to all changed files."
		},
		gitArgs: {
			type: "array",
			items: { type: "string" },
			description: "Additional arguments passed directly to git for commands like commit, log, branch, switch, merge, or restore. Example: ['-m', 'feat: update user class']"
		},
		transport: {
			type: "string",
			description: "An optional target Transport Request for pushing or creating code (e.g. 'DEVK900123')."
		},
		activate: {
			type: "boolean",
			description: "For 'push' and 'create' commands: if true, automatically activates the object on the SAP server right after creation or writing."
		},
		objectType: {
			type: "string",
			description: "For 'create' command: The SAP ADT type ID of the object to create (e.g. 'CLAS/OC' for Class, 'INTF/OI' for Interface, 'PROG/P' for Program)."
		},
		objectName: {
			type: "string",
			description: "For 'create' command: The name of the new SAP object to create (e.g. 'ZCL_MY_CLASS')."
		},
		description: {
			type: "string",
			description: "For 'create' command: Optional short text description for the new SAP object."
		}
	},
	required: ["command", "connectionName"]
} as unknown as AgentTool["parameters"];

function capOutput(text: string): { text: string; truncated: boolean } {
	if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
	return {
		text: `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[... ${text.length - MAX_OUTPUT_CHARS} more characters truncated]`,
		truncated: true,
	};
}

function getAbsPath(workspaceRoot: string, connDir: string, connectionName: string, file: string): string {
	const normFile = file.replace(/\\/g, "/");
	if (isAbsolute(file)) {
		return file;
	}
	// Check if path is relative to workspace root (e.g. starts with "artifacts/S4H")
	if (normFile.startsWith("artifacts/") || normFile.startsWith("./artifacts/")) {
		return resolve(workspaceRoot, file);
	}
	// Check if it already contains the connection name at the start
	if (normFile.startsWith(`${connectionName}/`) || normFile.startsWith(`./${connectionName}/`)) {
		return resolve(join(workspaceRoot, "artifacts"), file);
	}
	// Otherwise, assume it is relative to connDir (the connection directory)
	return resolve(connDir, file);
}

function getCategoryFolder(typeId: string): string {
	const mainType = typeId.split("/")[0].toUpperCase();
	if (mainType === "CLAS") return "Source Code Library/Classes";
	if (mainType === "INTF") return "Source Code Library/Interfaces";
	if (mainType === "PROG") return "Source Code Library/Programs";
	if (mainType === "FUGR") return "Source Code Library/Function Groups";
	return "Source Code Library/Programs"; // Default fallback
}

function getInitialShell(typeId: string, name: string, description: string): string {
	const mainType = typeId.split("/")[0].toUpperCase();
	const cleanName = name.toUpperCase();
	if (mainType === "CLAS") {
		return [
			`CLASS ${cleanName} DEFINITION`,
			`  PUBLIC`,
			`  FINAL`,
			`  CREATE PUBLIC.`,
			``,
			`  PUBLIC SECTION.`,
			`  PROTECTED SECTION.`,
			`  PRIVATE SECTION.`,
			`ENDCLASS.`,
			``,
			`CLASS ${cleanName} IMPLEMENTATION.`,
			`ENDCLASS.`
		].join("\n");
	}
	if (mainType === "INTF") {
		return [
			`INTERFACE ${cleanName}`,
			`  PUBLIC.`,
			`ENDINTERFACE.`
		].join("\n");
	}
	if (mainType === "PROG") {
		return [
			`*&---------------------------------------------------------------------*`,
			`*& Report ${name}`,
			`*& Description: ${description || "Created via sapgit"}`,
			`*&---------------------------------------------------------------------*`,
			`REPORT ${cleanName}.`,
			``
		].join("\n");
	}
	return ""; // Default empty
}

function parseSapDiagnostics(output: string): string {
	if (!output) return "";
	try {
		const data = JSON.parse(output);
		if (data && Array.isArray(data.messages)) {
			const list = data.messages.map((m: any) => {
				const type = m.severity || "error";
				return `* **[${type.toUpperCase()}]** Line ${m.line || "?"}, Col ${m.column || m.col || "?"}: ${m.text || m.message}`;
			});
			if (list.length > 0) {
				return `\n### SAP Syntax/Check Diagnostics:\n${list.join("\n")}\n`;
			}
		}
	} catch {
		// Fallback to regex text scanning
	}
	const lines = output.split("\n");
	const matches = lines.filter(l => l.match(/(error|warning|info|finding)/i) || l.match(/line\s+\d+/i));
	if (matches.length > 0) {
		return `\n### SAP Syntax/Check Findings:\n${matches.map(m => `* ${m}`).join("\n")}\n`;
	}
	return "";
}

//IYH1HC sapgit init
/**
 * The set of files `push`, `activate` and `check` operate on when the caller names
 * none: everything that differs from the last commit, plus everything the feature
 * branch has added on top of the default branch.
 *
 * That second half is why this is not just `git diff`. Work already committed to a
 * feature branch is not "changed" to git, but it is exactly what has not reached SAP
 * yet — dropping it would make a push after a commit silently do nothing.
 */
function collectChangedFiles(connDir: string): string[] {
	const list = new Set<string>();

	const diffRes = runGit(connDir, ["diff", "--name-only"]);
	const untrackedRes = runGit(connDir, ["status", "--porcelain"]);
	if (diffRes.exitCode === 0) {
		diffRes.stdout.split("\n").map(f => f.trim()).filter(Boolean).forEach(f => list.add(f));
	}
	if (untrackedRes.exitCode === 0) {
		untrackedRes.stdout.split("\n").forEach(line => {
			const trimmed = line.trim();
			if (trimmed.startsWith("??") || trimmed.startsWith("A")) {
				list.add(trimmed.slice(2).trim());
			}
		});
	}

	const currentBranchRes = runGit(connDir, ["branch", "--show-current"]);
	const currentBranch = currentBranchRes.exitCode === 0 ? currentBranchRes.stdout.trim() : "";
	const defaultBranch = runGit(connDir, ["show-ref", "--verify", "--quiet", "refs/heads/main"]).exitCode === 0 ? "main" : "master";

	if (currentBranch && currentBranch !== defaultBranch) {
		const branchDiffRes = runGit(connDir, ["diff", "--name-only", `${defaultBranch}...HEAD`]);
		if (branchDiffRes.exitCode === 0) {
			branchDiffRes.stdout.split("\n").map(f => f.trim()).filter(Boolean).forEach(f => list.add(f));
		}
	}

	return Array.from(list);
}

export interface SapGitToolClosure {
	channelId: string;
	channelDir: string;
}

export function createSapGitTool(closure: SapGitToolClosure): AgentTool {
	const instanceId = randomBytes(4).toString("hex");
	const builtAt = new Date().toISOString();
	const workspaceId = basename(resolve(closure.channelDir, "..", ".."));

	return {
		name: "sapgit",
		label: "sapgit",
		description: [
			"Integrate local Git version control with an SAP package repo via ADT.",
			"Usage guidelines:",
			"1. clone: Hydrates all files of an SAP package and initializes local Git.",
			"2. pull: Refreshes local files with the latest active version from SAP and commits them to Git.",
			"3. push: Resolves the Transport Request and pushes local changes to SAP as inactive code.",
			"4. activate: Activates changes on the SAP system.",
			"5. check: Runs ATC check or abaplint quality checks.",
			"6. create: Registers a new ABAP object (Class, Interface, Program) in SAP, creates its empty local file shell, updates tree.json, and commits to Git.",
			"7. status: Lists files changed locally since last commit.",
			"8. diff: Inspects local file differences.",
			"9. add: Stages files (equivalent to git add).",
			"10. commit: Commits staged changes (equivalent to git commit, pass message via gitArgs).",
			"11. log: Views Git branch history (equivalent to git log).",
			"12. branch: Manages Git branches (equivalent to git branch).",
			"13. switch: Switches Git branches (equivalent to git switch).",
			"14. merge: Merges Git branches (equivalent to git merge).",
			"15. restore: Discards local changes (equivalent to git restore).",
		].join(" "),
		parameters: sapGitSchema,
		executionMode: "sequential",
		execute: async (toolCallId: string, params: unknown) => {
			const startedAt = Date.now();
			const { command, connectionName, packageName, files, gitArgs, transport, activate, objectType, objectName, description } = (params ?? {}) as {
				command: "clone" | "pull" | "push" | "activate" | "status" | "diff" | "add" | "commit" | "log" | "branch" | "switch" | "merge" | "restore" | "check" | "create";
				connectionName: string;
				packageName?: string;
				files?: string[];
				gitArgs?: string[];
				transport?: string;
				activate?: boolean;
				objectType?: string;
				objectName?: string;
				description?: string;
			};

			const workspaceRoot = resolve(closure.channelDir, "..", "..");
			const connDir = join(workspaceRoot, "artifacts", connectionName);

			if (!fs.existsSync(connDir)) {
				throw new Error(`Connection folder for '${connectionName}' not found under artifacts/.`);
			}

			const turn = currentTurn(closure.channelId);
			if (!turn) {
				throw new Error("No chat turn is in flight, so there is no user to run this command for.");
			}

			let resultText = "";

			switch (command) {
				case "clone": {
					if (!packageName) {
						throw new Error("packageName is required for 'clone' command.");
					}

					const folder = sanitizeFolderName(packageName, packageName);
					const manifest = readManifest(connDir);

					resultText += `Listing package contents for ${packageName} from SAP...\n`;
					const listResult = await executeAdt({
						userId: turn.userId,
						workspaceId,
						argv: ["-q", "object", "list", "--parent-type", "DEVC/K", "--parent-name", packageName, "--json"],
						userJwt: turn.userJwt,
						routerBase: turn.routerBase,
					});

					if (listResult.exitCode !== 0) {
						throw new Error(`Failed to list package ${packageName} on SAP system: ${listResult.stderr}`);
					}

					const contents = JSON.parse(listResult.stdout);
					const plan = planChildren(contents);

					manifest.entries[folder] = { kind: "package", adtParentType: "DEVC/K", adtParentName: packageName, loaded: true };
					fs.mkdirSync(join(connDir, folder), { recursive: true });
					applyPlan(connDir, folder, plan, manifest);
					writeManifest(connDir, manifest);

					const objectsToHydrate: Array<{ relPath: string; adtUri: string }> = [];
					for (const [relPath, entry] of Object.entries(manifest.entries)) {
						if (relPath.startsWith(`${folder}/`) && entry.kind === "object" && entry.adtUri) {
							objectsToHydrate.push({ relPath, adtUri: entry.adtUri });
						}
					}

					resultText += `Found ${objectsToHydrate.length} objects. Hydrating files from SAP (this may take a moment)...\n`;

					const CONCURRENCY = 8;
					for (let i = 0; i < objectsToHydrate.length; i += CONCURRENCY) {
						const batch = objectsToHydrate.slice(i, i + CONCURRENCY);
						await Promise.all(batch.map(async ({ relPath, adtUri }) => {
							const absPath = join(connDir, relPath);
							if (!fs.existsSync(absPath) || fs.statSync(absPath).size === 0) {
								const res = await executeAdt({
									userId: turn.userId,
									workspaceId,
									argv: ["-q", "object", "source", adtUri, "--output", absPath],
									userJwt: turn.userJwt,
									routerBase: turn.routerBase,
								});
								if (res.exitCode !== 0) {
									await executeAdt({
										userId: turn.userId,
										workspaceId,
										argv: ["-q", "--raw", "http", "request", "GET", adtUri, "--output", absPath],
										userJwt: turn.userJwt,
										routerBase: turn.routerBase,
									});
								}
							}
						}));
					}

					//IYH1HC sapgit init
					// Creating the connection now initializes the repository, so this
					// normally finds one already there and no-ops. The call stays for
					// folders that predate that change, or that an agent shell command
					// created — a clone into an untracked folder must still self-heal.
					const repo = ensureGitRepo(connDir, {
						ignore: CONNECTION_GITIGNORE,
						initialCommitMessage: `Initialize SAP connection ${connectionName}`,
					});
					runGit(connDir, ["add", "."]);
					runGit(connDir, ["commit", "-m", `Clone from SAP: ${packageName}`]);
					resultText += repo.initialized
						? `Git repository initialized under artifacts/${connectionName}.\n`
						: `Committed clone to the Git repository under artifacts/${connectionName}.\n`;
					resultText += `Successfully cloned and hydrated ${packageName}!\n`;
					break;
				}

				case "status": {
					const gitRes = runGit(connDir, ["status"]);
					resultText = gitRes.stdout || gitRes.stderr || "No local changes.";
					break;
				}

				case "diff": {
					const gitRes = runGit(connDir, ["diff"]);
					resultText = gitRes.stdout || "No differences.";
					break;
				}

				case "add": {
					const args = files && files.length > 0 ? ["add", ...files] : ["add", "."];
					const gitRes = runGit(connDir, args);
					resultText = gitRes.stdout || gitRes.stderr || "Files staged successfully.";
					break;
				}

				case "commit": {
					if (!gitArgs || gitArgs.length === 0) {
						throw new Error("gitArgs containing commit message is required (e.g. ['-m', 'feat: update class']).");
					}
					const gitRes = runGit(connDir, ["commit", ...gitArgs]);
					resultText = gitRes.stdout || gitRes.stderr;
					break;
				}

				case "log": {
					const gitRes = runGit(connDir, ["log", ...(gitArgs || [])]);
					resultText = gitRes.stdout || gitRes.stderr;
					break;
				}

				case "branch": {
					const gitRes = runGit(connDir, ["branch", ...(gitArgs || [])]);
					resultText = gitRes.stdout || gitRes.stderr;
					break;
				}

				case "switch": {
					const gitRes = runGit(connDir, ["switch", ...(gitArgs || [])]);
					resultText = gitRes.stdout || gitRes.stderr;
					break;
				}

				case "merge": {
					const gitRes = runGit(connDir, ["merge", ...(gitArgs || [])]);
					resultText = gitRes.stdout || gitRes.stderr;
					break;
				}

				case "restore": {
					const args = files && files.length > 0 ? ["restore", ...files] : ["restore", "."];
					const gitRes = runGit(connDir, args);
					resultText = gitRes.stdout || gitRes.stderr || "Files restored successfully.";
					break;
				}

				case "pull": {
					const manifest = readManifest(connDir);
					const objectsToPull: Array<{ relPath: string; adtUri: string }> = [];

					for (const [relPath, entry] of Object.entries(manifest.entries)) {
						if (entry.kind === "object" && entry.adtUri) {
							objectsToPull.push({ relPath, adtUri: entry.adtUri });
						}
					}

					resultText += `Refreshing ${objectsToPull.length} files from SAP...\n`;

					const CONCURRENCY = 8;
					for (let i = 0; i < objectsToPull.length; i += CONCURRENCY) {
						const batch = objectsToPull.slice(i, i + CONCURRENCY);
						await Promise.all(batch.map(async ({ relPath, adtUri }) => {
							const absPath = join(connDir, relPath);
							const res = await executeAdt({
								userId: turn.userId,
								workspaceId,
								argv: ["-q", "object", "source", adtUri, "--output", absPath],
								userJwt: turn.userJwt,
								routerBase: turn.routerBase,
							});
							if (res.exitCode !== 0) {
								await executeAdt({
									userId: turn.userId,
									workspaceId,
									argv: ["-q", "--raw", "http", "request", "GET", adtUri, "--output", absPath],
									userJwt: turn.userJwt,
									routerBase: turn.routerBase,
								});
							}
						}));
					}

					runGit(connDir, ["add", "."]);
					runGit(connDir, ["commit", "-m", "Pull/Sync from SAP baseline"]);
					resultText += `Successfully pulled latest SAP state and committed to local Git.`;
					break;
				}

				case "push": {
					let filesToPush = files;
					if (!filesToPush || filesToPush.length === 0) {
						filesToPush = collectChangedFiles(connDir);
					}

					if (filesToPush.length === 0) {
						resultText = "No local changes found to push.";
						break;
					}

					const manifest = readManifest(connDir);

					for (const file of filesToPush) {
						const relPath = relative(connDir, getAbsPath(workspaceRoot, connDir, connectionName, file)).replace(/\\/g, "/");
						const entry = manifest.entries[relPath];
						if (!entry || entry.kind !== "object" || !entry.adtUri) {
							resultText += `Skipping ${file}: Not an ADT-backed object.\n`;
							continue;
						}

						const parts = relPath.split("/");
						const parentPkg = parts[0].toUpperCase();

						let resolvedTr = transport;
						if (!resolvedTr && parentPkg !== "$TMP") {
							const xml = `<?xml version="1.0" encoding="UTF-8"?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA><DEVCLASS>${parentPkg}</DEVCLASS><OPERATION>I</OPERATION><URI>${entry.adtUri}</URI></DATA></asx:values></asx:abap>`;
							const transportRes = await executeAdt({
								userId: turn.userId,
								workspaceId,
								argv: [
									"-q", "http", "request", "POST", "/sap/bc/adt/cts/transportchecks",
									"-H", "Accept: application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.transport.service.checkData",
									"--content-type", "application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.transport.service.checkData",
									"--data", xml
								],
								userJwt: turn.userJwt,
								routerBase: turn.routerBase
							});

							const lockMatch = transportRes.stdout.match(/<LOCK_HOLDER>[\s\S]*?<TRKORR>([^<]+)<\/TRKORR>/);
							if (lockMatch) {
								resolvedTr = lockMatch[1].trim();
							} else {
								const trMatches = transportRes.stdout.match(/<CTS_REQUEST>[\s\S]*?<\/CTS_REQUEST>/g) || [];
								const modifiableTrs: Array<{ tr: string; text: string }> = [];
								for (const block of trMatches) {
									const userMatch = block.match(/<AS4USER>([^<]+)<\/AS4USER>/);
									const statusMatch = block.match(/<TRSTATUS>([^<]+)<\/TRSTATUS>/);
									const trkorrMatch = block.match(/<TRKORR>([^<]+)<\/TRKORR>/);
									const textMatch = block.match(/<AS4TEXT>([^<]+)<\/AS4TEXT>/);
									if (trkorrMatch && userMatch && userMatch[1].trim().toUpperCase() === turn.userId.toUpperCase()) {
										const status = statusMatch ? statusMatch[1].trim().toUpperCase() : "D";
										if (status === "D" || status === "L") {
											modifiableTrs.push({
												tr: trkorrMatch[1].trim(),
												text: textMatch ? textMatch[1].trim() : ""
											});
										}
									}
								}
								if (modifiableTrs.length === 1) {
									resolvedTr = modifiableTrs[0].tr;
								} else if (modifiableTrs.length > 1) {
									throw new Error(`Multiple modifiable transports found for package ${parentPkg}. Please specify one of: ${modifiableTrs.map(t => `${t.tr} (${t.text})`).join(", ")} using the transport parameter.`);
								} else {
									throw new Error(`No modifiable transport request found for package ${parentPkg} under user ${turn.userId}. Please create or select one first.`);
								}
							}
						}

						const argv = ["object", "set-source", entry.adtUri, "--file", getAbsPath(workspaceRoot, connDir, connectionName, file)];
						if (resolvedTr) {
							argv.push("--transport", resolvedTr);
						}

						resultText += `Pushing ${file} to SAP... `;
						const pushRes = await executeAdt({
							userId: turn.userId,
							workspaceId,
							argv,
							userJwt: turn.userJwt,
							routerBase: turn.routerBase
						});

						if (pushRes.exitCode === 0) {
							resultText += "OK\n";
							if (activate) {
								resultText += `Activating ${file} in SAP... `;
								const actRes = await executeAdt({
									userId: turn.userId,
									workspaceId,
									argv: ["object", "activate", entry.adtUri],
									userJwt: turn.userJwt,
									routerBase: turn.routerBase
								});

								if (actRes.exitCode === 0) {
									resultText += "OK\n";
								} else {
									resultText += `FAILED:\n${actRes.stderr}\n`;
								}
							}
						} else {
							resultText += `FAILED:\n${pushRes.stderr}\n`;
							resultText += parseSapDiagnostics(pushRes.stderr);
						}
					}
					break;
				}

				case "activate": {
					let filesToActivate = files;
					if (!filesToActivate || filesToActivate.length === 0) {
						filesToActivate = collectChangedFiles(connDir);
					}

					if (filesToActivate.length === 0) {
						resultText = "No local changes found to activate.";
						break;
					}

					const manifest = readManifest(connDir);

					for (const file of filesToActivate) {
						const relPath = relative(connDir, getAbsPath(workspaceRoot, connDir, connectionName, file)).replace(/\\/g, "/");
						const entry = manifest.entries[relPath];
						if (!entry || entry.kind !== "object" || !entry.adtUri) {
							resultText += `Skipping ${file}: Not an ADT-backed object.\n`;
							continue;
						}

						resultText += `Activating ${file} in SAP... `;
						const actRes = await executeAdt({
							userId: turn.userId,
							workspaceId,
							argv: ["object", "activate", entry.adtUri],
							userJwt: turn.userJwt,
							routerBase: turn.routerBase
						});

						if (actRes.exitCode === 0) {
							resultText += "OK\n";
						} else {
							resultText += `FAILED:\n${actRes.stderr}\n`;
						}
					}
					break;
				}

				case "check": {
					let filesToCheck = files;
					if (!filesToCheck || filesToCheck.length === 0) {
						filesToCheck = collectChangedFiles(connDir);
					}

					if (filesToCheck.length === 0) {
						resultText = "No files specified or changed to check.";
						break;
					}

					const manifest = readManifest(connDir);

					for (const file of filesToCheck) {
						const relPath = relative(connDir, getAbsPath(workspaceRoot, connDir, connectionName, file)).replace(/\\/g, "/");
						const entry = manifest.entries[relPath];
						if (!entry || entry.kind !== "object" || !entry.adtUri) {
							resultText += `Skipping ${file}: Not an ADT-backed object.\n`;
							continue;
						}

						resultText += `Running ATC checks on ${file}...\n`;
						const checkRes = await executeAdt({
							userId: turn.userId,
							workspaceId,
							argv: ["atc", "check", entry.adtUri, "--variant", "DEFAULT"],
							userJwt: turn.userJwt,
							routerBase: turn.routerBase
						});

						resultText += checkRes.stdout || checkRes.stderr || "No findings.";
						if (checkRes.exitCode !== 0) {
							resultText += parseSapDiagnostics(checkRes.stderr);
						}
					}
					break;
				}

				case "create": {
					if (!packageName) {
						throw new Error("packageName is required for 'create' command.");
					}
					if (!objectType) {
						throw new Error("objectType is required for 'create' command (e.g. 'CLAS/OC', 'INTF/OI', 'PROG/P').");
					}
					if (!objectName) {
						throw new Error("objectName is required for 'create' command (e.g. 'ZCL_MY_CLASS').");
					}

					const parentPkg = packageName.toUpperCase();
					const cleanName = objectName.toUpperCase();
					const cleanType = objectType.toUpperCase();

					let resolvedTr = transport;
					if (!resolvedTr && parentPkg !== "$TMP") {
						// Lock/TR Discovery
						const xml = `<?xml version="1.0" encoding="UTF-8"?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA><DEVCLASS>${parentPkg}</DEVCLASS><OPERATION>I</OPERATION></DATA></asx:values></asx:abap>`;
						const transportRes = await executeAdt({
							userId: turn.userId,
							workspaceId,
							argv: [
								"-q", "http", "request", "POST", "/sap/bc/adt/cts/transportchecks",
								"-H", "Accept: application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.transport.service.checkData",
								"--content-type", "application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.transport.service.checkData",
								"--data", xml
							],
							userJwt: turn.userJwt,
							routerBase: turn.routerBase
						});

						const lockMatch = transportRes.stdout.match(/<LOCK_HOLDER>[\s\S]*?<TRKORR>([^<]+)<\/TRKORR>/);
						if (lockMatch) {
							resolvedTr = lockMatch[1].trim();
						} else {
							const trMatches = transportRes.stdout.match(/<CTS_REQUEST>[\s\S]*?<\/CTS_REQUEST>/g) || [];
							const modifiableTrs: Array<{ tr: string; text: string }> = [];
							for (const block of trMatches) {
								const userMatch = block.match(/<AS4USER>([^<]+)<\/AS4USER>/);
								const statusMatch = block.match(/<TRSTATUS>([^<]+)<\/TRSTATUS>/);
								const trkorrMatch = block.match(/<TRKORR>([^<]+)<\/TRKORR>/);
								const textMatch = block.match(/<AS4TEXT>([^<]+)<\/AS4TEXT>/);
								if (trkorrMatch && userMatch && userMatch[1].trim().toUpperCase() === turn.userId.toUpperCase()) {
									const status = statusMatch ? statusMatch[1].trim().toUpperCase() : "D";
									if (status === "D" || status === "L") {
										modifiableTrs.push({
											tr: trkorrMatch[1].trim(),
											text: textMatch ? textMatch[1].trim() : ""
										});
									}
								}
							}
							if (modifiableTrs.length === 1) {
								resolvedTr = modifiableTrs[0].tr;
							} else if (modifiableTrs.length > 1) {
								throw new Error(`Multiple modifiable transports found for package ${parentPkg}. Please specify one of: ${modifiableTrs.map(t => `${t.tr} (${t.text})`).join(", ")} using the transport parameter.`);
							} else {
								throw new Error(`No modifiable transport request found for package ${parentPkg} under user ${turn.userId}. Please create or select one first.`);
							}
						}
					}

					// 1. Create the Object shell in SAP
					resultText += `Creating object ${cleanName} (${cleanType}) in SAP under package ${parentPkg}...\n`;
					const createArgv = ["object", "create", cleanType, cleanName, "--package", parentPkg, "--description", description || "Created via sapgit"];
					if (resolvedTr) {
						createArgv.push("--transport", resolvedTr);
					}
					
					const createRes = await executeAdt({
						userId: turn.userId,
						workspaceId,
						argv: createArgv,
						userJwt: turn.userJwt,
						routerBase: turn.routerBase
					});

					if (createRes.exitCode !== 0) {
						throw new Error(`Failed to create object shell in SAP: ${createRes.stderr}`);
					}

					// 2. Generate slug, file structure, and seed content on disk
					const slug = cleanType.split("/")[0].toLowerCase();
					const ext = slug === "clas" || slug === "intf" || slug === "prog" ? "abap" : "xml";
					const base = cleanName.toLowerCase().replace(/\//g, "#");
					const fileSlug = `${base}.${slug}.${ext}`;
					
					const folder = sanitizeFolderName(packageName, packageName);
					const catFolder = getCategoryFolder(cleanType);
					const relPath = `${folder}/${catFolder}/${fileSlug}`.replace(/\\/g, "/");
					
					resultText += `Writing initial code shell to artifacts/${connectionName}/${relPath}...\n`;
					const absPath = join(connDir, relPath);
					fs.mkdirSync(dirname(absPath), { recursive: true });
					const initialCode = getInitialShell(cleanType, cleanName, description || "");
					fs.writeFileSync(absPath, initialCode);

					// 3. Register the newly created object in tree.json manifest
					resultText += `Updating tree.json manifest...\n`;
					const manifest = readManifest(connDir);
					
					let adtUri = "";
					const mainType = cleanType.split("/")[0].toUpperCase();
					if (mainType === "CLAS") adtUri = `/sap/bc/adt/oo/classes/${base}`;
					else if (mainType === "INTF") adtUri = `/sap/bc/adt/oo/interfaces/${base}`;
					else if (mainType === "PROG") adtUri = `/sap/bc/adt/programs/programs/${base}`;

					manifest.entries[relPath] = {
						kind: "object",
						adtUri,
						typeId: cleanType,
						label: cleanName,
						description: description || "Created via sapgit"
					};
					writeManifest(connDir, manifest);

					// 4. Git track baseline
					runGit(connDir, ["add", "."]);
					runGit(connDir, ["commit", "-m", `Create object shell: ${cleanName} [${cleanType}]`]);
					
					// 5. Optional auto-activation
					if (activate) {
						resultText += `Activating new object ${cleanName} in SAP... `;
						const actRes = await executeAdt({
							userId: turn.userId,
							workspaceId,
							argv: ["object", "activate", adtUri],
							userJwt: turn.userJwt,
							routerBase: turn.routerBase
						});

						if (actRes.exitCode === 0) {
							resultText += "OK\n";
						} else {
							resultText += `FAILED:\n${actRes.stderr}\n`;
						}
					}
					
					resultText += `Successfully created and initialized ${cleanName}!\n`;
					break;
				}
			}

			const durationMs = Date.now() - startedAt;

			log.logInfo(
				`[sapgit] ${JSON.stringify({
					runId: turn.runId,
					userId: turn.userId,
					workspaceId,
					channelId: closure.channelId,
					command,
					durationMs,
				})}`,
			);

			const capped = capOutput(resultText);

			return {
				content: [{ type: "text" as const, text: capped.text }],
				details: {
					command,
					connectionName,
					packageName,
					durationMs,
					truncated: capped.truncated,
					turn: {
						runId: turn.runId,
						userId: turn.userId,
						ageMs: startedAt - turn.startedAt,
					},
					context: {
						instanceId,
						builtAt,
						channelId: closure.channelId,
						workspaceId,
						toolCallId,
					},
				},
			};
		}
	};
}