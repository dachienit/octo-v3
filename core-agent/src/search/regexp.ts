/**
 * Search pattern compilation shared by the host-side document pass and the
 * search engine.
 *
 * The engine carries its own copy of this logic inside its program text (it
 * cannot import anything), so the two must stay in agreement — that duplication
 * is the accepted cost of the engine being a self-contained program.
 */

export interface SearchRegExpOptions {
	ignoreCase?: boolean;
	/** Let `.` match newlines so a pattern can span lines. */
	multiline?: boolean;
	/** Add the global flag, needed for repeated matching within one string. */
	global?: boolean;
}

export function buildSearchRegExp(pattern: string, options: SearchRegExpOptions = {}): RegExp {
	let flags = "";
	if (options.ignoreCase) flags += "i";
	if (options.multiline) flags += "s";
	if (options.global) flags += "g";

	try {
		return new RegExp(pattern, flags);
	} catch (cause) {
		throw new Error(`Invalid regular expression: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
}
