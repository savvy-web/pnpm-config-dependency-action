/**
 * The peer-gate decision: pure, service-free, and deliberately outside the step.
 *
 * Kept here rather than inside `steps/peer-check.ts` because the interesting
 * arms are the ones with **zero** required rows that are still not a pass. Those
 * need a table-driven test, and sealing them in a step body would mean a
 * lockfile, a layer and a subprocess per case.
 *
 * `@effected/workspaces` states the rule this encodes: *"Both mean fail closed:
 * a gate should treat an unverified report as 'not proven clean' rather than as
 * a pass."* So a report is a pass only when all four conditions hold, and
 * reading `required.length === 0` alone is the silent pass that `supported`,
 * `unresolvedImporters` and `unverified` exist to prevent.
 *
 * @module utils/peers
 */

import type { CheckPeersMode } from "../schema/inputs.js";

/**
 * The parts of a `PeerCheck` report the gate reads.
 *
 * A local shape rather than the kit's class, so the decision can be tested
 * against literals and does not drag `@effected/workspaces` into a pure module.
 */
export interface PeerReportSummary {
	readonly supported: boolean;
	readonly unresolvedImporters: ReadonlyArray<string>;
	readonly unverified: ReadonlyArray<string>;
	readonly requiredCount: number;
}

/** Why the gate decided what it decided. Drives the log line, so it is a union rather than prose. */
export type PeerGateReason =
	| "disabled"
	| "auto-merge-disabled"
	| "report-only"
	| "proven-clean"
	| "unsupported"
	| "unresolved-importers"
	| "unverified"
	| "required-unsatisfied";

/** The gate's decision plus the reason to log. */
export interface PeerGateDecision {
	readonly withhold: boolean;
	readonly reason: PeerGateReason;
}

/**
 * Decide whether this run withholds auto-merge.
 *
 * Reason order is most-specific-first and is load-bearing for the log rather
 * than for the boolean: an unsupported format is *why* there are no rows, so
 * reporting `unverified` there would send a reader to the wrong explanation.
 */
export const decidePeerGate = (
	mode: CheckPeersMode,
	report: PeerReportSummary,
	autoMergeEnabled: boolean,
): PeerGateDecision => {
	if (mode === "false") return { withhold: false, reason: "disabled" };
	if (mode === "warn") return { withhold: false, reason: "report-only" };
	// Nothing can be withheld that was never going to happen. Without this the
	// PR body told reviewers "auto-merge was withheld" on repositories that had
	// never enabled it — a decision reported as taken that was not available to
	// take. Peers are still reported; only the gate is inapplicable.
	if (!autoMergeEnabled) return { withhold: false, reason: "auto-merge-disabled" };

	if (!report.supported) return { withhold: true, reason: "unsupported" };
	if (report.unresolvedImporters.length > 0) return { withhold: true, reason: "unresolved-importers" };
	if (report.unverified.length > 0) return { withhold: true, reason: "unverified" };
	if (report.requiredCount > 0) return { withhold: true, reason: "required-unsatisfied" };

	return { withhold: false, reason: "proven-clean" };
};
