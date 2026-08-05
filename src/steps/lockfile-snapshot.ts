/**
 * Step: read and parse the detected package manager's lockfile.
 *
 * Runs twice per run — once before any mutation and once after the install — so
 * `compareLockfiles` can report what actually moved. A missing lockfile is a
 * logged skip returning `null`, not a failure: a first install legitimately has
 * none.
 *
 * **Failure posture: fail-the-job.** `LockfileError` propagates uncaught, which
 * is the behavior this step was extracted from. (An argument exists that a
 * snapshot is diagnostic and should degrade to `null` — `git status` is the
 * run's real change signal — but changing that here would make a
 * behavior-preserving move not behavior-preserving. Noted, not acted on.)
 *
 * @module steps/lockfile-snapshot
 */

import type { Lockfile as LockfileModel } from "@effected/lockfiles";
import { Effect } from "effect";
import type { LockfileError } from "../errors/errors.js";
import { LOCKFILE_NAMES, captureLockfileState } from "../services/lockfile.js";
import type { SupportedPm } from "../services/package-manager.js";

/** Which side of the run a snapshot was taken on — shapes the log line only. */
export type SnapshotPhase = "before" | "after";

/** The parsed lockfile, or `null` when there is none to read. */
export type LockfileSnapshotResult = LockfileModel | null;

/**
 * Capture one lockfile snapshot, logging what was read or why it was skipped.
 *
 * `phase` only shapes the log line; the read itself is identical on both sides.
 */
export const lockfileSnapshotStep = (
	phase: SnapshotPhase,
	pm: SupportedPm,
	workspaceRoot: string,
): Effect.Effect<LockfileSnapshotResult, LockfileError> =>
	Effect.gen(function* () {
		const lockfileName = LOCKFILE_NAMES[pm];
		const snapshot = yield* captureLockfileState(pm, workspaceRoot);

		if (snapshot) {
			yield* Effect.logInfo(
				`Step: lockfile snapshot (${phase}) — read ${lockfileName} (${snapshot.packages.length} packages)`,
			);
		} else {
			yield* Effect.logInfo(
				`Step: lockfile snapshot (${phase}) — SKIPPED: no ${lockfileName} found${
					phase === "before" ? " (first install)" : ""
				}`,
			);
		}

		yield* Effect.logDebug(
			`Lockfile state (${phase}): ${JSON.stringify({
				packages: snapshot?.packages.length ?? 0,
				importers: snapshot?.importers.length ?? 0,
			})}`,
		);

		return snapshot;
	});
