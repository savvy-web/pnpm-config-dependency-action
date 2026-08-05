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

import { existsSync, readFileSync } from "node:fs";
import type { CatalogDelta, DependencyUpdateResult } from "./schema/domain.js";
import type { DetectedPm, SupportedPm } from "./services/package-manager.js";

// ══════════════════════════════════════════════════════════════════════════════
// Package-manager evidence
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Best-effort re-derivation of which signal `PackageManagerDetector` most likely
 * used to settle on `detected.pm`, for the Run-context log line only.
 *
 * `DetectedPm` does not carry this itself — the upstream detector logs its
 * decision internally (at debug level, and only on the devEngines branch) but
 * does not return it. This function is therefore **not a source of truth**: it is
 * a cheap re-check of the same signals in the same priority order
 * (`devEngines.packageManager`, then `pnpm-workspace.yaml` / `bun.lock` / a
 * `package.json` workspaces field). Any read failure degrades to `null` — it
 * never invents an answer.
 */
export const describePmEvidence = (detected: DetectedPm): string | null => {
	try {
		const raw = readFileSync(`${detected.root}/package.json`, "utf-8");
		const pkg = JSON.parse(raw) as { devEngines?: { packageManager?: unknown }; workspaces?: unknown };
		const rawEntry = pkg.devEngines?.packageManager;
		const entry = Array.isArray(rawEntry) ? rawEntry[0] : rawEntry;
		if (entry && typeof entry === "object" && (entry as { name?: unknown }).name === detected.pm) {
			return "devEngines.packageManager.name";
		}
		if (detected.pm === "npm" && "workspaces" in pkg && pkg.workspaces != null) {
			return "package.json workspaces field";
		}
	} catch {
		// Best-effort only — fall through to the lockfile/config-file checks.
	}
	if (detected.pm === "pnpm" && existsSync(`${detected.root}/pnpm-workspace.yaml`)) {
		return "pnpm-workspace.yaml";
	}
	if (detected.pm === "bun" && (existsSync(`${detected.root}/bun.lock`) || existsSync(`${detected.root}/bun.lockb`))) {
		return "bun.lock";
	}
	return null;
};

// ══════════════════════════════════════════════════════════════════════════════
// Install labelling
// ══════════════════════════════════════════════════════════════════════════════

/** The command line `runInstall` runs for a given package manager, for logging only. */
export const INSTALL_LABEL: Record<SupportedPm, string> = {
	pnpm: "pnpm clean --lockfile && pnpm install --frozen-lockfile=false",
	bun: "bun install --force",
	npm: "rm -f package-lock.json && npm install",
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
	readonly evidence: string | null;
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
	`  package manager  ${context.detected.pm}${context.detected.version ? ` ${context.detected.version}` : ""}${
		context.evidence ? `   (${context.evidence})` : ""
	}`,
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

	const skipped: string[] = [];
	if (result.packageManagerSkip !== null) skipped.push(`package-manager upgrade (${result.packageManagerSkip})`);
	if (!result.peerConfigured) skipped.push("peer sync (not configured)");
	if (!result.isPnpm) skipped.push("workspace formatting (not pnpm)");
	if (!result.customCommandsConfigured) skipped.push("custom commands (not configured)");
	if (result.changesetsSkip !== null) skipped.push(`changesets (${result.changesetsSkip})`);
	if (skipped.length > 0) {
		lines.push(`  skipped   ${skipped.join(" · ")}`);
	}

	return lines;
};
