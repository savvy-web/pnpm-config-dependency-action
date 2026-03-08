/**
 * Branch management utilities.
 *
 * Handles creating, resetting, and switching branches for dependency updates.
 * Uses library services (GitBranch, GitCommit, CommandRunner) instead of
 * custom GitExecutor and GitHubClient services.
 *
 * @module github/branch
 */

import { readFileSync, statSync } from "node:fs";
import { relative } from "node:path";
import type { CommandRunnerError, GitBranchError, GitCommitError } from "@savvy-web/github-action-effects";
import { CommandRunner, GitBranch, GitCommit } from "@savvy-web/github-action-effects";
import { Effect } from "effect";

import type { BranchResult } from "../../types/index.js";

/**
 * Manage the dependency update branch.
 *
 * - If branch doesn't exist: create from default branch
 * - If branch exists: delete and recreate from default branch (fresh start)
 */
export const manageBranch = (
	branchName: string,
	defaultBranch: string = "main",
): Effect.Effect<BranchResult, GitBranchError | CommandRunnerError, GitBranch | CommandRunner> =>
	Effect.gen(function* () {
		const branch = yield* GitBranch;
		const cmd = yield* CommandRunner;

		yield* Effect.logInfo(`Managing branch: ${branchName}`);

		// Check if branch exists
		const exists = yield* branch.exists(branchName);

		if (!exists) {
			// Create new branch from default branch
			yield* Effect.logInfo(`Branch ${branchName} does not exist, creating from ${defaultBranch}`);

			const baseSha = yield* branch.getSha(defaultBranch);
			yield* Effect.logDebug(`Base SHA for ${defaultBranch}: ${baseSha}`);
			yield* branch.create(branchName, baseSha);

			// Fetch and checkout the new branch, tracking the remote
			yield* cmd.exec("git", ["fetch", "origin"]);
			yield* cmd.exec("git", ["checkout", "-B", branchName, `origin/${branchName}`]);

			yield* Effect.logInfo(`Created and checked out branch ${branchName}`);

			return {
				branch: branchName,
				created: true,
				upToDate: true,
				baseRef: defaultBranch,
			};
		}

		// Branch exists - delete and recreate from default branch
		yield* Effect.logInfo(`Branch ${branchName} exists, resetting to ${defaultBranch}`);

		yield* cmd.exec("git", ["fetch", "origin"]);

		// Get the SHA of the default branch
		const baseSha = yield* branch.getSha(defaultBranch);
		yield* Effect.logDebug(`Base SHA for ${defaultBranch}: ${baseSha}`);

		// Delete the remote branch and recreate it from main
		yield* branch.delete(branchName).pipe(
			Effect.catchAll((error) =>
				Effect.gen(function* () {
					yield* Effect.logWarning(`Failed to delete branch: ${error.reason}`);
				}),
			),
		);

		// Create the branch fresh from main
		yield* branch.create(branchName, baseSha);
		yield* cmd.exec("git", ["fetch", "origin"]);
		yield* cmd.exec("git", ["checkout", "-B", branchName, `origin/${branchName}`]);

		yield* Effect.logInfo(`Reset branch ${branchName} to ${defaultBranch}`);

		return {
			branch: branchName,
			created: false,
			upToDate: true,
			baseRef: defaultBranch,
		};
	});

/**
 * Push changes to the remote branch using GitHub API.
 * This is a no-op since API commits update refs directly.
 */
export const pushBranch = (branchName: string, _force: boolean = false): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		// When using GitHub API commits, the branch is already updated
		// This function is kept for API compatibility but is now a no-op
		// since commitChanges updates the branch ref directly
		yield* Effect.logInfo(`Branch ${branchName} already updated via API`);
	});

/**
 * Commit all changes via GitHub API for verified commits.
 *
 * Uses the library's GitCommit service which wraps the GitHub Git Data API.
 * Commits are automatically verified/signed by GitHub when using a GitHub App token.
 *
 * NOTE: The library's GitCommit.createCommit does NOT pass an author parameter,
 * which allows GitHub to attribute and verify the commit when using a GitHub App token.
 */
export const commitChanges = (
	message: string,
	branchName: string,
): Effect.Effect<void, GitBranchError | GitCommitError | CommandRunnerError, GitBranch | GitCommit | CommandRunner> =>
	Effect.gen(function* () {
		const branchService = yield* GitBranch;
		const commit = yield* GitCommit;
		const cmd = yield* CommandRunner;

		// Check if there are changes to commit
		const statusResult = yield* cmd.execCapture("git", ["status", "--porcelain"]);
		const lines = statusResult.stdout.split("\n").filter((l) => l.trim().length > 0);

		if (lines.length === 0) {
			yield* Effect.logInfo("No changes to commit");
			return;
		}

		yield* Effect.logInfo("Committing changes via GitHub API...");

		// Parse changed files from porcelain output
		const allChangedFiles: string[] = [];
		for (const line of lines) {
			const file = line.substring(3);
			allChangedFiles.push(file);
		}

		yield* Effect.logDebug(`Changed files: ${allChangedFiles.join(", ")}`);

		// Get the current branch HEAD
		const headSha = yield* branchService.getSha(branchName);
		yield* Effect.logDebug(`Current HEAD: ${headSha}`);

		// Build tree entries for changed files
		const treeEntries: Array<{
			path: string;
			mode: "100644" | "100755" | "040000";
			content: string;
		}> = [];
		const cwd = process.cwd();

		for (const file of allChangedFiles) {
			const filePath = relative(cwd, file.startsWith("/") ? file : `${cwd}/${file}`);

			// Check if file exists (not deleted)
			try {
				const stats = statSync(file.startsWith("/") ? file : `${cwd}/${file}`);
				if (stats.isFile()) {
					const content = readFileSync(file.startsWith("/") ? file : `${cwd}/${file}`, "utf-8");
					const mode = stats.mode & 0o111 ? ("100755" as const) : ("100644" as const);
					treeEntries.push({
						path: filePath,
						mode,
						content,
					});
				}
			} catch {
				// File was deleted - we skip it since the library TreeEntry
				// doesn't support sha: null for deletions. The tree will be
				// created relative to the base tree, so missing files are
				// implicitly kept from the parent.
				yield* Effect.logDebug(`Skipping deleted file: ${filePath}`);
			}
		}

		yield* Effect.logDebug(`Tree entries: ${treeEntries.length}`);

		// Get the base tree from the current commit
		// We need to use GitHubClient.rest() for getCommit, but the library's
		// GitCommit service provides createTree with an optional baseTree param.
		// We'll get the parent tree by using the branch SHA.

		// Create the new tree (with base tree from current HEAD)
		// The library's createTree accepts a baseTree parameter
		const newTreeSha = yield* commit.createTree(treeEntries, headSha);
		yield* Effect.logDebug(`New tree: ${newTreeSha}`);

		// Create the commit (NO author parameter for verified commits)
		const commitSha = yield* commit.createCommit(message, newTreeSha, [headSha]);
		yield* Effect.logInfo(`Created commit: ${commitSha}`);

		// Update the branch ref to point to the new commit
		yield* commit.updateRef(`heads/${branchName}`, commitSha, true);
		yield* Effect.logInfo(`Updated branch ${branchName} to ${commitSha}`);

		// Fetch the new commit locally so git status is clean
		yield* cmd.exec("git", ["fetch", "origin"]);
		yield* cmd.exec("git", ["checkout", "-B", branchName, `origin/${branchName}`]);
	});
