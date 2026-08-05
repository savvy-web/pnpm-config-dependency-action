/**
 * Step: upgrade the **detected** package manager (pnpm, bun or npm) in place.
 *
 * Driven by the `upgrade-package-manager` input: `false` (the default — opt-in,
 * matching the `upgrade-runtime-*` inputs), `true`, `auto`, or an explicit
 * semver range.
 *
 * **Failure posture: degrade-to-warning.** A read/write failure is caught here,
 * logged, and folded into an `error`-kind outcome, so the error channel is
 * `never` — truthfully. A package-manager bump is not worth aborting a run whose
 * dependency updates are otherwise fine.
 *
 * **The `unsatisfiable` outcome is the one non-benign skip and logs at warning.**
 * It means nothing in *this* manager's release list satisfies the configured
 * range, which is overwhelmingly a range typed for a different manager (a pnpm
 * `^11.0.0` copy-pasted into a bun repo). It must not scroll past at the same
 * level as "disabled" or "already current".
 *
 * @module steps/upgrade-package-manager
 */

import { Effect } from "effect";
import type { DependencyUpdateResult } from "../schema/domain.js";
import type { SupportedPm } from "../services/package-manager.js";
import type { PackageManagerUpgradeOutcome } from "../services/package-manager-upgrade.js";
import { PackageManagerUpgrade } from "../services/package-manager-upgrade.js";

/**
 * What the package-manager step produced.
 *
 * `updates` carries at most one entry (the manager's own bump, typed `config`)
 * and feeds the PR/commit/summary. `skipReason` is `null` when the step applied
 * an upgrade, and otherwise the outcome's own prose — it reaches the closing
 * Result block, so it is a reported value rather than a log-only string.
 */
export interface UpgradePackageManagerResult {
	readonly updates: ReadonlyArray<DependencyUpdateResult>;
	readonly skipReason: string | null;
}

/** Render the reference/range prefix both the applied and skipped branches log. */
const describeReference = (outcome: PackageManagerUpgradeOutcome): string => {
	const refPart =
		outcome.reference !== null
			? `reference ${outcome.reference}${
					outcome.referenceSource
						? ` (${outcome.referenceSource === "devEngines" ? "devEngines.packageManager" : "packageManager"})`
						: ""
				}`
			: "reference none found";
	const rangePart = outcome.targetRange !== null ? ` · range "${outcome.targetRange}"` : "";
	return `${refPart}${rangePart}`;
};

/**
 * Upgrade the detected package manager, or explain why it was skipped.
 *
 * `mode` is the raw `upgrade-package-manager` input value.
 */
export const upgradePackageManagerStep = (
	mode: string,
	pm: SupportedPm,
	workspaceRoot: string,
): Effect.Effect<UpgradePackageManagerResult, never, PackageManagerUpgrade> =>
	Effect.gen(function* () {
		if (mode === "false") {
			const skipReason = "disabled (upgrade-package-manager: false)";
			yield* Effect.logInfo(`Step: package manager — SKIPPED: ${skipReason}`);
			return { updates: [], skipReason };
		}

		yield* Effect.logInfo(`Step: package manager — upgrade-package-manager "${mode}" applies to ${pm}`);

		const service = yield* PackageManagerUpgrade;
		const outcome: PackageManagerUpgradeOutcome = yield* service.upgrade(mode, pm, workspaceRoot).pipe(
			Effect.catch((error) =>
				Effect.gen(function* () {
					yield* Effect.logWarning(`Failed to upgrade ${pm}: ${error.reason}`);
					const fallback: PackageManagerUpgradeOutcome = {
						applied: false,
						pm,
						reference: null,
						referenceSource: null,
						targetRange: null,
						kind: "error",
						reason: `read/write error: ${error.reason}`,
					};
					return fallback;
				}),
			),
		);

		const reference = describeReference(outcome);

		if (outcome.applied) {
			yield* Effect.logInfo(`  ${reference} → resolved ${outcome.to}`);
			yield* Effect.logInfo(`  ${pm}: ${outcome.from ?? "added"} -> ${outcome.to}`);
			return {
				updates: [{ dependency: pm, from: outcome.from, to: outcome.to, type: "config", package: null }],
				skipReason: null,
			};
		}

		if (outcome.kind === "unsatisfiable") {
			// The acceptance signal — see the module note.
			yield* Effect.logWarning(`  ${reference} → no upgrade`);
			yield* Effect.logWarning(
				`  SKIPPED: no ${outcome.pm} release satisfies the range "${outcome.targetRange}" — this ` +
					`workspace uses ${outcome.pm}, so check that the upgrade-package-manager range is a ` +
					`${outcome.pm} range`,
			);
			return { updates: [], skipReason: outcome.reason };
		}

		yield* Effect.logInfo(`  ${reference} → no upgrade`);
		yield* Effect.logInfo(`  SKIPPED: ${outcome.reason}`);
		return { updates: [], skipReason: outcome.reason };
	});
