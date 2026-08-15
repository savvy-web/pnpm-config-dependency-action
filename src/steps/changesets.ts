/**
 * Step: regenerate the dependency changeset from the cumulative diff.
 *
 * Delegates entirely to silk's `DepsRegen` via the local `Changesets` adapter:
 * the diff is `merge-base(target-branch) → worktree`, and the consolidation and
 * versionable-minus-ignored gating live upstream. The per-run update records are
 * **not** inputs to this step — it derives its content from git.
 *
 * **Failure posture: fail-the-job.** A `ChangesetError` means the changeset the
 * release depends on was not written, which must not pass silently.
 *
 * @module steps/changesets
 */

import type { GitCommandError, NotARepositoryError, UnknownRefError } from "@effected/git";
import { Effect } from "effect";
import type { ChangesetError } from "../errors/errors.js";
import type { ChangesetFile } from "../schema/domain.js";
import { BranchManager } from "../services/branch.js";
import { Changesets, hasChangesets } from "../services/changesets.js";

/**
 * The changesets written, plus why the step was skipped when it was.
 *
 * `skipReason` is `null` when the step ran; it reaches the closing Result block,
 * so it is a reported value rather than a log-only string.
 */
export interface ChangesetsStepResult {
	readonly files: ReadonlyArray<ChangesetFile>;
	readonly skipReason: string | null;
}

/** Regenerate changesets, or explain why not. */
export const changesetsStep = (
	enabled: boolean,
	targetBranch: string,
	workspaceRoot: string,
): Effect.Effect<
	ChangesetsStepResult,
	ChangesetError | GitCommandError | NotARepositoryError | UnknownRefError,
	Changesets | BranchManager
> =>
	Effect.gen(function* () {
		if (!enabled) {
			const skipReason = "disabled (changesets: false)";
			yield* Effect.logInfo(`Step: changesets — SKIPPED: ${skipReason}`);
			return { files: [], skipReason };
		}

		if (!hasChangesets(workspaceRoot)) {
			const skipReason = "no .changeset/ directory";
			yield* Effect.logInfo(`Step: changesets — SKIPPED: ${skipReason}`);
			return { files: [], skipReason };
		}

		yield* Effect.logInfo(`Step: changesets — regenerating from merge-base(${targetBranch}) -> worktree diff`);

		// DepsRegen diffs against merge-base(target-branch); make sure that history
		// is available locally before it runs (no-op on a fetch-depth: 0 checkout).
		const branchManager = yield* BranchManager;
		yield* branchManager.ensureBaseHistory(targetBranch, workspaceRoot);

		const changesetsService = yield* Changesets;
		const files = yield* changesetsService.create(workspaceRoot, targetBranch);
		yield* Effect.logInfo(`  wrote ${files.length} changeset(s)`);

		return { files, skipReason: null };
	});
