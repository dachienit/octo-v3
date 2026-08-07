/**
 * `@`-mention resolution.
 *
 * Mentions are **re-derived from the message text at send time**, never tracked as
 * state while the user types. Tracking them desynchronises the moment the text is
 * edited: delete an `@token` and a recorded mention would linger, retype one by
 * hand and it would be missed. Deriving keeps the text the single source of truth.
 *
 * Matching is greedy-longest against the candidate list rather than
 * whitespace-tokenised, because file names contain spaces — `@Q3 report.md` has to
 * win over `@Q3`.
 */

import type { MentionPayload, MentionScope, WorkspaceNode, WorkspaceTree } from "../adapters/core-service.js";

export interface MentionCandidate {
	/**
	 * What appears after `@` in the message, and the key matching resolves against.
	 * A directory carries a trailing `/` — it is what marks the row as steppable in the
	 * picker and what scopes the listing once inserted. `path` never carries it.
	 */
	token: string;
	/** Leaf name, for display. */
	name: string;
	scope: MentionScope;
	/** Path relative to the scope root — what travels to the server. */
	path: string;
	type: "file" | "directory";
}

/**
 * Flattens the workspace tree into mention candidates.
 *
 * The tree's `path` is data-root-relative (`workspaces/<ws>/artifacts/a/b.md`), but
 * a mention travels as scope + scope-relative path, so the shared prefix is cut
 * here. Attachment tokens keep an `attachments/` prefix so the two scopes stay
 * visually distinct in the composer; a real `artifacts/attachments/` folder would
 * collide, which `resolveMentions` settles by list order (artifacts first).
 */
export function buildMentionCandidates(tree: WorkspaceTree | null | undefined): MentionCandidate[] {
	if (!tree) return [];
	const candidates: MentionCandidate[] = [];

	const walk = (nodes: WorkspaceNode[] | undefined, scope: MentionScope, rootPrefix: string, tokenPrefix: string) => {
		for (const node of nodes ?? []) {
			const relative = node.path.startsWith(rootPrefix) ? node.path.slice(rootPrefix.length) : node.path;
			candidates.push({
				token: `${tokenPrefix}${relative}${node.type === "directory" ? "/" : ""}`,
				name: node.name,
				scope,
				path: relative,
				type: node.type,
			});
			if (node.children) walk(node.children, scope, rootPrefix, tokenPrefix);
		}
	};

	// The prefix is derived from the first node rather than assumed, because the
	// workspace and session ids are baked into the server's paths.
	const artifactsPrefix = rootPrefixOf(tree.artifacts, "artifacts");
	walk(tree.artifacts, "artifacts", artifactsPrefix, "");

	const attachmentsPrefix = rootPrefixOf(tree.attachments, "attachments");
	walk(tree.attachments, "attachments", attachmentsPrefix, "attachments/");

	return candidates;
}

/** `workspaces/ws_1/artifacts/a/b.md` + segment `artifacts` -> `workspaces/ws_1/artifacts/`. */
function rootPrefixOf(nodes: WorkspaceNode[] | undefined, segment: string): string {
	const sample = nodes?.[0]?.path;
	if (!sample) return "";
	const marker = `/${segment}/`;
	const index = sample.lastIndexOf(marker);
	return index === -1 ? "" : sample.slice(0, index + marker.length);
}

/**
 * Narrows the candidate list to what the current `@token` is asking for.
 *
 * The query is cut at its last `/`: everything before it scopes the listing to one
 * directory, everything after it searches inside that scope. With no term the picker is
 * being *browsed*, so only direct children show and a folder stays one step rather than
 * a dump of its whole subtree; type something and the search widens to every descendant.
 * With no scope at all — a bare `@` — the scope is each candidate's own root, which is
 * why depth is measured on `path` there: the `attachments/` token prefix marks a scope,
 * not a directory the user has stepped into.
 */
export function filterCandidates(candidates: MentionCandidate[], query: string, limit: number): MentionCandidate[] {
	const slash = query.lastIndexOf("/");
	const prefix = slash === -1 ? "" : query.slice(0, slash + 1);
	const terms = query
		.slice(slash + 1)
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean);
	const lowerPrefix = prefix.toLowerCase();

	const matches: MentionCandidate[] = [];
	for (const candidate of candidates) {
		if (prefix && !candidate.token.toLowerCase().startsWith(lowerPrefix)) continue;
		const rest = prefix ? candidate.token.slice(prefix.length) : candidate.path;
		if (!rest) continue; // the scoping directory itself

		if (terms.length === 0) {
			const body = rest.endsWith("/") ? rest.slice(0, -1) : rest;
			if (body.includes("/")) continue;
		} else {
			const haystack = (prefix ? rest : candidate.token).toLowerCase();
			if (!terms.every((term) => haystack.includes(term))) continue;
		}

		matches.push(candidate);
		if (matches.length >= limit) break;
	}
	return matches;
}

/**
 * Finds the `@` token the caret currently sits in, or null when there is none.
 *
 * The trigger only counts at a word boundary — start of text or after whitespace —
 * so an email address or `a@b` never opens the picker. A newline ends a token.
 */
export function findActiveMention(text: string, caret: number): { start: number; query: string } | null {
	for (let i = caret - 1; i >= 0; i--) {
		const char = text[i];
		if (char === "\n") return null;
		if (char !== "@") continue;

		const before = i > 0 ? text[i - 1] : undefined;
		if (before !== undefined && !/\s/.test(before)) return null;
		return { start: i, query: text.slice(i + 1, caret) };
	}
	return null;
}

/**
 * Extracts the mentions a message text refers to.
 *
 * At each `@`, the longest candidate token that the text continues with wins, and
 * only when the match ends at a word boundary — so `@report.md` does not match a
 * candidate `report.m`. Unmatched `@foo` stays ordinary text.
 */
export function resolveMentions(text: string, candidates: MentionCandidate[]): MentionPayload[] {
	if (candidates.length === 0) return [];

	// A directory is spelled both ways: `@abc/` is what the picker inserts, `@abc` is what
	// a user types by hand. Longest first so a greedy match never settles for a shorter prefix.
	const ordered = candidates
		.flatMap((candidate) =>
			candidate.type === "directory"
				? [
						{ candidate, text: candidate.token },
						{ candidate, text: candidate.token.slice(0, -1) },
					]
				: [{ candidate, text: candidate.token }],
		)
		.sort((a, b) => b.text.length - a.text.length);
	const found: MentionPayload[] = [];
	const seen = new Set<string>();

	for (let i = 0; i < text.length; i++) {
		if (text[i] !== "@") continue;
		const before = i > 0 ? text[i - 1] : undefined;
		if (before !== undefined && !/\s/.test(before)) continue;

		const rest = text.slice(i + 1);
		const match = ordered.find((entry) => {
			if (!rest.startsWith(entry.text)) return false;
			const after = rest[entry.text.length];
			return after === undefined || /[\s.,;:!?)\]}]/.test(after);
		});
		if (!match) continue;

		const hit = match.candidate;
		const key = `${hit.scope}:${hit.path}`;
		if (!seen.has(key)) {
			seen.add(key);
			found.push({ scope: hit.scope, path: hit.path });
		}
		i += match.text.length;
	}

	return found;
}
