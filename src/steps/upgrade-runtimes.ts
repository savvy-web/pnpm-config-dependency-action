/**
 * Step: upgrade `devEngines.runtime` entries (node / deno / bun) in the root
 * manifest.
 *
 * Driven by the three `upgrade-runtime-*` inputs, each `false` | `auto` | a
 * semver range. Two invariants live in the service rather than here, and are
 * worth knowing at the call site: it **upgrades only, never adds** an entry the
 * manifest does not already declare, and it always writes the **bare exact**
 * resolved version, because `silk-runtime-action` downstream rejects range
 * operators.
 *
 * **Failure posture: degrade-to-warning.** A resolver failure — including
 * `VersionNotFoundError` for an end-of-life major line — is caught, logged, and
 * yields no updates, so the error channel is `never`. Runtime bumps also never
 * create a changeset and never open the install gate.
 *
 * @module steps/upgrade-runtimes
 */

import { Effect } from "effect";
import type { DependencyUpdateResult } from "../schema/domain.js";
import type { RuntimeUpgradeConfig } from "../services/runtime-upgrade.js";
import { RuntimeUpgrade } from "../services/runtime-upgrade.js";

/** The runtime bumps this step applied, typed `runtime` for reporting. */
export interface UpgradeRuntimesResult {
	readonly updates: ReadonlyArray<DependencyUpdateResult>;
}

/**
 * Upgrade every requested runtime, logging the requested mode for all three
 * even when only one is enabled — the log is a decision record, so "not
 * requested" has to be visible rather than absent.
 */
export const upgradeRuntimesStep = (
	config: RuntimeUpgradeConfig,
	workspaceRoot: string,
): Effect.Effect<UpgradeRuntimesResult, never, RuntimeUpgrade> =>
	Effect.gen(function* () {
		const modeParts = (["node", "deno", "bun"] as const).map(
			(rt) => `${rt}: ${config[rt] === "false" ? "not requested" : `"${config[rt]}"`}`,
		);
		yield* Effect.logInfo(`Step: runtimes — ${modeParts.join(" · ")}`);

		const service = yield* RuntimeUpgrade;
		const results = yield* service.upgrade(config, workspaceRoot).pipe(
			Effect.catch((error) =>
				Effect.gen(function* () {
					yield* Effect.logWarning(`Failed to upgrade runtimes: ${error.reason}`);
					return [] as const;
				}),
			),
		);

		const updates: DependencyUpdateResult[] = [];
		for (const r of results) {
			yield* Effect.logInfo(`  ${r.runtime}: ${r.from} -> ${r.to}`);
			updates.push({ dependency: r.runtime, from: r.from, to: r.to, type: "runtime", package: null });
		}

		return { updates };
	});
