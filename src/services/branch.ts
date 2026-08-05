/**
 * BranchManager service for branch management and commit operations.
 *
 * Handles creating, resetting, and switching branches for dependency updates.
 * Uses `GitBranch` / `GitCommit` from `@effected/github` for the API half and
 * `@effected/commands`' `Run` for the local git half.
 *
 * **`@effected/git` is deliberately not used here.** It covers 2 of the 9 local
 * git operations this module performs. It cannot express `-c core.fileMode=false`
 * on `status` (spencerbeggs/effected#279 — load-bearing: exec-bit-only flips do
 * not survive the content-based API commit at mode 100644, so counting them makes
 * an empty commit and a spurious PR), nor an explicit-refspec `fetch`
 * (`+refs/heads/X:refs/remotes/origin/X`, load-bearing on a single-branch
 * `actions/checkout`), nor `fetch --unshallow`, `checkout -B`, `reset --hard`,
 * `branch -f`, or `rev-parse --is-shallow-repository`. Adopting it for the
 * remaining two would leave two subprocess mechanisms in one module while fixing
 * nothing, so git stays entirely on `Run` until the mutating tier lands upstream.
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
import type { BranchResult } from "../schema/domain.js";

/** Every failure a local `Run`-based git invocation in this module can produce. */
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
		readonly ensureBaseHistory: (base: string, workspaceRoot: string) => Effect.Effect<void, GitRunError>;
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
			commitChanges: (message, branchName, workspaceRoot) =>
				withSpawner(commitChangesImpl(commit, message, branchName, workspaceRoot)),
			validateBranches: (source, target) => validateBranchesImpl(branch, source, target),
			ensureBaseHistory: (base, workspaceRoot) => withSpawner(ensureBaseHistoryImpl(base, workspaceRoot)),
		};
	}),
);

// ══════════════════════════════════════════════════════════════════════════════
// Local git helpers
// ══════════════════════════════════════════════════════════════════════════════

/** Run a git command, failing on a non-zero exit (the old `exec` contract). */
const gitRun = (
	...args: ReadonlyArray<string>
): Effect.Effect<string, GitRunError, ChildProcessSpawner.ChildProcessSpawner> =>
	Run.text(ChildProcess.make("git", [...args]));

/** {@link gitRun}, anchored at an explicit working directory. */
const gitRunIn = (
	cwd: string,
	...args: ReadonlyArray<string>
): Effect.Effect<string, GitRunError, ChildProcessSpawner.ChildProcessSpawner> =>
	Run.text(ChildProcess.make("git", [...args]).pipe(ChildProcess.setCwd(cwd)));

/**
 * Run a git command in `cwd` and return stdout VERBATIM, failing on a non-zero
 * exit.
 *
 * `Run.text` trims, which silently corrupts `git status --porcelain`: its
 * two-character status field is column-aligned, so a leading space (" M path")
 * is load-bearing and trimming the first line shifts every subsequent
 * `substring` index by one.
 *
 * `cwd` is explicit because git reports `--porcelain` paths relative to the
 * directory it ran in, so the caller resolving those paths must anchor on the
 * same directory.
 */
const gitRawIn = (
	cwd: string,
	...args: ReadonlyArray<string>
): Effect.Effect<string, GitRunError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const command = ChildProcess.make("git", [...args]).pipe(ChildProcess.setCwd(cwd));
		const output = yield* Run.collect(command);
		if (!output.succeeded) {
			return yield* Effect.fail(CommandFailedError.nonZero(command, output));
		}
		return output.stdout;
	});

// ══════════════════════════════════════════════════════════════════════════════
// Porcelain parsing
// ══════════════════════════════════════════════════════════════════════════════

/** One parsed `git status --porcelain` line. */
export interface StatusLine {
	/** The path the entry is about — for a rename or copy, the NEW path. */
	readonly path: string;
	/** The origin path of a rename or copy; `null` otherwise. */
	readonly origPath: string | null;
	/** True when this entry is a rename (so `origPath` must be deleted). */
	readonly renamed: boolean;
	/** True when the entry's net effect is that `path` no longer exists. */
	readonly deleted: boolean;
}

/**
 * Undo git's C-style path quoting.
 *
 * `--porcelain` wraps a path in double quotes when it contains a control
 * character, a quote, a backslash or (with the default `core.quotePath`) a
 * non-ASCII byte. `JSON.parse` covers the `\" \\ \t \n \r` escapes git emits;
 * it does NOT cover git's octal `\NNN` form for raw bytes, so a path with a
 * non-ASCII name still round-trips incorrectly. That is a narrower bug than
 * the one this function exists to fix, and it fails loudly (the file read
 * misses and warns) rather than silently committing the wrong path.
 */
const unquotePath = (raw: string): string => {
	if (!raw.startsWith('"')) return raw;
	try {
		return JSON.parse(raw) as string;
	} catch {
		return raw;
	}
};

/**
 * Parse one `git status --porcelain` (v1) line into its path and net effect.
 *
 * @remarks
 * The format is `XY PATH`, or `XY ORIG -> PATH` for a rename or copy, where `X`
 * is the index status and `Y` the worktree status. Both columns are
 * significant and a space in either is meaningful, which is why the line is
 * indexed rather than trimmed and split.
 *
 * **The bug this replaces:** the previous parser read `line.substring(3)` as the
 * whole path and compared `line.substring(0, 2).trim() === "D"`. On a rename it
 * produced the path `"old -> new"`, which cannot be read from disk, so the
 * change was dropped with a warning — a silently missing file in the commit.
 * It also missed a deletion whose index and worktree columns disagreed (`AD`,
 * `RD`), treating it as a modification and dropping it the same way.
 *
 * Exported for direct testing: the failure mode is entirely in the parsing, so
 * the test that guards it should not have to spawn git to reach it.
 */
export const parseStatusLine = (line: string): StatusLine => {
	const x = line[0] ?? " ";
	const y = line[1] ?? " ";
	const rest = line.substring(3);

	// ` -> ` only ever separates the two halves of a rename/copy entry; a literal
	// arrow inside a filename is quoted by git, so it cannot reach here unquoted.
	const arrow = rest.indexOf(" -> ");
	const renamedOrCopied = (x === "R" || x === "C" || y === "R" || y === "C") && arrow !== -1;

	const path = unquotePath(renamedOrCopied ? rest.substring(arrow + 4) : rest);
	const origPath = renamedOrCopied ? unquotePath(rest.substring(0, arrow)) : null;

	// A rename's origin must be deleted; a copy's must not.
	const renamed = renamedOrCopied && (x === "R" || y === "R");
	// `D` in EITHER column means the path is gone in the state being committed.
	// A rename entry is never a deletion of its new path.
	const deleted = !renamedOrCopied && (x === "D" || y === "D");

	return { path, origPath, renamed, deleted };
};

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
		yield* gitRun("fetch", "origin", `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`);
		yield* gitRun("checkout", "-B", branchName, `origin/${branchName}`);

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
	workspaceRoot: string,
): Effect.Effect<void, GitHubError | GitRunError, Repo | ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		// Check if there are changes to commit.
		//
		// Use core.fileMode=false so a working tree dirtied only by executable-bit
		// flips (e.g. husky chmod-ing .husky hook scripts during a `run` command)
		// is not mistaken for a committable change. We commit file content via the
		// GitHub API at mode 100644, so a mode-only change produces an empty
		// tree-diff — committing it would create an empty commit and a spurious PR.
		//
		// Anchored at `workspaceRoot`, and the file reads below resolve against the
		// same directory: git reports --porcelain paths relative to the directory it
		// ran in, so the two must not disagree.
		const statusOutput = yield* gitRawIn(workspaceRoot, "-c", "core.fileMode=false", "status", "--porcelain");
		// `line.length > 0`, not `line.trim().length > 0`: --porcelain's status
		// field is column-aligned and a leading space is load-bearing, so trimming
		// to test emptiness invites trimming to parse. program.ts's change
		// detection filters identically; the two must stay consistent.
		const lines = statusOutput.split("\n").filter((l) => l.length > 0);

		if (lines.length === 0) {
			yield* Effect.logInfo("No changes to commit");
			return;
		}

		yield* Effect.logInfo("Committing changes via GitHub API...");

		// Build FileChange entries from git status
		const fileChanges: FileChange[] = [];

		for (const line of lines) {
			const entry = parseStatusLine(line);

			// A rename or copy reports BOTH sides. The old path has to be deleted
			// explicitly: the commit is built as an explicit change set, not as a
			// diff, so a tree that only adds the new path leaves the old one behind.
			// A copy (`C`) carries an origin too, but must NOT delete it — the origin
			// still exists — which is why the two are distinguished rather than both
			// treated as "has an origPath".
			if (entry.origPath !== null && entry.renamed) {
				fileChanges.push(FileDeletion.make({ path: entry.origPath }));
				yield* Effect.logDebug(`Deleting renamed-from file: ${entry.origPath}`);
			}

			if (entry.deleted) {
				// Deleted file. The kit models a deletion as its own tagged member
				// rather than a `sha: null` sentinel.
				fileChanges.push(FileDeletion.make({ path: entry.path }));
				yield* Effect.logDebug(`Deleting file: ${entry.path}`);
			} else {
				// Added or modified file — read content, resolved against the same
				// directory the status above was taken in.
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
		yield* gitRun("fetch", "origin", branchName);
		yield* gitRun("reset", "--hard", `origin/${branchName}`);
	});

/** True when `git merge-base <base> HEAD` resolves (ref exists AND a common ancestor is present). */
const hasMergeBase = (
	cwd: string,
	base: string,
): Effect.Effect<boolean, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Run.succeeds(ChildProcess.make("git", ["merge-base", base, "HEAD"]).pipe(ChildProcess.setCwd(cwd)));

/** True when the repository is a shallow clone (history truncated). */
const isShallowRepo = (cwd: string): Effect.Effect<boolean, never, ChildProcessSpawner.ChildProcessSpawner> =>
	gitRunIn(cwd, "rev-parse", "--is-shallow-repository").pipe(
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
 *
 */
const ensureBaseHistoryImpl = (
	base: string,
	workspaceRoot: string,
): Effect.Effect<void, GitRunError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		if (yield* hasMergeBase(workspaceRoot, base)) {
			yield* Effect.logDebug(`Base history for "${base}" already present; no fetch needed`);
			return;
		}

		yield* Effect.logInfo(`Base history for "${base}" not available locally; fetching to enable the changeset diff`);

		// Ensure the remote-tracking ref exists, deepen a shallow clone, then
		// materialize a local ref so `git merge-base <base> HEAD` resolves by name.
		yield* gitRunIn(workspaceRoot, "fetch", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`).pipe(
			Effect.ignore,
		);
		if (yield* isShallowRepo(workspaceRoot)) {
			yield* gitRunIn(workspaceRoot, "fetch", "--unshallow", "origin").pipe(Effect.ignore);
		}
		yield* gitRunIn(workspaceRoot, "branch", "-f", base, `refs/remotes/origin/${base}`).pipe(Effect.ignore);

		if (!(yield* hasMergeBase(workspaceRoot, base))) {
			yield* Effect.logWarning(
				`Could not establish a merge-base between "${base}" and HEAD. The changeset step diffs against ` +
					`this branch — check out with fetch-depth: 0 (and ensure "${base}" is fetched).`,
			);
		}
	});
