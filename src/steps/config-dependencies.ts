/**
 * Step: update config dependencies, dispatching on the detected package manager.
 *
 * This is the action's reason to exist, and the three branches are genuinely
 * different workflows rather than three spellings of one:
 *
 * - **pnpm** — config dependencies are a first-class concept. `ConfigDeps` edits
 *   `pnpm-workspace.yaml` in place.
 * - **bun** — no such concept, so `CatalogConfigDeps` reproduces the workflow by
 *   merging the dependency's `catalogs` export into `package.json`. bun's path
 *   owns the manifest range itself, which is why the names it handles are
 *   excluded from the regular-dependencies pass.
 * - **npm** — no `catalog:` protocol at all, so there is nothing to reproduce.
 *   Skipped with a warning naming how many were requested, because silently
 *   ignoring configured input is the failure this log contract exists to prevent.
 *
 * **Failure posture: fail-the-job.** Both service calls propagate. A
 * config-dependency update that half-applied and was swallowed would leave the
 * manifest and the lockfile disagreeing.
 *
 * @module steps/config-dependencies
 */

import { Effect } from "effect";
import type { FileSystemError } from "../errors/errors.js";
import { formatCatalogCounts, groupCatalogDeltas } from "../format.js";
import type { CatalogDelta, DependencyUpdateResult } from "../schema/domain.js";
import { CatalogConfigDeps } from "../services/catalog-config-deps.js";
import { ConfigDeps } from "../services/config-deps.js";
import type { SupportedPm } from "../services/package-manager.js";
import { readWorkspaceYaml } from "../services/workspace-yaml.js";
import { matchesPattern } from "../utils/deps.js";

/**
 * What the config-dependency step produced.
 *
 * `deltas` is non-empty only on the bun path — on a plugin bump that table is
 * the actual payload of the run, which is why it is carried to the PR body
 * rather than logged and dropped.
 */
export interface ConfigDependenciesResult {
	readonly updates: ReadonlyArray<DependencyUpdateResult>;
	readonly deltas: ReadonlyArray<CatalogDelta>;
}

/**
 * Update the configured config dependencies for `pm`.
 *
 * `dependencyPatterns` is the `dependencies` input, needed only by the bun
 * branch to report which names it is taking ownership of.
 */
export const configDependenciesStep = (
	configDependencies: ReadonlyArray<string>,
	dependencyPatterns: ReadonlyArray<string>,
	pm: SupportedPm,
	workspaceRoot: string,
): Effect.Effect<ConfigDependenciesResult, FileSystemError, ConfigDeps | CatalogConfigDeps> =>
	Effect.gen(function* () {
		if (configDependencies.length === 0) {
			yield* Effect.logInfo("Step: config dependencies — SKIPPED: no config-dependencies configured");
			return { updates: [], deltas: [] };
		}

		switch (pm) {
			case "pnpm": {
				yield* Effect.logInfo("Step: config dependencies — pnpm mode (pnpm-workspace.yaml)");
				// The "before" snapshot is debug evidence for what this branch is about
				// to rewrite. It lives here rather than in `program.ts` because it is a
				// disk read about THIS step's file: composition should not be reaching
				// for `pnpm-workspace.yaml` on behalf of a step, least of all on a run
				// where the detected manager has no such file.
				const workspaceBefore = yield* readWorkspaceYaml(workspaceRoot).pipe(Effect.catch(() => Effect.succeed(null)));
				yield* Effect.logDebug(`pnpm-workspace.yaml (before): ${JSON.stringify(workspaceBefore)}`);

				const configDepsService = yield* ConfigDeps;
				const updates = yield* configDepsService.updateConfigDeps(configDependencies, workspaceRoot);
				for (const u of updates) {
					yield* Effect.logInfo(`  ${u.dependency} ${u.from ?? "added"} -> ${u.to}`);
				}
				return { updates, deltas: [] };
			}
			case "bun": {
				yield* Effect.logInfo("Step: config dependencies — compat catalog mode (bun; catalogs live in package.json)");
				// bun owns the package.json range for a config dependency itself
				// (CatalogConfigDeps bumps it below), so a `dependencies` glob that also
				// matches it must not bump it a second time in the regular-deps pass.
				const ownedByConfig = configDependencies.filter((name) =>
					dependencyPatterns.some((pattern) => matchesPattern(name, pattern)),
				);
				for (const name of ownedByConfig) {
					yield* Effect.logInfo(`  ${name} SKIPPED: owned by config-dependencies`);
				}
				const catalogConfigDeps = yield* CatalogConfigDeps;
				const catalogResult = yield* catalogConfigDeps.update(configDependencies, workspaceRoot);
				for (const u of catalogResult.updates) {
					yield* Effect.logInfo(`  ${u.dependency} ${u.from ?? "added"} -> ${u.to}`);
				}
				for (const [catalog, counts] of groupCatalogDeltas(catalogResult.deltas)) {
					yield* Effect.logInfo(`  catalog "${catalog}": ${formatCatalogCounts(counts)}`);
				}
				return { updates: catalogResult.updates, deltas: catalogResult.deltas };
			}
			case "npm": {
				yield* Effect.logWarning(
					`Skipping ${configDependencies.length} config dependencies: npm does not implement the catalog: protocol. ` +
						"Config dependencies are supported for pnpm (pnpm-workspace.yaml) and bun (package.json catalogs).",
				);
				yield* Effect.logInfo(
					`Step: config dependencies — SKIPPED: npm has no catalog: protocol (${configDependencies.length} requested)`,
				);
				return { updates: [], deltas: [] };
			}
		}
	});
