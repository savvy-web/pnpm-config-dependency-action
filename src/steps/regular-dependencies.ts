/**
 * Step: update regular dependencies across every workspace manifest.
 *
 * Resolves the highest published version **satisfying each specifier treated as
 * a range**, then re-applies the operator verbatim — never npm's absolute
 * `latest`. That policy lives in `RegularDeps`; what lives here is the exclusion
 * decision below.
 *
 * **Failure posture: fail-the-job.** `RegularDeps` already degrades a
 * per-dependency registry failure to an empty version list internally, so
 * anything reaching this error channel is a genuine write failure.
 *
 * @module steps/regular-dependencies
 */

import { Effect } from "effect";
import type { DependencyUpdateResult } from "../schema/domain.js";
import type { SupportedPm } from "../services/package-manager.js";
import { RegularDeps } from "../services/regular-deps.js";

/** The regular-dependency bumps this step applied. */
export interface RegularDependenciesResult {
	readonly updates: ReadonlyArray<DependencyUpdateResult>;
}

/**
 * Update every dependency matching `patterns`.
 *
 * `configDependencies` is excluded **only under bun**, and the asymmetry is
 * deliberate: bun's config-dep path owns the package.json range and bumps it
 * itself, so a `dependencies` glob matching the same name would bump it twice
 * and race the same manifest write. Under pnpm the config deps live in
 * `pnpm-workspace.yaml` and `ConfigDeps` never touches package.json; under npm
 * they are skipped entirely, and excluding them there would freeze the
 * package.json range of a package that is both a config dependency and a
 * devDependency, forever.
 */
export const regularDependenciesStep = (
	patterns: ReadonlyArray<string>,
	configDependencies: ReadonlyArray<string>,
	pm: SupportedPm,
	workspaceRoot: string,
): Effect.Effect<RegularDependenciesResult, never, RegularDeps> =>
	Effect.gen(function* () {
		if (patterns.length === 0) {
			yield* Effect.logInfo("Step: regular dependencies — SKIPPED: no dependencies patterns configured");
			return { updates: [] };
		}

		yield* Effect.logInfo(`Step: regular dependencies — patterns ${patterns.join(", ")}`);
		const regularDepsService = yield* RegularDeps;
		const updates = yield* regularDepsService.updateRegularDeps(
			patterns,
			workspaceRoot,
			pm === "bun" ? new Set(configDependencies) : undefined,
		);
		for (const u of updates) {
			yield* Effect.logInfo(`  ${u.dependency} ${u.from ?? "added"} -> ${u.to}`);
		}

		return { updates };
	});
