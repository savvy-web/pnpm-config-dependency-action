/**
 * Pure helpers for reading and rewriting devEngines.runtime entries.
 *
 * No Effect service dependencies — mirrors src/utils/pnpm.ts.
 *
 * The `upgrade-runtime-*` inputs only ever *upgrade* a runtime the manifest
 * already declares — they never introduce one — so there is no "upsert": an
 * entry is located with {@link locateRuntimeEntry} and rewritten through
 * `PackageJsonFile.modify` at the returned path. Resolved versions are written
 * bare (exact, no range operator), so no operator parsing or re-decoration is
 * needed either.
 *
 * **Why a path and not a live object.** This module used to expose
 * `findRuntimeEntry`, which returned the live entry inside `devEngines` so that
 * assigning `.version` rewrote the parsed tree in place; the manifest was then
 * re-serialized wholesale. That is no longer how the write happens — the write
 * is a surgical edit applied by `@effected/package-json` at a JSONC path, which
 * preserves every byte outside the edited span. So the locator returns the path
 * as well, and one walker produces both rather than a second walker deriving the
 * path separately and drifting from the first.
 *
 * @module utils/runtime
 */

/** A JavaScript runtime managed by this action. */
export type RuntimeName = "node" | "deno" | "bun";

/** A single devEngines.runtime entry (extra keys preserved on write). */
export interface RuntimeEntry {
	name?: string;
	version?: string;
	onFail?: string;
	[key: string]: unknown;
}

const RANGE_OPERATOR_RE = /^(>=|<=|\^|~|>|<|=)/;

/**
 * True when `raw` is a static exact version (bare `X.Y.Z`, optionally with
 * prerelease/build) — i.e. it carries no range operator, wildcard, OR-set, or
 * partial form. Used to make `auto` a no-op on pinned versions.
 */
export const isStaticVersion = (raw: string): boolean => {
	const value = raw.trim();
	if (RANGE_OPERATOR_RE.test(value)) return false;
	if (/[x*]/i.test(value)) return false;
	if (/\s|\|\|/.test(value)) return false;
	return /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(value);
};

const toEntryList = (runtimeField: unknown): RuntimeEntry[] => {
	if (runtimeField === undefined || runtimeField === null) return [];
	return Array.isArray(runtimeField) ? (runtimeField as RuntimeEntry[]) : [runtimeField as RuntimeEntry];
};

/** A located `devEngines.runtime` entry and the JSONC path to its `version`. */
export interface LocatedRuntimeEntry {
	/** The entry as parsed — read it for the current version; do not mutate it. */
	readonly entry: RuntimeEntry;
	/**
	 * Path to this entry's `version` field, for `PackageJsonFile.modify`.
	 *
	 * Shape-dependent, which is the whole reason this is returned rather than
	 * rebuilt by the caller: `devEngines.runtime` is legally either a single
	 * object or an array, so the path is `["devEngines", "runtime", "version"]`
	 * in the first case and `["devEngines", "runtime", <index>, "version"]` in
	 * the second. Getting that wrong writes to a path that does not exist.
	 */
	readonly versionPath: ReadonlyArray<string | number>;
}

/**
 * Locate the `devEngines.runtime` entry for `runtime`, or null. Accepts the
 * object and array shapes alike, and reports the JSONC path to its `version`
 * alongside the entry itself.
 */
export const locateRuntimeEntry = (devEngines: unknown, runtime: RuntimeName): LocatedRuntimeEntry | null => {
	const runtimeField = (devEngines as { runtime?: unknown } | undefined)?.runtime;
	const isArray = Array.isArray(runtimeField);
	const entries = toEntryList(runtimeField);

	for (const [index, entry] of entries.entries()) {
		if (entry && typeof entry === "object" && entry.name === runtime) {
			return {
				entry,
				versionPath: isArray ? ["devEngines", "runtime", index, "version"] : ["devEngines", "runtime", "version"],
			};
		}
	}
	return null;
};
