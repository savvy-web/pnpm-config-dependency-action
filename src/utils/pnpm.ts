/**
 * Pure pnpm helper functions.
 *
 * Extracted from `src/lib/pnpm/upgrade.ts` for reuse across modules.
 * These functions have NO Effect service dependencies.
 *
 * @module utils/pnpm
 */

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Parsed pnpm version info.
 */
export interface ParsedPnpmVersion {
	readonly version: string;
	readonly hasCaret: boolean;
	readonly hasSha: boolean;
}

// ══════════════════════════════════════════════════════════════════════════════
// Functions
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Parse a pnpm version string from `packageManager` or `devEngines.packageManager.version`.
 *
 * Handles formats:
 * - `pnpm@10.28.2` (packageManager field, exact)
 * - `pnpm@10.28.2+sha512...` (packageManager field, with integrity hash)
 * - `pnpm@^10.28.2` (packageManager field, with caret)
 * - `10.28.2` (devEngines version field, exact)
 * - `^10.28.2` (devEngines version field, with caret)
 *
 * @param raw - The raw version string
 * @param stripPnpmPrefix - Whether to strip the `pnpm@` prefix (true for packageManager field)
 */
export const parsePnpmVersion = (raw: string, stripPnpmPrefix = false): ParsedPnpmVersion | null => {
	if (!raw) return null;

	let value = raw.trim();

	// Strip `pnpm@` prefix if present
	if (stripPnpmPrefix) {
		if (!value.startsWith("pnpm@")) return null;
		value = value.slice(5); // Remove "pnpm@"
	}

	// Detect and strip sha suffix
	const hasSha = value.includes("+");
	if (hasSha) {
		value = value.split("+")[0];
	}

	// Detect and strip caret
	const hasCaret = value.startsWith("^");
	if (hasCaret) {
		value = value.slice(1);
	}

	// Validate as semver
	if (!/^\d+\.\d+\.\d+/.test(value)) return null;

	return { version: value, hasCaret, hasSha };
};

/**
 * Format a pnpm version with optional caret prefix.
 */
export const formatPnpmVersion = (version: string, hasCaret: boolean): string => {
	return hasCaret ? `^${version}` : version;
};

/**
 * Detect indentation used in a JSON file (tab or N spaces).
 */
export const detectIndent = (content: string): string | number => {
	const match = content.match(/^(\s+)"/m);
	if (match) {
		const indent = match[1];
		if (indent.includes("\t")) return "\t";
		return indent.length;
	}
	return "\t";
};
