/**
 * Shared path shortening for the output of `glob` and `grep`.
 *
 * Both tools print one path per row — `glob` for every match, `grep` for every
 * file group and every entry in `files_with_matches`. On a deployed instance the
 * workspace prefix is around sixty characters, so on a broad search repeating it
 * is the difference between a few hundred tokens and a few thousand. Stripping
 * the prefix and stating it once in a header line is the whole point.
 *
 * Two rules keep the shortened form safe to copy into another tool call:
 * rows are shortened only when they sit under `roots[0]`, and only when the
 * caller passed no explicit `path`. That is the one case where `roots[0]` is
 * exactly the executor cwd, so a relative path taken from this output still
 * resolves in `read`, `write` and `bash`. Everything else — an extra search root
 * such as the session's attachments, or any path outside the cwd — stays
 * absolute and remains safe to copy as it is.
 */

export interface PathShortener {
	/** The path as it should appear: relative when that is safe, absolute otherwise. */
	display(path: string): string;
	/**
	 * The header naming the root the relative rows are based on, or "" when
	 * nothing was shortened. Call it after every `display`, since it reports what
	 * actually happened rather than what was possible.
	 */
	header(): string;
}

export function createPathShortener(roots: string[] | undefined, hasExplicitPath: boolean): PathShortener {
	const cwdRoot = hasExplicitPath ? undefined : roots?.[0];
	const prefixes = cwdRoot ? [`${cwdRoot}/`, `${cwdRoot}\\`] : [];
	let shortened = false;

	return {
		display(path: string): string {
			const prefix = prefixes.find((candidate) => path.startsWith(candidate));
			if (!prefix) return path;
			shortened = true;
			return path.slice(prefix.length).replace(/\\/g, "/");
		},
		header(): string {
			return shortened ? `[Relative to ${cwdRoot}/ unless absolute]` : "";
		},
	};
}
