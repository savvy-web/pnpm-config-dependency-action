/**
 * Semver resolution utilities.
 *
 * Extracted from `src/lib/pnpm/upgrade.ts`. Uses `SemverResolver` from
 * `@savvy-web/github-action-effects` (a namespace of static functions,
 * not an Effect service).
 *
 * @module utils/semver
 */

import { SemverResolver } from "@savvy-web/github-action-effects";
import { Effect } from "effect";

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
): Effect.Effect<string | null, never, never> =>
	Effect.gen(function* () {
		// Filter out pre-release versions
		const stableVersions: string[] = [];
		for (const v of versions) {
			const parsed = yield* SemverResolver.parse(v).pipe(Effect.option);
			if (parsed._tag === "Some" && !parsed.value.prerelease) {
				stableVersions.push(v);
			}
		}

		if (stableVersions.length === 0) return null;

		const result = yield* SemverResolver.latestInRange(stableVersions, `^${current}`).pipe(
			Effect.catchAll(() => Effect.succeed(null as string | null)),
		);
		return result;
	});
