/**
 * BranchManager service for branch management and commit operations.
 *
 * Handles creating, resetting, and switching branches for dependency updates.
 * Uses library services (GitBranch, GitCommit, CommandRunner) from
 * `@savvy-web/github-action-effects`.
 *
 * @module services/branch
 */

import { readFileSync } from "node:fs";
import type { CommandRunnerError, FileChange, GitBranchError, GitCommitError } from "@savvy-web/github-action-effects";
import { CommandRunner, GitBranch, GitCommit } from "@savvy-web/github-action-effects";
import { Context, Effect, Layer } from "effect";

import type { BranchResult } from "../schemas/domain.js";

// ══════════════════════════════════════════════════════════════════════════════
// Service Interface
// ══════════════════════════════════════════════════════════════════════════════

export class BranchManager extends Context.Tag("BranchManager")<
	BranchManager,
	{
		readonly manage: (
			branchName: string,
			defaultBranch?: string,
		) => Effect.Effect<BranchResult, GitBranchError | CommandRunnerError>;
		readonly commitChanges: (
			message: string,
			branchName: string,
		) => Effect.Effect<void, GitCommitError | CommandRunnerError>;
	}
>() {}

// ══════════════════════════════════════════════════════════════════════════════
// Live Layer
// ══════════════════════════════════════════════════════════════════════════════

export const BranchManagerLive = Layer.effect(
	BranchManager,
	Effect.gen(function* () {
		const branch = yield* GitBranch;
		const commit = yield* GitCommit;
		const cmd = yield* CommandRunner;
		return {
			manage: (branchName, defaultBranch = "main") => manageBranchImpl(branch, cmd, branchName, defaultBranch),
			commitChanges: (message, branchName) => commitChangesImpl(commit, cmd, message, branchName),
		};
	}),
);

// ══════════════════════════════════════════════════════════════════════════════
// Implementation
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Manage the dependency update branch.
 *
 * - If branch doesn't exist: create from default branch
 * - If branch exists: delete and recreate from default branch (fresh start)
 */
const manageBranchImpl = (
	branch: Context.Tag.Service<typeof GitBranch>,
	cmd: Context.Tag.Service<typeof CommandRunner>,
	branchName: string,
	defaultBranch: string,
): Effect.Effect<BranchResult, GitBranchError | CommandRunnerError> =>
	Effect.gen(function* () {
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
 * Commit all changes via GitHub API for verified commits.
 *
 * Uses the library's GitCommit.commitFiles convenience method which wraps the
 * GitHub Git Data API (createTree + createCommit + updateRef) in a single call.
 * Supports file deletions via `{ path, sha: null }`.
 *
 * Commits are automatically verified/signed by GitHub when using a GitHub App token.
 */
const commitChangesImpl = (
	commit: Context.Tag.Service<typeof GitCommit>,
	cmd: Context.Tag.Service<typeof CommandRunner>,
	message: string,
	branchName: string,
): Effect.Effect<void, GitCommitError | CommandRunnerError> =>
	Effect.gen(function* () {
		// Check if there are changes to commit
		const statusResult = yield* cmd.execCapture("git", ["status", "--porcelain"]);
		const lines = statusResult.stdout.split("\n").filter((l) => l.trim().length > 0);

		if (lines.length === 0) {
			yield* Effect.logInfo("No changes to commit");
			return;
		}

		yield* Effect.logInfo("Committing changes via GitHub API...");

		// Build FileChange entries from git status
		const fileChanges: FileChange[] = [];
		const cwd = process.cwd();

		for (const line of lines) {
			const status = line.substring(0, 2).trim();
			const filePath = line.substring(3);

			if (status === "D") {
				// Deleted file
				fileChanges.push({ path: filePath, sha: null });
				yield* Effect.logDebug(`Deleting file: ${filePath}`);
			} else {
				// Added or modified file — read content
				const absolutePath = filePath.startsWith("/") ? filePath : `${cwd}/${filePath}`;
				try {
					const content = readFileSync(absolutePath, "utf-8");
					fileChanges.push({ path: filePath, content });
				} catch {
					yield* Effect.logWarning(`Could not read file: ${filePath}, skipping`);
				}
			}
		}

		if (fileChanges.length === 0) {
			yield* Effect.logInfo("No file changes to commit");
			return;
		}

		yield* Effect.logDebug(`File changes: ${fileChanges.length}`);

		// Commit all files in one API call
		const commitSha = yield* commit.commitFiles(branchName, message, fileChanges);
		yield* Effect.logInfo(`Created commit: ${commitSha}`);

		// Fetch the new commit locally so git status is clean
		yield* cmd.exec("git", ["fetch", "origin"]);
		yield* cmd.exec("git", ["checkout", "-B", branchName, `origin/${branchName}`]);
	});
