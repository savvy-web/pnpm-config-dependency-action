/**
 * Step: validate the source and target refs, then create-or-reset the update
 * branch.
 *
 * Validation runs **first**, before any destructive operation: a typo'd
 * `source-branch` must abort before `GitBranch.upsert` force-resets anything.
 *
 * **Failure posture: fail-the-job.** Both failure modes are fatal by design —
 * `InvalidInputError` for a missing ref (the run cannot proceed against a
 * branch that does not exist) and `GitHubError` for an API rejection (a branch
 * that could not be reset means the run would push onto stale state).
 *
 * @module steps/branch
 */

import type { GitCommandError, NotARepositoryError, UnknownRefError } from "@effected/git";
import type { GitHubError, Repo } from "@effected/github";
import { Effect } from "effect";
import type { InvalidInputError } from "../errors/errors.js";
import type { BranchResult } from "../schema/domain.js";
import { BranchManager } from "../services/branch.js";

/**
 * Every failure this step can raise.
 *
 * The two command errors come from `BranchManager`'s local-git half (the fetch
 * and checkout after the API upsert); the other two from the API half and the
 * ref preflight.
 */
/**
 * `BranchManager`'s local git operations now fail with `@effected/git`'s typed
 * errors rather than raw command errors — the module moved off `Run` entirely.
 */
export type BranchStepError = GitHubError | InvalidInputError | GitCommandError | NotARepositoryError | UnknownRefError;

/**
 * Validate both refs and bring the update branch to the source SHA.
 *
 * Returns what `GitBranch.upsert` reported — whether the branch was created or
 * force-reset, and the ref it was cut from.
 */
export const branchStep = (
	branchName: string,
	sourceBranch: string,
	targetBranch: string,
	workspaceRoot: string,
): Effect.Effect<BranchResult, BranchStepError, BranchManager | Repo> =>
	Effect.gen(function* () {
		const branchManager = yield* BranchManager;

		// Validate refs before any destructive branch operation, then manage branch.
		yield* branchManager.validateBranches(sourceBranch, targetBranch);
		const branchResult = yield* branchManager.manage(branchName, workspaceRoot, sourceBranch);

		yield* Effect.logInfo(
			`Step: branch — ${branchResult.branch} ${
				branchResult.created ? "created" : "exists, reset"
			} from ${branchResult.baseRef}`,
		);

		return branchResult;
	});
