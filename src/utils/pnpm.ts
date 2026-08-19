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
// and zero in `__test__/` — `PackageManagerUpgrade` parsed with a local
// `parsePmVersion` generalized over all three managers, which is what the
// multi-package-manager work replaced them with. (That local parser has since
// been retired too, onto `@effected/npm`'s `PackageManagerPin`.)
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

// `corepackHashFromIntegrity` was DELETED here (issue #290). The SRI
// (`sha512-<base64>`) → corepack (`sha512.<hex>`) conversion is now
// `@effected/npm`'s `CorepackIntegrityHash.fromSri`, a swap this
// implementation itself motivated — effected#281 cites it as the consumer
// evidence. Its single caller (`services/package-manager-upgrade.ts`) reads
// the kit surface directly.
//
// The kit is not a like-for-like port and the difference is the point: this
// version decoded whatever followed `sha512-` and emitted the hex, so
// non-canonical base64 and a digest of the wrong length both produced a pin
// that *looked* well-formed and that corepack rejects at install time — in
// someone else's repository, after this action reported success. The kit
// rejects both, typed, and the caller degrades to the bare-version write it
// already took for an absent integrity.
//
// Note the argument is NOT the one above: this export had a caller and was
// carrying its weight. It went because the capability moved upstream, which is
// the only reason worth deleting a working helper for.
//
// `detectIndent` is now the whole of this module.
