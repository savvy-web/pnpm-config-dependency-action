/**
 * BranchManager service for branch management and commit operations.
 *
 * Handles creating, resetting, and switching branches for dependency updates.
 * Uses `GitBranch` / `GitCommit` from `@effected/github` for the API half and
 * `@effected/git` for **every** local git operation.
 *
 * **`@effected/git` is now fully adopted here, and `Run` is gone from this
 * module.** It previously covered 2 of the 9 local operations, so the module ran
 * two subprocess mechanisms side by side; `@effected/git@0.8.0` closed the gap
 * (spencerbeggs/effected#279) and all nine now go through the service:
 * explicit-refspec `fetch` (`+refs/heads/X:refs/remotes/origin/X`, load-bearing
 * on a single-branch `actions/checkout`, where a bare ref never materializes
 * `origin/<branch>`), `fetchUnshallow`, `branchCreate` (covering both
 * `checkout -B` and `branch -f`), `reset`, `isShallow`, `mergeBaseOption` and
 * `status`.
 *
 * Two consequences worth stating, because both were live defects:
 *
 * - **Every operation now takes an explicit `cwd`.** The old `gitRun` helper set
 *   none at all and inherited the process directory, which contradicted this
 *   repo's stated no-`process.cwd()` invariant and was invisible to a grep for
 *   `process.cwd()` because there was no default to find (#266). `manage` gained
 *   a `workspaceRoot` parameter as a result.
 * - **`-c core.fileMode=false` was never the blocker** the original decline
 *   recorded. Repository-local config is a third scope beyond per-command and
 *   process-global, and `steps/configure-status.ts` writes it once per run.
 *
 * `Repo` stays in each method's `R` rather than being captured when the layer
 * is built — that is what keeps `Repo.provide(ref)` meaningful for a caller
 * targeting a different repository.
 *
 * @module services/branch
 */

import { readFileSync } from "node:fs";
import type { GitCommandError, GitShape, NotARepositoryError, UnknownRefError } from "@effected/git";
import { Git } from "@effected/git";
import type { FileChange, GitBranchShape, GitCommitShape, GitHubError, Repo } from "@effected/github";
import { FileContent, FileDeletion, GitBranch, GitCommit } from "@effected/github";
import { Context, Effect, Layer, Option } from "effect";

import { InvalidInputError } from "../errors/errors.js";
import type { BranchResult } from "../schema/domain.js";

/** Every failure `@effected/git`'s typed members can produce. */
type GitServiceError = GitCommandError | NotARepositoryError | UnknownRefError;

// ══════════════════════════════════════════════════════════════════════════════
// Service Interface
// ══════════════════════════════════════════════════════════════════════════════

export class BranchManager extends Context.Service<
	BranchManager,
	{
		/**
		 * Create or force-reset the update branch, then check it out locally.
		 *
		 * `workspaceRoot` is required: every git command here runs there. It used
		 * to run at the process directory, because the helper set no cwd at all
		 * (#266).
		 */
		readonly manage: (
			branchName: string,
			workspaceRoot: string,
			defaultBranch?: string,
		) => Effect.Effect<BranchResult, GitHubError | GitServiceError, Repo>;
		/**
		 * Commit every working-tree change via the GitHub API.
		 *
		 * `workspaceRoot` is the root the package manager was detected at, and is
		 * the directory both the status query and the file reads are anchored to.
		 * It is a parameter rather than a `process.cwd()` default because the
		 * action can legitimately be invoked from a subdirectory of the
		 * workspace: `git status --porcelain` reports paths relative to the
		 * repository root but runs relative to its cwd, so resolving the reported
		 * paths against a different directory than the one the status was taken
		 * in reads the wrong files (or none) and silently drops the change.
		 */
		readonly commitChanges: (
			message: string,
			branchName: string,
			workspaceRoot: string,
		) => Effect.Effect<void, GitHubError | GitServiceError, Repo>;
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
		readonly ensureBaseHistory: (base: string, workspaceRoot: string) => Effect.Effect<void, GitServiceError>;
	}
>()("BranchManager") {
	/**
	 * Live layer.
	 *
	 * A `static readonly layer` on the class rather than a `BranchManagerLive`
	 * const — the kit's own convention across every `@effected` service — and
	 * declared IN the class body, because a member attached by post-class
	 * assignment is tree-shaken out of the bundled `dist`. That failure appears
	 * only in production, since vitest runs the source.
	 */
	static readonly layer = Layer.effect(
		this,
		Effect.gen(function* () {
			const branch = yield* GitBranch;
			const commit = yield* GitCommit;
			// `Git` resolves every local git operation, so there is no spawner to
			// thread and no `withSpawner` wrapper any more. `Repo` deliberately is
			// NOT resolved here — see the module note.
			const git = yield* Git;

			return {
				manage: (branchName, workspaceRoot, defaultBranch = "main") =>
					manageBranchImpl(git, branch, branchName, defaultBranch, workspaceRoot),
				commitChanges: (message, branchName, workspaceRoot) =>
					commitChangesImpl(git, commit, message, branchName, workspaceRoot),
				validateBranches: (source, target) => validateBranchesImpl(branch, source, target),
				ensureBaseHistory: (base, workspaceRoot) => ensureBaseHistoryImpl(git, base, workspaceRoot),
			};
		}),
	);
}

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
	git: GitShape,
	branch: GitBranchShape,
	branchName: string,
	defaultBranch: string,
	workspaceRoot: string,
): Effect.Effect<BranchResult, GitHubError | GitServiceError, Repo> =>
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
		yield* git.fetch(workspaceRoot, {
			ref: `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`,
			remote: "origin",
		});
		// `checkout -B` is `branchCreate` with force + checkout in the kit — same
		// argv, and it belongs there rather than on `checkout`, whose refusal to
		// accept option-like refs is worth keeping strict.
		yield* git.branchCreate(workspaceRoot, branchName, {
			checkout: true,
			force: true,
			startPoint: `origin/${branchName}`,
		});

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
	git: GitShape,
	commit: GitCommitShape,
	message: string,
	branchName: string,
	workspaceRoot: string,
): Effect.Effect<void, GitHubError | GitServiceError, Repo> =>
	Effect.gen(function* () {
		// Read the change list through `@effected/git`, which runs
		// `git status --porcelain -z` and models the two porcelain columns
		// separately with `origPath` for renames. That shape is why this no longer
		// hand-parses: a rename yielding "old -> new" as a single path, and a
		// deletion whose columns disagree (`AD`, `RD`), were both real bugs here —
		// and both are impossible against a typed entry.
		//
		// `core.fileMode=false` is set on the checkout by `configureStatus` rather
		// than passed per command: executable-bit-only flips do not survive the
		// content-based API commit at mode 100644, so counting them would produce
		// an empty commit and a spurious PR.
		const entries = yield* git.status(workspaceRoot);

		if (entries.length === 0) {
			yield* Effect.logInfo("No changes to commit");
			return;
		}

		yield* Effect.logInfo("Committing changes via GitHub API...");

		const fileChanges: FileChange[] = [];

		for (const entry of entries) {
			// A rename reports both sides. The old path must be deleted explicitly:
			// the commit is an explicit change set, not a diff, so a tree that only
			// adds the new path leaves the old one behind. A COPY also carries an
			// origin but must NOT delete it — the origin still exists.
			const renamed = entry.x === "R" || entry.y === "R";
			if (renamed && entry.origPath !== undefined) {
				fileChanges.push(FileDeletion.make({ path: entry.origPath }));
				yield* Effect.logDebug(`Deleting renamed-from file: ${entry.origPath}`);
			}

			// `D` in EITHER column means the path is gone in the state being
			// committed. A rename is never a deletion of its new path.
			const deleted = !renamed && (entry.x === "D" || entry.y === "D");

			if (deleted) {
				fileChanges.push(FileDeletion.make({ path: entry.path }));
				yield* Effect.logDebug(`Deleting file: ${entry.path}`);
			} else {
				const absolutePath = entry.path.startsWith("/") ? entry.path : `${workspaceRoot}/${entry.path}`;
				try {
					const content = readFileSync(absolutePath, "utf-8");
					fileChanges.push(FileContent.make({ path: entry.path, content }));
				} catch {
					yield* Effect.logWarning(`Could not read file: ${entry.path}, skipping`);
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
		// Use reset --hard because checkout refuses to overwrite dirty/untracked
		// files that were just committed via the GitHub API.
		// Anchored at `workspaceRoot`. These two ran at the process directory until
		// the git adoption, even though the status read above already used the root.
		yield* git.fetch(workspaceRoot, { ref: branchName, remote: "origin" });
		yield* git.reset(workspaceRoot, { mode: "hard", ref: `origin/${branchName}` });
	});

/**
 * True when `git merge-base <base> HEAD` resolves — i.e. the ref exists locally
 * AND a common ancestor is present.
 *
 * `mergeBaseOption` splits those two across channels: no common ancestor is
 * `Option.none`, but an unknown ref is an `UnknownRefError` on the ERROR channel.
 * This preflight must treat both as "not ready", and the unknown-ref case is the
 * COMMON one — it is the whole reason the preflight exists on a single-branch or
 * shallow checkout.
 *
 * The catch-all is what does that, and it is load-bearing rather than defensive:
 * this returns `Effect<boolean>`, so `E` must be `never`, and the compiler
 * rejects the version without it. An earlier draft also caught `UnknownRefError`
 * by tag ahead of it, which read as the thing handling the common case but was
 * dead code — removing it changed no test and no type, while removing the
 * catch-all fails the typecheck. Kept as one catch that provably carries the
 * behavior.
 */
const hasMergeBase = (git: GitShape, cwd: string, base: string): Effect.Effect<boolean> =>
	git.mergeBaseOption(cwd, base, "HEAD").pipe(
		Effect.map(Option.isSome),
		Effect.catch(() => Effect.succeed(false)),
	);

/** True when the repository is a shallow clone (history truncated). */
const isShallowRepo = (git: GitShape, cwd: string): Effect.Effect<boolean> =>
	git.isShallow(cwd).pipe(Effect.catch(() => Effect.succeed(false)));

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
 *
 */
const ensureBaseHistoryImpl = (
	git: GitShape,
	base: string,
	workspaceRoot: string,
): Effect.Effect<void, GitServiceError> =>
	Effect.gen(function* () {
		if (yield* hasMergeBase(git, workspaceRoot, base)) {
			yield* Effect.logDebug(`Base history for "${base}" already present; no fetch needed`);
			return;
		}

		yield* Effect.logInfo(`Base history for "${base}" not available locally; fetching to enable the changeset diff`);

		// Ensure the remote-tracking ref exists, deepen a shallow clone, then
		// materialize a local ref so `git merge-base <base> HEAD` resolves by name.
		yield* git
			.fetch(workspaceRoot, { ref: `+refs/heads/${base}:refs/remotes/origin/${base}`, remote: "origin" })
			.pipe(Effect.ignore);
		if (yield* isShallowRepo(git, workspaceRoot)) {
			yield* git.fetchUnshallow(workspaceRoot, { remote: "origin" }).pipe(Effect.ignore);
		}
		// `branch -f <base> <startPoint>` is branchCreate with force and no checkout.
		yield* git
			.branchCreate(workspaceRoot, base, { force: true, startPoint: `refs/remotes/origin/${base}` })
			.pipe(Effect.ignore);

		if (!(yield* hasMergeBase(git, workspaceRoot, base))) {
			yield* Effect.logWarning(
				`Could not establish a merge-base between "${base}" and HEAD. The changeset step diffs against ` +
					`this branch — check out with fetch-depth: 0 (and ensure "${base}" is fetched).`,
			);
		}
	});
