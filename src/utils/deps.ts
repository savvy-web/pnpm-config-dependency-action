/**
 * Pure dependency parsing helpers.
 *
 * Extracted from `src/lib/pnpm/config.ts` and `src/lib/pnpm/regular.ts`.
 * These functions have NO Effect service dependencies.
 *
 * @module utils/deps
 */

import { matchesGlob } from "node:path";

/**
 * Parse a config dependency entry from pnpm-workspace.yaml.
 *
 * Config dependency entries have the format `version+sha512-base64hash`
 * or just `version` (no hash). Cannot split on `+` naively because
 * the base64 hash itself contains `+` characters.
 *
 * @example
 * parseConfigEntry("0.6.3+sha512-abc==") // { version: "0.6.3", hash: "sha512-abc==" }
 * parseConfigEntry("0.6.3")              // { version: "0.6.3", hash: null }
 */
export const parseConfigEntry = (entry: string): { version: string; hash: string | null } | null => {
	if (!entry || entry.trim().length === 0) return null;

	// Find the first occurrence of "+sha" which marks the boundary
	// between version and integrity hash
	const shaIndex = entry.indexOf("+sha");
	if (shaIndex === -1) {
		// No hash suffix — entry is just a version
		return { version: entry, hash: null };
	}

	return {
		version: entry.substring(0, shaIndex),
		hash: entry.substring(shaIndex + 1), // skip the "+"
	};
};

/**
 * Check if a dependency name matches a glob pattern.
 *
 * Uses Node's native `path.matchesGlob` for safe pattern matching
 * without regex metacharacter injection issues.
 *
 * - Exact match: `effect` matches `effect`
 * - Scoped wildcard: `@savvy-web/*` matches `@savvy-web/changesets`
 * - Bare wildcard: `*` matches anything
 */
export const matchesPattern = (depName: string, pattern: string): boolean => {
	return matchesGlob(depName, pattern);
};

/**
 * Parse a version specifier into prefix and version.
 *
 * Returns null for catalog: and workspace: specifiers (should be skipped).
 */
export const parseSpecifier = (specifier: string): { prefix: string; version: string } | null => {
	if (specifier.startsWith("catalog:")) return null;
	if (specifier.startsWith("workspace:")) return null;

	// Match optional prefix (>=, <=, >, <, ^, ~) followed by a semver-like version
	const match = specifier.match(/^(>=|<=|>|<|\^|~)?(\d+\.\d+\.\d+.*)$/);
	if (!match) return null;

	return {
		prefix: match[1] ?? "",
		version: match[2],
	};
};
