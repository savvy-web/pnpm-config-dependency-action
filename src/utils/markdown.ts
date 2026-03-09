/**
 * Pure markdown/URL helper functions.
 *
 * Extracted from `src/main.ts` for reuse and testability.
 *
 * @module utils/markdown
 */

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
