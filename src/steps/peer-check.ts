/**
 * Step: check the installed graph for unsatisfied peer dependencies.
 *
 * Runs against the **"after" lockfile snapshot** — the one this run is about to
 * commit — rather than re-reading disk, so the gate answers a question about
 * the artifact the PR actually carries.
 *
 * **Failure posture: degrade-to-warning, gate fails CLOSED.** The error channel
 * is `never`. Two distinct things can go wrong and they are deliberately not
 * treated alike:
 * - The run must never fail because a peer *report* could not be produced;
 *   dependency updates that already succeeded are not worth a red job.
 * - The gate must never *pass* because a report could not be produced.
 *   `@effected/workspaces` is explicit: both `unverified` reasons mean fail
 *   closed. So a failed rules lookup degrades into an unverified report, and an
 *   unverified report withholds auto-merge.
 *
 * **Why the rules lookup is not optional.** `PeerCheck.run(lockfile)` without
 * `peerDependencyRules` always reports `peerRulesNotApplied`, because pnpm
 * persists resolution-affecting config into the lockfile and discards
 * reporting-affecting config — `peerDependencyRules` appears nowhere in a
 * lockfile. Supplying them is what makes a verdict possible at all, and
 * supplying `NoPeerDependencyRules` is an assertion ("I looked, there are
 * none"), not a default.
 *
 * @module steps/peer-check
 */

import type { Lockfile as LockfileModel } from "@effected/lockfiles";
import { PeerCheck, WorkspaceCatalogs } from "@effected/workspaces";
import { Effect } from "effect";
import type { PeerIssue } from "../schema/domain.js";
import type { CheckPeersMode } from "../schema/inputs.js";
import type { PeerGateDecision } from "../utils/peers.js";
import { decidePeerGate } from "../utils/peers.js";

/** What the peer check found, and what the run should do about it. */
export interface PeerCheckStepResult {
	readonly issues: ReadonlyArray<PeerIssue>;
	/**
	 * How many of `issues` are required (non-optional).
	 *
	 * Returned rather than left for the caller to derive with a filter: the kit
	 * computes it via `report.required`, and a second derivation here would be a
	 * parallel definition of "required" that can drift from the one the gate
	 * actually used.
	 */
	readonly requiredCount: number;
	/**
	 * The specific reasons the report could not be verified, verbatim from
	 * `PeerCheck`.
	 *
	 * Surfaced separately from `decision.reason` because the gate's verdict
	 * (`"unverified"`) is not diagnosable on its own: a real run withheld
	 * auto-merge on a report with ZERO rows, and the log said only
	 * "(unverified)", which reads as "there are peer problems" when it means
	 * "I could not tell". The reader needs the reason, not the verdict.
	 */
	readonly unverifiedReasons: ReadonlyArray<string>;
	readonly decision: PeerGateDecision;
}

/** A report that examined nothing — never a pass, because nothing was proven. */
const NOT_EXAMINED = {
	supported: false,
	unresolvedImporters: [] as ReadonlyArray<string>,
	unverified: ["peerRulesNotApplied"] as ReadonlyArray<string>,
	requiredCount: 0,
} as const;

export const peerCheckStep = (
	mode: CheckPeersMode,
	lockfile: LockfileModel | null,
	workspaceRoot: string,
	autoMergeEnabled: boolean,
): Effect.Effect<PeerCheckStepResult, never, WorkspaceCatalogs> =>
	Effect.gen(function* () {
		if (mode === "false") {
			yield* Effect.logInfo("Step: peer check — SKIPPED: check-peers is false");
			return {
				issues: [],
				requiredCount: 0,
				unverifiedReasons: NOT_EXAMINED.unverified,
				decision: decidePeerGate(mode, NOT_EXAMINED, autoMergeEnabled),
			};
		}

		if (lockfile === null) {
			yield* Effect.logWarning(
				`Step: peer check — no lockfile snapshot at ${workspaceRoot}; nothing could be examined`,
			);
			return {
				issues: [],
				requiredCount: 0,
				unverifiedReasons: NOT_EXAMINED.unverified,
				decision: decidePeerGate(mode, NOT_EXAMINED, autoMergeEnabled),
			};
		}

		const catalogs = yield* WorkspaceCatalogs;

		// The assembly was memoized BEFORE this run installed: release-age
		// discovery triggered it against the pre-update plugins. This step judges
		// the "after" lockfile, so it must read the after-state rules -- the run
		// may have bumped the very config dependency whose hooks supply them.
		yield* catalogs.refresh();

		// A failed lookup degrades to "omit the option", which PeerCheck reports as
		// `peerRulesNotApplied` -- so the failure lands on the fail-closed path
		// rather than being papered over with an empty rule set, which would be an
		// assertion we have no basis to make.
		const rules = yield* catalogs
			.peerDependencyRules()
			.pipe(
				Effect.catch((error) =>
					Effect.logWarning(
						`Peer suppression rules could not be resolved (${String(error)}); ` +
							"the peer report cannot be verified and will not be treated as clean.",
					).pipe(Effect.as(null)),
				),
			);

		const report = rules === null ? PeerCheck.run(lockfile) : PeerCheck.run(lockfile, { peerDependencyRules: rules });

		const issues: ReadonlyArray<PeerIssue> = report.unsatisfied.map((u) => ({
			importer: u.importer,
			dependency: u.dependency,
			wanted: u.wanted,
			found: u.found,
			optional: u.optional,
			parents: u.parents.map((p) => `${p.name}@${p.version}`),
		}));

		const decision = decidePeerGate(
			mode,
			{
				supported: report.supported,
				unresolvedImporters: report.unresolvedImporters,
				unverified: report.unverified,
				requiredCount: report.required.length,
			},
			autoMergeEnabled,
		);

		// Name the reasons, not just the verdict: "(unverified)" beside "0 issue(s)"
		// reads as a contradiction unless the reader is told what could not be
		// checked.
		const why =
			decision.reason === "unverified" ? `${decision.reason}: ${report.unverified.join(", ")}` : decision.reason;
		yield* Effect.logInfo(
			`Step: peer check — ${issues.length} issue(s), ${report.required.length} required; ` +
				`${decision.withhold ? "withholding auto-merge" : "not gating"} (${why})`,
		);
		for (const issue of issues) {
			yield* Effect.logDebug(
				`  ${issue.importer} :: ${issue.dependency} wanted ${issue.wanted} found ${issue.found ?? "(missing)"}`,
			);
		}

		return { issues, requiredCount: report.required.length, unverifiedReasons: report.unverified, decision };
	});
