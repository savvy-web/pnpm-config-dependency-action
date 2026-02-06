/**
 * Branch management utilities.
 *
 * Handles creating, rebasing, and switching branches for dependency updates.
 *
 * @module github/branch
 */

import { readFileSync, statSync } from "node:fs";
import { relative } from "node:path";
import { Effect } from "effect";

import type { BranchResult } from "../../types/index.js";
import type { GitError, GitHubApiError } from "../errors/types.js";
import type { TreeEntry } from "../services/index.js";
import { GitExecutor, GitHubClient } from "../services/index.js";

/**
 * Manage the dependency update branch.
 *
 * - If branch doesn't exist: create from default branch
 * - If branch exists: check if up-to-date, rebase if needed
 */
export const manageBranch = (
	branchName: string,
	defaultBranch: string = "main",
): Effect.Effect<BranchResult, GitHubApiError | GitError, GitHubClient | GitExecutor> =>
	Effect.gen(function* () {
		const github = yield* GitHubClient;
		const git = yield* GitExecutor;

		yield* Effect.logInfo(`Managing branch: ${branchName}`);

		// Check if branch exists
		const exists = yield* github.branchExists(branchName);

		if (!exists) {
			// Create new branch from default branch
			yield* Effect.logInfo(`Branch ${branchName} does not exist, creating from ${defaultBranch}`);

			const baseSha = yield* github.getBranchSha(defaultBranch);
			yield* Effect.logDebug(`Base SHA for ${defaultBranch}: ${baseSha}`);
			yield* github.createBranch(branchName, baseSha);

			// Fetch and checkout the new branch, tracking the remote
			yield* git.fetch();
			yield* git.checkoutTrack(branchName);

			yield* Effect.logInfo(`Created and checked out branch ${branchName}`);

			return {
				branch: branchName,
				created: true,
				upToDate: true,
				baseRef: defaultBranch,
			};
		}

		// Branch exists - we need to reset it to the default branch to start fresh
		// This ensures we always apply updates on top of the latest main
		yield* Effect.logInfo(`Branch ${branchName} exists, resetting to ${defaultBranch}`);

		yield* git.fetch();

		// Get the SHA of the default branch
		const baseSha = yield* github.getBranchSha(defaultBranch);
		yield* Effect.logDebug(`Base SHA for ${defaultBranch}: ${baseSha}`);

		// Delete the remote branch and recreate it from main
		yield* github.deleteBranch(branchName).pipe(
			Effect.catchAll((error) =>
				Effect.gen(function* () {
					yield* Effect.logWarning(`Failed to delete branch: ${error.message}`);
				}),
			),
		);

		// Create the branch fresh from main
		yield* github.createBranch(branchName, baseSha);
		yield* git.fetch();
		yield* git.checkoutTrack(branchName);

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
 * This updates the branch ref to point to the new commit SHA.
 */
export const pushBranch = (
	branchName: string,
	_force: boolean = false,
): Effect.Effect<void, GitHubApiError, GitHubClient> =>
	Effect.gen(function* () {
		// When using GitHub API commits, the branch is already updated
		// This function is kept for API compatibility but is now a no-op
		// since commitChangesViaApi updates the branch ref directly
		yield* Effect.logInfo(`Branch ${branchName} already updated via API`);
	});

/**
 * Commit all changes via GitHub API for verified commits.
 *
 * Uses the GitHub Git Data API to create commits, which are automatically
 * verified/signed by GitHub.
 */
export const commitChanges = (
	message: string,
	branchName: string,
	authorName: string = "github-actions[bot]",
	authorEmail: string = "41898282+github-actions[bot]@users.noreply.github.com",
): Effect.Effect<void, GitError | GitHubApiError, GitExecutor | GitHubClient> =>
	Effect.gen(function* () {
		const git = yield* GitExecutor;
		const github = yield* GitHubClient;

		// Check if there are changes to commit
		const status = yield* git.status();
		if (!status.hasChanges && status.staged.length === 0) {
			yield* Effect.logInfo("No changes to commit");
			return;
		}

		yield* Effect.logInfo(`Committing changes via GitHub API...`);

		// Get all changed files (staged + unstaged + untracked)
		const allChangedFiles = [...status.staged, ...status.unstaged, ...status.untracked];
		yield* Effect.logDebug(`Changed files: ${allChangedFiles.join(", ")}`);

		// Get the current branch HEAD
		const headSha = yield* github.getBranchSha(branchName);
		yield* Effect.logDebug(`Current HEAD: ${headSha}`);

		// Get the tree from the current commit
		const { treeSha: baseTree } = yield* github.getCommit(headSha);
		yield* Effect.logDebug(`Base tree: ${baseTree}`);

		// Build tree entries for changed files
		const treeEntries: TreeEntry[] = [];
		const cwd = process.cwd();

		for (const file of allChangedFiles) {
			const filePath = relative(cwd, file.startsWith("/") ? file : `${cwd}/${file}`);

			// Check if file exists (not deleted)
			try {
				const stats = statSync(file.startsWith("/") ? file : `${cwd}/${file}`);
				if (stats.isFile()) {
					const content = readFileSync(file.startsWith("/") ? file : `${cwd}/${file}`, "utf-8");
					const mode = stats.mode & 0o111 ? "100755" : "100644"; // executable or regular
					treeEntries.push({
						path: filePath,
						mode: mode as "100644" | "100755",
						type: "blob",
						content,
					});
				}
			} catch {
				// File was deleted - set sha to null to remove it
				treeEntries.push({
					path: filePath,
					mode: "100644",
					type: "blob",
					sha: null,
				});
			}
		}

		yield* Effect.logDebug(`Tree entries: ${treeEntries.length}`);

		// Create the new tree
		const newTreeSha = yield* github.createTree(baseTree, treeEntries);
		yield* Effect.logDebug(`New tree: ${newTreeSha}`);

		// Create the commit
		const commitSha = yield* github.createCommit(message, newTreeSha, [headSha], {
			name: authorName,
			email: authorEmail,
		});
		yield* Effect.logInfo(`Created commit: ${commitSha}`);

		// Update the branch ref to point to the new commit
		yield* github.updateBranchRef(branchName, commitSha);
		yield* Effect.logInfo(`Updated branch ${branchName} to ${commitSha}`);

		// Fetch the new commit locally so git status is clean
		yield* git.fetch();
		yield* git.checkoutTrack(branchName);
	});
