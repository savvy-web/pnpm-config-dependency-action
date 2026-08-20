/**
 * The action's single rendering surface.
 *
 * Every human-readable string the run produces that is not a step's own inline
 * skip reason is built here: the run-context block, the closing result block,
 * and the catalog tallies that appear in both the config-dependency step log and
 * the result block.
 *
 * The rule this module exists to enforce: **the same fact must not be worded two
 * different ways in two different places.** `formatCatalogCounts` and
 * `formatCatalogCountsCompact` are the same tally rendered for two audiences,
 * and they live side by side precisely so that stays visible.
 *
 * ## The boundary with `services/report.ts` — settled, do not re-litigate
 *
 * **`format.ts` renders the run's log output; `report.ts` renders the PR's.**
 * Two named rendering modules, split by sink:
 *
 * | | `format.ts` | `services/report.ts` |
 * | --- | --- | --- |
 * | sink | the runner log / decision record | the PR body, job summary, commit message |
 * | lifetime | written once, scrolls | upserted and re-rendered across runs |
 * | shape | pure functions, no services | a `Context.Service` over `PullRequest` |
 *
 * The single-rendering-surface rule exists to stop rendering being scattered
 * through step bodies — which it is not. Merging these two would drag a service
 * dependency into a pure module, or strand `Report`'s statics. Two named modules
 * with a clear split satisfies the rule rather than violating it.
 *
 * Pure and service-free — every function takes data and returns a string, so
 * every line here is testable without a runtime.
 *
 * @module format
 */

import type { PackageManagerEvidence } from "@effected/workspaces";
import type { CatalogDelta, DependencyUpdateResult } from "./schema/domain.js";
import type { DetectedPm, SupportedPm } from "./services/package-manager.js";
import type { PeerGateReason } from "./utils/peers.js";

// `describePmEvidence` lived here and is deleted. It re-read the manifest and
// re-implemented `PackageManagerDetector`'s priority order to guess which signal
// had decided the package manager, and said in its own docstring that it was not
// a source of truth — it could not reproduce the detector's conjunction rules, so
// a repo with a stray lockfile got a confident wrong evidence string while the
// detector itself had decided correctly. `DetectedPackageManager` carries the
// deciding marker itself from `@effected/workspaces@0.13.0`, so the step now
// forwards `detected.evidence` and there is nothing left to re-derive. Deleting
// it also removed this module's only raw `node:fs` import.

// ══════════════════════════════════════════════════════════════════════════════
// Install labelling
// ══════════════════════════════════════════════════════════════════════════════

/** The command line `runInstall` runs for a given package manager, for logging only. */
export const INSTALL_LABEL: Record<SupportedPm, string> = {
	pnpm: "pnpm clean --lockfile && pnpm install --frozen-lockfile=false",
	bun: "bun install --force",
	// `rmSync`, not a shelled `rm`: `rm` does not exist on a Windows runner. The
	// label names what the code actually does, because a reader comparing this
	// log line against a failure would otherwise be debugging a command the run
	// never issued.
	npm: "unlink package-lock.json && npm install",
};

// ══════════════════════════════════════════════════════════════════════════════
// Catalog tallies
// ══════════════════════════════════════════════════════════════════════════════

/** Per-catalog tally of a config-dependency merge's delta actions. */
export interface CatalogActionCounts {
	added: number;
	updated: number;
	removed: number;
	kept: number;
}

/** Group catalog deltas by catalog name, tallying each action. */
export const groupCatalogDeltas = (deltas: ReadonlyArray<CatalogDelta>): Map<string, CatalogActionCounts> => {
	const byCatalog = new Map<string, CatalogActionCounts>();
	for (const delta of deltas) {
		const counts = byCatalog.get(delta.catalog) ?? { added: 0, updated: 0, removed: 0, kept: 0 };
		counts[delta.action] += 1;
		byCatalog.set(delta.catalog, counts);
	}
	return byCatalog;
};

/** Verbose per-catalog tally, for the config-dependencies step log. */
export const formatCatalogCounts = (counts: CatalogActionCounts): string => {
	const parts: string[] = [];
	if (counts.updated > 0) parts.push(`${counts.updated} updated`);
	if (counts.added > 0) parts.push(`${counts.added} added`);
	if (counts.removed > 0) parts.push(`${counts.removed} removed`);
	if (counts.kept > 0) parts.push(`${counts.kept} kept`);
	return parts.length > 0 ? parts.join(", ") : "no changes";
};

/** Compact +/~/- tally (kept omitted), for the closing Result block. */
export const formatCatalogCountsCompact = (counts: CatalogActionCounts): string => {
	const parts: string[] = [];
	if (counts.added > 0) parts.push(`+${counts.added}`);
	if (counts.updated > 0) parts.push(`~${counts.updated}`);
	if (counts.removed > 0) parts.push(`-${counts.removed}`);
	return parts.length > 0 ? parts.join(" ") : "no changes";
};

// ══════════════════════════════════════════════════════════════════════════════
// The run's decision record
// ══════════════════════════════════════════════════════════════════════════════

/** Everything the opening Run-context block reports. */
export interface RunContext {
	readonly detected: DetectedPm;
	/**
	 * The marker the detector says decided the package manager. Non-nullable:
	 * it is forwarded from `DetectedPm`, which always carries one. It was
	 * `string | null` while this was locally re-derived and could fail to
	 * establish an answer.
	 */
	readonly evidence: PackageManagerEvidence;
	readonly packageCount: number | null;
	readonly lockfileName: string;
	readonly branch: string;
	readonly sourceBranch: string;
	readonly targetBranch: string;
	readonly dryRun: boolean;
	readonly changesets: boolean;
	readonly runtimeData: string;
}

/**
 * The opening Run-context block: what this run was asked to do, before any work.
 *
 * Returned as lines rather than logged here so the module stays pure — the
 * caller logs them in order. The leading `"Run context"` header is included, so
 * the block is emitted as one unit and cannot drift apart.
 *
 * The exact text is part of the log contract `program.inner.test.ts` asserts on;
 * that suite is authoritative over these strings.
 */
export const runContextLines = (context: RunContext): ReadonlyArray<string> => [
	"Run context",
	`  package manager  ${context.detected.pm}${context.detected.version ? ` ${context.detected.version}` : ""}${`   (${context.evidence})`}`,
	`  workspace root   ${context.detected.root}${
		context.packageCount !== null ? ` (${context.packageCount} package${context.packageCount === 1 ? "" : "s"})` : ""
	}`,
	`  lockfile         ${context.lockfileName}`,
	`  branches         update ${context.branch} ← source ${context.sourceBranch} → target ${context.targetBranch}`,
	`  mode             ${context.dryRun ? "dry run" : "live"} · changesets ${
		context.changesets ? "on" : "off"
	} · runtime data ${context.runtimeData}`,
];

/** Everything the closing Result block reports. */
export interface RunResult {
	readonly updates: ReadonlyArray<DependencyUpdateResult>;
	readonly deltas: ReadonlyArray<CatalogDelta>;
	/** Reasons a step gave for not running, in report order; `null` means it ran. */
	readonly packageManagerSkip: string | null;
	readonly peerConfigured: boolean;
	readonly isPnpm: boolean;
	readonly customCommandsConfigured: boolean;
	readonly changesetsSkip: string | null;
	/**
	 * The peer check's outcome, or `null` when it did not run.
	 *
	 * `null` lands in the skipped-summary rather than being omitted: a check
	 * that did not run must say so, because silence reads as "ran and found
	 * nothing" — which is the opposite of what a disabled gate means.
	 */
	readonly peers: PeerRunSummary | null;
}

/** What the closing block says about the peer check, when it ran. */
export interface PeerRunSummary {
	readonly issues: number;
	readonly required: number;
	readonly withheld: boolean;
	readonly reason: PeerGateReason;
}

/**
 * The closing Result block: what changed, and what did not run and why.
 *
 * The skipped-summary is the half that matters — a step that did not run must
 * always say so, and this is where those reasons are collected into one line
 * rather than being scattered through the stream.
 */
export const resultLines = (result: RunResult): ReadonlyArray<string> => {
	const lines: string[] = ["Result"];

	if (result.updates.length > 0) {
		const updateLines = result.updates.map((u) => `${u.dependency} ${u.from ?? "added"} -> ${u.to} (${u.type})`);
		lines.push(`  updated   ${updateLines.join(", ")}`);
	}

	if (result.deltas.length > 0) {
		const catalogLines = Array.from(
			groupCatalogDeltas(result.deltas),
			([catalog, counts]) => `${catalog}: ${formatCatalogCountsCompact(counts)}`,
		);
		lines.push(`  catalogs  ${catalogLines.join(", ")}`);
	}

	// Only when notable. A proven-clean check is already on the info stream from
	// the step itself; repeating it here would be a second rendering of one fact.
	if (result.peers !== null && (result.peers.issues > 0 || result.peers.withheld)) {
		const counts = `${result.peers.issues} issue(s), ${result.peers.required} required`;
		const gate = result.peers.withheld ? ` — auto-merge withheld (${result.peers.reason})` : "";
		lines.push(`  peers     ${counts}${gate}`);
	}

	const skipped: string[] = [];
	if (result.packageManagerSkip !== null) skipped.push(`package-manager upgrade (${result.packageManagerSkip})`);
	if (!result.peerConfigured) skipped.push("peer sync (not configured)");
	if (!result.isPnpm) skipped.push("workspace formatting (not pnpm)");
	if (!result.customCommandsConfigured) skipped.push("custom commands (not configured)");
	if (result.changesetsSkip !== null) skipped.push(`changesets (${result.changesetsSkip})`);
	if (result.peers === null) skipped.push("peer check (check-peers: false)");
	if (skipped.length > 0) {
		lines.push(`  skipped   ${skipped.join(" · ")}`);
	}

	return lines;
};
