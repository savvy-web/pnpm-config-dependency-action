/**
 * Pure pnpm helper functions.
 *
 * Extracted from `src/lib/pnpm/upgrade.ts` for reuse across modules.
 * These functions have NO Effect service dependencies.
 *
 * @module utils/pnpm
 */

// ══════════════════════════════════════════════════════════════════════════════
// Functions
// ══════════════════════════════════════════════════════════════════════════════

// `parsePnpmVersion` / `formatPnpmVersion` / `ParsedPnpmVersion` were DELETED
// here, and the deletion is the same argument that removed four error classes
// from `errors/errors.ts`: an export with no caller is a claim the type system
// carries indefinitely and no test can falsify. They had zero callers in `src/`
// and zero in `__test__/` — `PackageManagerUpgrade` parses with a local
// `parsePmVersion` generalized over all three managers, which is what the
// multi-package-manager work replaced them with.
//
// Their recorded justification for staying had also stopped being true
// independently: it was that `@effected/package-json` rejected a caret pin
// (`pnpm@^11.20.0`), which `PackageManagerRange` has accepted since 0.9.0. A
// dead export kept alive by a reason that had itself expired.

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

/**
 * Convert an npm registry integrity (`sha512-<base64>`) to the corepack
 * `packageManager` hash form (`sha512.<hex>`) — the exact string `corepack use`
 * would write. Returns null when the value is missing or not a sha512 integrity.
 */
export const corepackHashFromIntegrity = (integrity: string): string | null => {
	const value = integrity.trim().replace(/^"(.*)"$/, "$1");
	const match = value.match(/^sha512-(.+)$/);
	if (!match) return null;
	const hex = Buffer.from(match[1], "base64").toString("hex");
	return `sha512.${hex}`;
};
