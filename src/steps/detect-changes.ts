/**
 * Step: decide whether this run actually changed anything.
 *
 * Two independent signals are combined by the caller: the file-level status
 * result computed here, and the lockfile comparison. Either being non-empty
 * means there is something to commit.
 *
 * **Failure posture: fail-the-job.** A status that cannot run means the working
 * tree is unreadable, and every downstream decision depends on it.
 *
 * @module steps/detect-changes
 */

import type { GitCommandError, NotARepositoryError, UnknownRefError } from "@effected/git";
import { Git } from "@effected/git";
import { Effect } from "effect";

/** The file-level change signal. */
export interface DetectChangesResult {
	/** One entry per changed path; only the count is read today. */
	readonly entries: ReadonlyArray<{ readonly path: string }>;
	readonly hasChanges: boolean;
}

/**
 * Read the working tree's change list at `workspaceRoot`.
 *
 * `workspaceRoot`, not the process cwd: every other step reads and writes at the
 * detected root, and the action can legitimately be invoked from a subdirectory.
 * Running status elsewhere reports a different tree than the one that was
 * modified — the same defect fixed twice before in `commitChanges` and
 * `ensureBaseHistory`.
 *
 * **`core.fileMode=false` is set on the checkout by the caller**, not passed
 * per-command. Executable-bit-only flips (husky chmod-ing hooks during a `run`
 * command, say) do not survive the content-based GitHub API commit at mode
 * 100644, so counting them would produce an empty commit and a spurious PR.
 * `BranchManager.commitChanges` reads status the same way and the two must stay
 * consistent — a divergence would make the run's verdict and the commit's
 * contents disagree.
 */
export const detectChangesStep = (
	workspaceRoot: string,
): Effect.Effect<DetectChangesResult, GitCommandError | NotARepositoryError | UnknownRefError, Git> =>
	Effect.gen(function* () {
		const git = yield* Git;
		const entries = yield* git.status(workspaceRoot);
		const hasChanges = entries.length > 0;
		yield* Effect.logDebug(`Git status has changes: ${hasChanges}`);
		return { entries, hasChanges };
	});
