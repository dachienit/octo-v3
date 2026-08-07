/** A workspace skill the composer can offer and the user can invoke with `/name`. */
export type ComposerSkill = { name: string; path: string; description?: string };

/**
 * Skill names are directory names, so the token charset matches what a folder may be
 * called. The picker and the send-time resolver must agree on it — otherwise the picker
 * would offer a completion that then resolves to nothing.
 */
const SKILL_NAME_CHAR = /[A-Za-z0-9._-]/;
const SKILL_COMMAND_PATTERN = /(?:^|\s)\/([A-Za-z0-9._-]+)/g;

/**
 * Finds the skills the message invokes as `/name`.
 *
 * Like `@` mentions, this is derived from the final text at send time rather than tracked
 * while typing, so editing or deleting a token stays consistent for free — and typing
 * `/sap-abap` by hand works exactly like picking it from the menu. Only names the workspace
 * actually has are returned; a stray `/tmp/foo` in prose resolves to nothing.
 */
export function resolveSkillCommands(text: string, skills: ComposerSkill[]): string[] {
	if (skills.length === 0 || !text) return [];
	const known = new Map(skills.map((skill) => [skill.name.toLowerCase(), skill.name]));
	const found: string[] = [];

	for (const match of text.matchAll(SKILL_COMMAND_PATTERN)) {
		const name = known.get(match[1].toLowerCase());
		if (name && !found.includes(name)) found.push(name);
	}
	return found;
}

/**
 * Finds the `/` token the caret currently sits in, or null when there is none.
 *
 * Mirrors `findActiveMention`: the trigger only counts at a word boundary — start of text
 * or after whitespace — so a path like `src/util.ts` never opens the picker. A space ends
 * the token, so the list stops following the user once they have moved on to their message.
 */
export function findActiveSkillCommand(text: string, caret: number): { start: number; query: string } | null {
	for (let i = caret - 1; i >= 0; i--) {
		const char = text[i];
		if (char === "/") {
			const before = i > 0 ? text[i - 1] : undefined;
			if (before !== undefined && !/\s/.test(before)) return null;
			return { start: i, query: text.slice(i + 1, caret) };
		}
		// Anything a skill name cannot contain — whitespace included — ends the search.
		if (!SKILL_NAME_CHAR.test(char)) return null;
	}
	return null;
}

/**
 * Filters skills for the picker. Unlike mention candidates these match on their
 * description too: a user who remembers what a skill does but not what it is called is
 * exactly who the picker is for.
 */
export function filterSkills(skills: ComposerSkill[], query: string, limit: number): ComposerSkill[] {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return skills.slice(0, limit);

	const matches: ComposerSkill[] = [];
	for (const skill of skills) {
		const haystack = `${skill.name} ${skill.description ?? ""}`.toLowerCase();
		if (terms.every((term) => haystack.includes(term))) {
			matches.push(skill);
			if (matches.length >= limit) break;
		}
	}
	return matches;
}
