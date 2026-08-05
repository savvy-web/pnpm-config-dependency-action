/**
 * Changesets service — a thin adapter over `@savvy-web/silk-effects`'
 * `Changesets.DepsRegen`, which is the source of truth for dependency
 * changesets.
 *
 * DepsRegen recomputes the cumulative dependency diff from
 * `merge-base(base) → working tree` (catalog-/workspace-aware), writes **one**
 * consolidated `## Dependencies` changeset per in-scope package, and deletes
 * every stale *pure-dependency* changeset it finds — so re-firing the action
 * against an accumulation of pure-dep changesets converges to a single current
 * table per package instead of piling up duplicates. Mixed changesets
 * (Dependencies table + prose) are detected and left untouched.
 *
 * Gating (versionable-minus-ignored: publishable OR `privatePackages.version`,
 * minus the changeset `ignore` list) lives upstream in DepsRegen — this action
 * no longer carries its own predicate. Content comes from the git diff, so the
 * per-run `lockfileChanges`/`regularUpdates`/`peerUpdates` are no longer inputs
 * to the changeset step; they continue to drive the PR/commit/summary reporting
 * pipeline in `program.ts`.
 *
 * @module services/changesets
 */

import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { Changesets as SilkChangesets } from "@savvy-web/silk-effects";
import { Context, Effect, Layer } from "effect";

import { ChangesetError } from "../errors/errors.js";
import type { ChangesetFile } from "../schema/domain.js";

// ══════════════════════════════════════════════════════════════════════════════
// Service Interface
// ══════════════════════════════════════════════════════════════════════════════

export class Changesets extends Context.Service<
	Changesets,
	{
		/**
		 * Regenerate dependency changesets for the workspace.
		 *
		 * @param workspaceRoot - Project root containing `.changeset/`.
		 * @param base - Base branch for the `merge-base(base) → worktree` diff
		 *   window (the resolved `target-branch`, i.e. the release baseline). A
		 *   window anchored at the release baseline spans every unreleased change,
		 *   which is what makes consolidation correct rather than trimming.
		 */
		readonly create: (
			workspaceRoot: string,
			base: string,
		) => Effect.Effect<ReadonlyArray<ChangesetFile>, ChangesetError>;
	}
>()("Changesets") {
	/**
	 * Live layer.
	 *
	 * Declared IN the class body, which is load-bearing rather than stylistic: a
	 * member attached by post-class assignment is tree-shaken out of the bundled
	 * `dist`, and that fails only in production because vitest runs the source.
	 */
	static readonly layer = Layer.effect(
		this,
		Effect.gen(function* () {
			const depsRegen = yield* SilkChangesets.DepsRegen;
			return {
				create: (workspaceRoot, base) => createChangesetsImpl(workspaceRoot, base, depsRegen),
			};
		}),
	);
}

// ══════════════════════════════════════════════════════════════════════════════
// Module-Level Exports
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Check if the repository uses changesets.
 */
export const hasChangesets = (workspaceRoot: string): boolean => existsSync(join(workspaceRoot, ".changeset"));

// ══════════════════════════════════════════════════════════════════════════════
// Live Layer
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
// Implementation
// ══════════════════════════════════════════════════════════════════════════════

const createChangesetsImpl = (
	workspaceRoot: string,
	base: string,
	depsRegen: SilkChangesets.DepsRegenShape,
): Effect.Effect<ReadonlyArray<ChangesetFile>, ChangesetError> =>
	Effect.gen(function* () {
		if (!hasChangesets(workspaceRoot)) {
			yield* Effect.logInfo("Repository does not use changesets, skipping changeset creation");
			return [];
		}

		// plan() is side-effect-free; execute() writes fresh changesets first, then
		// deletes stale pure-dep ones (crash-safe, idempotent across re-fires).
		const plan = yield* depsRegen.plan({ cwd: workspaceRoot, base });
		const result = yield* depsRegen.execute(plan);

		// Map the written files back to ChangesetFile records for reporting. The
		// diff lives on plan.toWrite (execute writes exactly those files), so we
		// reconstruct each table for the PR body/summary without re-reading disk.
		const byFile = new Map(plan.toWrite.map((entry) => [entry.file, entry] as const));
		const written: ChangesetFile[] = [];
		for (const file of result.written) {
			const entry = byFile.get(file);
			if (!entry) continue;
			const table = SilkChangesets.serializeDependencyTableToMarkdown([...entry.diff.rows]);
			written.push({
				id: basename(file).replace(/\.md$/, ""),
				packages: [entry.package],
				type: "patch",
				summary: `## Dependencies\n\n${table}`,
			});
		}

		yield* Effect.logInfo(
			`DepsRegen: wrote ${result.written.length} changeset(s), deleted ${result.deleted.length} stale, ` +
				`skipped ${result.skippedMixed.length} mixed`,
		);
		return written;
	}).pipe(
		// DepsRegen surfaces GitError | WorkspaceDiscoveryError | ChangesetIOError |
		// PointInTimeReadError. A failure here (e.g. the base ref is not fetched so
		// merge-base cannot be computed) is genuinely fatal to the changeset step —
		// collapse it into the action's ChangesetError with a descriptive reason
		// rather than swallowing it.
		Effect.mapError((error) => new ChangesetError({ reason: `changeset regeneration failed: ${String(error)}` })),
	);
