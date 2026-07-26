/**
 * Semver resolution utilities.
 *
 * Extracted from `src/lib/pnpm/upgrade.ts`. Uses `SemVer` / `Range` from
 * `@effected/semver` (value classes with static parsers, not an Effect
 * service).
 *
 * @module utils/semver
 */

import { Range, SemVer } from "@effected/semver";
import { Effect, Option } from "effect";

/**
 * Resolve the latest stable version satisfying an arbitrary semver range.
 *
 * Unparseable versions and an unparseable range both degrade to `null` rather
 * than failing: the callers treat "no resolvable target" as "skip this
 * dependency", and a malformed registry entry should not abort the run.
 *
 * @param versions - Available versions to choose from
 * @param range - A semver range string (e.g. "^10.28.0", "^11", ">=11")
 * @returns The highest stable version satisfying the range, or null if none found
 */
export const resolveLatestSatisfying = (
	versions: ReadonlyArray<string>,
	range: string,
): Effect.Effect<string | null, never, never> =>
	Effect.gen(function* () {
		// Filter out pre-release versions. The parsed value is paired with the
		// registry's own spelling so the winner is written back verbatim rather
		// than in SemVer's canonical form — these strings land in manifests.
		const stable: Array<{ readonly raw: string; readonly semver: SemVer }> = [];
		for (const raw of versions) {
			const parsed = yield* SemVer.parse(raw).pipe(Effect.option);
			if (Option.isSome(parsed) && parsed.value.isStable) {
				stable.push({ raw, semver: parsed.value });
			}
		}

		if (stable.length === 0) return null;

		const parsedRange = yield* Range.parse(range).pipe(Effect.option);
		if (Option.isNone(parsedRange)) return null;

		const best = Range.maxSatisfying(
			stable.map((entry) => entry.semver),
			parsedRange.value,
		);
		if (Option.isNone(best)) return null;

		const winner = stable.find((entry) => entry.semver.equal(best.value));
		return winner === undefined ? best.value.toString() : winner.raw;
	});

/**
 * Resolve the latest version within a `^` range from available versions.
 *
 * @param versions - Available versions to choose from
 * @param current - The current version (used to construct `^current` range)
 * @returns The highest version satisfying `^current`, or null if none found
 */
export const resolveLatestInRange = (
	versions: ReadonlyArray<string>,
	current: string,
): Effect.Effect<string | null, never, never> => resolveLatestSatisfying(versions, `^${current}`);

/**
 * Derive the upgrade range for a config dependency from its current version.
 *
 * Config dependencies in `pnpm-workspace.yaml` are hash-pinned exact versions
 * with no declared range, so we synthesize a conservative one from the current
 * version's major:
 *
 * - `>= 1.0.0`: stay within the current major — `>=current <(major+1).0.0`.
 *   A `1.14.5` dep tracks the `1.x` line but never reaches `2.0.0`.
 * - `< 1.0.0`: a pre-stable dep may advance across `0.x` releases and adopt the
 *   first stable major (`1.x`), but never crosses two majors in one step —
 *   `>=current <2.0.0`. So `0.14.5` resolves to the latest `1.x` when one
 *   exists, otherwise the latest `0.x`.
 *
 * @param version - The current bare version (no operator, no integrity hash).
 * @returns A semver range string, or `null` when `version` has no numeric major.
 */
export const configDepUpgradeRange = (version: string): string | null => {
	const match = /^(\d+)\./.exec(version);
	if (!match) return null;
	const major = Number(match[1]);
	const ceiling = major === 0 ? 2 : major + 1;
	return `>=${version} <${ceiling}.0.0`;
};

/**
 * Pick the semver range `RegularDeps` should resolve a specifier within.
 *
 * A caret on a `0.x` version (`^0.y.z`) is widened to the config-dep range
 * (`>=version <2.0.0`) so a pre-stable dependency can roll forward across `0.x`
 * and adopt the first stable major, instead of being trapped in `0.y.x` by
 * caret-on-zero semantics. Every other operator (tilde, exact, comparator
 * ranges) and every `>= 1.0.0` version resolves within the literal specifier,
 * exactly as before. Falls back to the literal specifier when no conservative
 * range can be synthesized (a version with no numeric major).
 *
 * @param prefix - The parsed operator (`^`, `~`, `>=`, `<`, or `""`).
 * @param version - The bare version (no operator, no integrity hash).
 * @returns The range string to resolve within.
 */
export const resolutionRangeForSpecifier = (prefix: string, version: string): string => {
	if (prefix === "^" && /^0\./.test(version)) {
		const widened = configDepUpgradeRange(version);
		if (widened) return widened;
	}
	return `${prefix}${version}`;
};
