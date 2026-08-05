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
 * The boundary with `services/report.ts`: this module renders the *run's* own
 * output (logs and the decision record), `Report` renders the *PR's* output (body,
 * summary, commit message) over `GitHubMarkdown`. Both are rendering, but they
 * have different sinks and different lifetimes, so they are not merged.
 *
 * Pure and service-free — every function takes data and returns a string, so
 * every line here is testable without a runtime.
 *
 * @module format
 */

import { existsSync, readFileSync } from "node:fs";
import type { CatalogDelta } from "./schema/domain.js";
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
