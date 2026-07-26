/**
 * BranchManager service for branch management and commit operations.
 *
 * Handles creating, resetting, and switching branches for dependency updates.
 * Uses `GitBranch` / `GitCommit` from `@effected/github` for the API half and
 * `@effected/commands`' `Run` for the local git half.
 *
 * `Repo` stays in each method's `R` rather than being captured when the layer
 * is built — that is what keeps `Repo.provide(ref)` meaningful for a caller
 * targeting a different repository.
 *
 * @module services/branch
 */

import { readFileSync } from "node:fs";
import type { CommandOutputError } from "@effected/commands";
import { CommandFailedError, Run } from "@effected/commands";
import type { FileChange, GitBranchShape, GitCommitShape, GitHubError, Repo } from "@effected/github";
import { FileContent, FileDeletion, GitBranch, GitCommit } from "@effected/github";
import { Context, Effect, Layer } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { InvalidInputError } from "../errors/errors.js";
import type { BranchResult } from "../schemas/domain.js";

/** Every failure a local git invocation in this module can produce. */
type GitRunError = CommandFailedError | CommandOutputError;

// ══════════════════════════════════════════════════════════════════════════════
// Service Interface
// ══════════════════════════════════════════════════════════════════════════════

export class BranchManager extends Context.Service<
	BranchManager,
	{
		readonly manage: (
			branchName: string,
			defaultBranch?: string,
		) => Effect.Effect<BranchResult, GitHubError | GitRunError, Repo>;
		readonly commitChanges: (
			message: string,
			branchName: string,
		) => Effect.Effect<void, GitHubError | GitRunError, Repo>;
		readonly validateBranches: (
			source: string,
			target: string,
		) => Effect.Effect<void, GitHubError | InvalidInputError, Repo>;
		/**
		 * Ensure `base` has enough local git history for the changeset diff.
		 *
		 * DepsRegen computes `git merge-base <base> HEAD` and reads the ancestor's
		 * tree, so it needs a local ref named `base` AND a common ancestor present.
		 * A `fetch-depth: 0` checkout of the base ref (the documented setup) already
		 * satisfies both. This is the safety net for shallower checkouts: it probes
		 * first and only fetches/deepens when the merge-base is missing.
		 */
		readonly ensureBaseHistory: (base: string) => Effect.Effect<void, GitRunError>;
	}
>()("BranchManager") {}

// ══════════════════════════════════════════════════════════════════════════════
// Live Layer
// ══════════════════════════════════════════════════════════════════════════════

export const BranchManagerLive = Layer.effect(
	BranchManager,
	Effect.gen(function* () {
		const branch = yield* GitBranch;
		const commit = yield* GitCommit;
		// The spawner is ambient infrastructure, so resolving it once here is
		// safe. `Repo` deliberately is NOT resolved here — see the module note.
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const withSpawner = <A, E, R>(effect: Effect.Effect<A, E, R | ChildProcessSpawner.ChildProcessSpawner>) =>
			effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)) as Effect.Effect<
				A,
				E,
				Exclude<R, ChildProcessSpawner.ChildProcessSpawner>
			>;

		return {
			manage: (branchName, defaultBranch = "main") => withSpawner(manageBranchImpl(branch, branchName, defaultBranch)),
			commitChanges: (message, branchName) => withSpawner(commitChangesImpl(commit, message, branchName)),
			validateBranches: (source, target) => validateBranchesImpl(branch, source, target),
			ensureBaseHistory: (base) => withSpawner(ensureBaseHistoryImpl(base)),
		};
	}),
);

// ══════════════════════════════════════════════════════════════════════════════
// Local git helpers
// ══════════════════════════════════════════════════════════════════════════════

/** Run a git command, failing on a non-zero exit (the old `exec` contract). */
const git = (
	...args: ReadonlyArray<string>
): Effect.Effect<string, GitRunError, ChildProcessSpawner.ChildProcessSpawner> =>
	Run.text(ChildProcess.make("git", [...args]));

/**
 * Run a git command and return stdout VERBATIM, failing on a non-zero exit.
 *
 * `Run.text` trims, which silently corrupts `git status --porcelain`: its
 * two-character status field is column-aligned, so a leading space (" M path")
 * is load-bearing and trimming the first line shifts every subsequent
 * `substring` index by one.
 */
const gitRaw = (
	...args: ReadonlyArray<string>
): Effect.Effect<string, GitRunError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const command = ChildProcess.make("git", [...args]);
		const output = yield* Run.collect(command);
		if (!output.succeeded) {
			return yield* Effect.fail(CommandFailedError.nonZero(command, output));
		}
		return output.stdout;
	});

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
	branch: GitBranchShape,
	branchName: string,
	defaultBranch: string,
): Effect.Effect<BranchResult, GitHubError | GitRunError, Repo | ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		yield* Effect.logInfo(`Managing branch: ${branchName}`);

		// Get the SHA of the default branch (via API, no local fetch needed).
		const baseSha = yield* branch.sha(defaultBranch);
		yield* Effect.logDebug(`Base SHA for ${defaultBranch}: ${baseSha}`);

		// `upsert` collapses the old exists/delete/create dance: it creates the
		// branch when absent and force-resets it to `baseSha` when present,
		// reporting which happened. The delete-and-recreate this replaces had the
		// same net effect but raced against anything reading the ref in between.
		const outcome = yield* branch.upsert(branchName, baseSha);

		// Fetch the branch by EXPLICIT refspec, mirroring ensureBaseHistoryImpl. A
		// bare `git fetch origin` honours the clone's configured refspec, which on a
		// single-branch checkout (actions/checkout's default) covers only the
		// checked-out branch — so origin/<branchName> is never materialized and the
		// checkout below fails. Live runs masked this by using fetch-depth: 0.
		yield* git("fetch", "origin", `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`);
		yield* git("checkout", "-B", branchName, `origin/${branchName}`);

		if (outcome === "created") {
			yield* Effect.logInfo(`Created and checked out branch ${branchName} from ${defaultBranch}`);
		} else {
			yield* Effect.logInfo(`Reset branch ${branchName} to ${defaultBranch}`);
		}

		return {
			branch: branchName,
			created: outcome === "created",
			upToDate: true,
			baseRef: defaultBranch,
		};
	});

/**
 * Validate that the source and target branches exist before any branch
 * mutation. Fails fast with `InvalidInputError` so a bad ref never triggers the
 * destructive reset. When `target === source`, the source check already covers
 * it, so the second existence check is skipped.
 */
const validateBranchesImpl = (
	branch: GitBranchShape,
	source: string,
	target: string,
): Effect.Effect<void, GitHubError | InvalidInputError, Repo> =>
	Effect.gen(function* () {
		const sourceExists = yield* branch.exists(source);
		if (!sourceExists) {
			return yield* Effect.fail(
				new InvalidInputError({
					field: "source-branch",
					reason: `Source branch "${source}" does not exist`,
					value: source,
				}),
			);
		}

		if (target !== source) {
			const targetExists = yield* branch.exists(target);
			if (!targetExists) {
				return yield* Effect.fail(
					new InvalidInputError({
						field: "target-branch",
						reason: `Target branch "${target}" does not exist`,
						value: target,
					}),
				);
			}
		}
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
	commit: GitCommitShape,
	message: string,
	branchName: string,
): Effect.Effect<void, GitHubError | GitRunError, Repo | ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		// Check if there are changes to commit.
		//
		// Use core.fileMode=false so a working tree dirtied only by executable-bit
		// flips (e.g. husky chmod-ing .husky hook scripts during a `run` command)
		// is not mistaken for a committable change. We commit file content via the
		// GitHub API at mode 100644, so a mode-only change produces an empty
		// tree-diff — committing it would create an empty commit and a spurious PR.
		const statusOutput = yield* gitRaw("-c", "core.fileMode=false", "status", "--porcelain");
		const lines = statusOutput.split("\n").filter((l) => l.trim().length > 0);

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
				// Deleted file. The kit models a deletion as its own tagged member
				// rather than a `sha: null` sentinel.
				fileChanges.push(FileDeletion.make({ path: filePath }));
				yield* Effect.logDebug(`Deleting file: ${filePath}`);
			} else {
				// Added or modified file — read content
				const absolutePath = filePath.startsWith("/") ? filePath : `${cwd}/${filePath}`;
				try {
					const content = readFileSync(absolutePath, "utf-8");
					fileChanges.push(FileContent.make({ path: filePath, content }));
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
		const commitSha = yield* commit.commitFiles({ branch: branchName, message, changes: fileChanges });
		yield* Effect.logInfo(`Created commit: ${commitSha}`);

		// Sync local working tree with the remote commit.
		// Use reset --hard because checkout refuses to overwrite dirty/untracked files
		// that were just committed via the GitHub API.
		yield* git("fetch", "origin", branchName);
		yield* git("reset", "--hard", `origin/${branchName}`);
	});

/** True when `git merge-base <base> HEAD` resolves (ref exists AND a common ancestor is present). */
const hasMergeBase = (base: string): Effect.Effect<boolean, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Run.succeeds(ChildProcess.make("git", ["merge-base", base, "HEAD"]));

/** True when the repository is a shallow clone (history truncated). */
const isShallowRepo = (): Effect.Effect<boolean, never, ChildProcessSpawner.ChildProcessSpawner> =>
	git("rev-parse", "--is-shallow-repository").pipe(
		Effect.map((out) => out.trim() === "true"),
		Effect.catch(() => Effect.succeed(false)),
	);

/**
 * Ensure `base` has enough local history for `git merge-base <base> HEAD`.
 *
 * Probes first (the documented `fetch-depth: 0` + `ref: <base>` checkout already
 * satisfies this, so the common case does no work). Only when the merge-base is
 * missing does it fetch the base ref, deepen a shallow clone, and materialize a
 * local ref so the bare name resolves. Every git call is best-effort — a fetch
 * failure degrades to a clear, actionable warning rather than aborting the run
 * (DepsRegen will still surface a precise error if the diff genuinely can't be
 * computed).
 */
const ensureBaseHistoryImpl = (
	base: string,
): Effect.Effect<void, GitRunError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		if (yield* hasMergeBase(base)) {
			yield* Effect.logDebug(`Base history for "${base}" already present; no fetch needed`);
			return;
		}

		yield* Effect.logInfo(`Base history for "${base}" not available locally; fetching to enable the changeset diff`);

		// Ensure the remote-tracking ref exists, deepen a shallow clone, then
		// materialize a local ref so `git merge-base <base> HEAD` resolves by name.
		yield* git("fetch", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`).pipe(Effect.ignore);
		if (yield* isShallowRepo()) {
			yield* git("fetch", "--unshallow", "origin").pipe(Effect.ignore);
		}
		yield* git("branch", "-f", base, `refs/remotes/origin/${base}`).pipe(Effect.ignore);

		if (!(yield* hasMergeBase(base))) {
			yield* Effect.logWarning(
				`Could not establish a merge-base between "${base}" and HEAD. The changeset step diffs against ` +
					`this branch — check out with fetch-depth: 0 (and ensure "${base}" is fetched).`,
			);
		}
	});
