/**
 * Pure markdown/URL helper functions.
 *
 * The GFM writer itself is `GitHubMarkdown` from `@effected/github-actions` —
 * this module holds only the two builders that writer does not ship (`bold`,
 * `rule`) plus the npm URL/version helpers. It is deliberately NOT a second
 * markdown writer: see the note on {@link bold}.
 *
 * @module utils/markdown
 */

/**
 * Bold (strong) text.
 *
 * @remarks
 * One of exactly two builders `GitHubMarkdown` does not ship (the other is
 * {@link rule}). Both are literal-only — no escaping, no structure — which is
 * why they can live here without re-forking the writer: everything with a
 * corruption mode a caller could hit (tables, code spans, fenced blocks,
 * links, lists) goes through the kit's serializer instead of string joining.
 *
 * Do not grow this module back into a markdown writer. If a third builder is
 * needed, check `GitHubMarkdown` first, then ask upstream for it.
 */
export const bold = (text: string): string => `**${text}**`;

/**
 * A horizontal rule. See the note on {@link bold} for why this lives here.
 */
export const rule = (): string => "---";

/**
 * Generate npm package URL.
 */
export const npmUrl = (pkg: string): string => `https://www.npmjs.com/package/${pkg}`;

/**
 * Extract clean version from pnpm version string (removes hash suffix).
 */
export const cleanVersion = (version: string | null): string | null => {
	if (!version) return null;
	// Remove +sha512-... suffix if present
	return version.split("+")[0];
};
