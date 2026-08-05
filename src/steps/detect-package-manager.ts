/**
 * Step: resolve the workspace root and package manager, once, for the whole run.
 *
 * Every later dispatch point — config dependencies, install, the package-manager
 * upgrade, workspace formatting — reads this one value, and every later step
 * reads and writes at `detected.root` rather than the process cwd. Those are not
 * the same directory: the action can legitimately be invoked from a
 * subdirectory of the workspace.
 *
 * **Failure posture: fail-the-job.** An unsupported workspace (yarn, or no
 * workspace root at all) cannot be worked around, and this step runs inside the
 * check run so the rejection is visible in the GitHub UI rather than being an
 * invisible early exit.
 *
 * @module steps/detect-package-manager
 */

import type { PackageManagerDetector, WorkspaceRoot } from "@effected/workspaces";
import { WorkspaceDiscovery } from "@effected/workspaces";
import { Effect } from "effect";
import type { InvalidInputError } from "../errors/errors.js";
import { describePmEvidence } from "../format.js";
import type { DetectedPm } from "../services/package-manager.js";
import { detectPackageManager } from "../services/package-manager.js";

/**
 * What the detect step resolved, plus the two enrichments the run-context block
 * needs.
 *
 * `evidence` is best-effort and explicitly **not** a source of truth — see
 * `describePmEvidence`. `packageCount` is `null` when discovery failed, which is
 * never fatal: it only enriches a log line.
 */
export interface DetectPackageManagerResult {
	readonly detected: DetectedPm;
	readonly evidence: string | null;
	readonly packageCount: number | null;
}

/**
 * Detect the package manager and gather the run-context enrichments.
 *
 * Fails only with `InvalidInputError`, from `detectPackageManager` — the
 * workspace-discovery lookup is caught and degraded to `null` because a missing
 * package count must not abort a run.
 */
export const detectPackageManagerStep = (): Effect.Effect<
	DetectPackageManagerResult,
	InvalidInputError,
	PackageManagerDetector | WorkspaceRoot | WorkspaceDiscovery
> =>
	Effect.gen(function* () {
		const detected = yield* detectPackageManager();
		const evidence = describePmEvidence(detected);

		// Cheap, already-provided lookup used only to enrich the Run context line
		// with a package count — never fails the run.
		const discovery = yield* WorkspaceDiscovery;
		const packageCount = yield* discovery.listPackages().pipe(
			Effect.map((pkgs) => pkgs.length),
			Effect.catch(() => Effect.succeed(null)),
		);

		return { detected, evidence, packageCount };
	});
