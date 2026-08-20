/**
 * Step: commit the working tree via the GitHub API, then open or update the PR.
 *
 * Kept as one module because the two halves share a precondition (not a dry
 * run) and an ordering constraint (the PR must describe a commit that exists).
 * Splitting them would put that constraint in the composition layer where it is
 * easy to reorder by accident.
 *
 * **Failure posture: split, deliberately.**
 * - The **commit** propagates: a failure there means the branch does not carry
 *   the changes, and a PR describing it would be a lie.
 * - The **PR** degrades to a warning and a `null` result. The commit is already
 *   pushed and durable at that point, so failing the run would report a red job
 *   for work that landed; the next run upserts the PR. The log line says
 *   `FAILED (see warning above)` so it is visible rather than silent.
 *
 * @module steps/commit-and-pr
 */

import type { CommandFailedError, CommandOutputError } from "@effected/commands";
import type { GitCommandError, NotARepositoryError, UnknownRefError } from "@effected/git";
import type { GitHubError, Repo } from "@effected/github";
import { Effect } from "effect";
import type {
	CatalogDelta,
	ChangesetFile,
	DependencyUpdateResult,
	PeerIssue,
	PullRequestResult,
} from "../schema/domain.js";
import { BranchManager } from "../services/branch.js";
import { Report } from "../services/report.js";

/** Everything the commit-and-PR step needs, gathered rather than passed loose. */
export interface CommitAndPrParams {
	readonly branch: string;
	readonly targetBranch: string;
	readonly autoMerge: "" | "merge" | "squash" | "rebase";
	readonly updates: ReadonlyArray<DependencyUpdateResult>;
	readonly changesets: ReadonlyArray<ChangesetFile>;
	readonly deltas: ReadonlyArray<CatalogDelta>;
	readonly peerIssues: ReadonlyArray<PeerIssue>;
	readonly changedFileCount: number;
	readonly workspaceRoot: string;
	readonly dryRun: boolean;
}

/** The PR that was opened or updated, or `null` on a dry run or a PR failure. */
export interface CommitAndPrResult {
	readonly pullRequest: PullRequestResult | null;
}

/** Commit the changes and upsert the pull request. */
export const commitAndPrStep = (
	params: CommitAndPrParams,
): Effect.Effect<
	CommitAndPrResult,
	GitHubError | CommandFailedError | CommandOutputError | GitCommandError | NotARepositoryError | UnknownRefError,
	BranchManager | Report | Repo
> =>
	Effect.gen(function* () {
		const branchManager = yield* BranchManager;
		const report = yield* Report;

		// ── commit ───────────────────────────────────────────────────────────
		if (params.dryRun) {
			yield* Effect.logInfo("Step: commit — SKIPPED: dry run");
		} else {
			yield* Effect.logInfo(`Step: commit — ${params.changedFileCount} file(s) -> ${params.branch}`);
			const commitMessage = report.generateCommitMessage(params.updates);
			yield* branchManager.commitChanges(commitMessage, params.branch, params.workspaceRoot);
		}

		// ── pull request ─────────────────────────────────────────────────────
		if (params.dryRun) {
			yield* Effect.logInfo("Step: pull request — SKIPPED: dry run");
			return { pullRequest: null };
		}

		const pullRequest = yield* report
			.createOrUpdatePR(
				params.branch,
				params.targetBranch,
				params.updates,
				params.changesets,
				params.autoMerge || undefined,
				params.deltas,
				params.peerIssues,
			)
			.pipe(
				Effect.catch((error) =>
					Effect.gen(function* () {
						yield* Effect.logWarning(`PR creation failed: ${error.reason}`);
						return null;
					}),
				),
			);

		yield* Effect.logInfo(
			`Step: pull request — ${
				pullRequest
					? pullRequest.created
						? `created #${pullRequest.number}`
						: `updated #${pullRequest.number}`
					: "FAILED (see warning above)"
			}`,
		);

		return { pullRequest };
	});
