import type { ScriptResult } from "@effected/commands";
import { ScriptedSpawner } from "@effected/commands";
import type { FileChange, Repo } from "@effected/github";
import { GitBranch, GitCommit, GitHubError, RepoRef, Repo as RepoTag } from "@effected/github";
import { Effect, Layer, References, Result } from "effect";
import { describe, expect, it } from "vitest";
import { BranchManager, BranchManagerLive } from "../../../src/services/branch.js";
import { fromMap } from "../../utils/spawner.js";

/** Every resource method resolves `Repo` per call, so tests provide one. */
const repoLayer = RepoTag.layer(RepoRef.make({ owner: "test", repo: "repo" }));

interface BranchState {
	branches: Map<string, string>;
}

/**
 * A `GitBranch` double over an in-memory ref map.
 *
 * Only the members `BranchManager` reaches are stubbed — `sha`, `exists` and
 * `upsert`. Any other member dies naming itself, which is what proves the
 * service touches nothing else.
 */
const branchDouble = (state: BranchState, overrides: Parameters<typeof GitBranch.layerTest>[0] = {}) =>
	GitBranch.layerTest({
		sha: (name) => {
			const sha = state.branches.get(name);
			return sha === undefined
				? Effect.fail(new GitHubError({ kind: "notFound", operation: "git.getRef", reason: "Branch not found" }))
				: Effect.succeed(sha);
		},
		exists: (name) => Effect.succeed(state.branches.has(name)),
		upsert: (name, sha) =>
			Effect.sync(() => {
				const existed = state.branches.has(name);
				state.branches.set(name, sha);
				return existed ? ("reset" as const) : ("created" as const);
			}),
		...overrides,
	});

interface RecordedCommit {
	branch: string;
	message: string;
	changes: ReadonlyArray<FileChange>;
}

interface CommitState {
	commits: Array<RecordedCommit>;
}

/** A `GitCommit` double recording what `commitFiles` was asked to write. */
const commitDouble = (state: CommitState) =>
	GitCommit.layerTest({
		commitFiles: ({ branch, message, changes }) =>
			Effect.sync(() => {
				state.commits.push({ branch, message, changes });
				return `commit-sha-${state.commits.length}`;
			}),
	});

/**
 * Run an effect that uses BranchManager with test layers.
 */
const runWithBranchManager = <A, E>(
	effect: Effect.Effect<A, E, BranchManager | Repo>,
	branches?: Map<string, string>,
	responses?: ReadonlyMap<string, ScriptResult>,
) => {
	const state: BranchState = { branches: new Map(branches ?? []) };
	const commitState: CommitState = { commits: [] };
	const spawner = fromMap(responses);

	const serviceLayer = BranchManagerLive.pipe(
		Layer.provide(Layer.mergeAll(branchDouble(state), commitDouble(commitState), spawner.layer)),
	);

	return {
		state,
		commitState,
		spawner,
		result: Effect.runPromise(
			Effect.result(effect).pipe(
				Effect.provide(Layer.merge(serviceLayer, repoLayer)),
				Effect.provideService(References.MinimumLogLevel, "None"),
			),
		),
	};
};

describe("BranchManager.manage", () => {
	it("creates new branch when it does not exist", async () => {
		const branches = new Map([["main", "main-sha-123"]]);
		const { state, result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.manage("pnpm/config", "main");
			}),
			branches,
		);

		const either = await result;

		expect(Result.isSuccess(either)).toBe(true);
		if (Result.isSuccess(either)) {
			expect(either.success.branch).toBe("pnpm/config");
			expect(either.success.created).toBe(true);
			expect(either.success.upToDate).toBe(true);
			expect(either.success.baseRef).toBe("main");
		}
		// Branch should have been created in the test state
		expect(state.branches.get("pnpm/config")).toBe("main-sha-123");
	});

	it("resets existing branch to default branch", async () => {
		const branches = new Map([
			["main", "main-sha-456"],
			["pnpm/config", "old-sha"],
		]);
		const { state, result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.manage("pnpm/config", "main");
			}),
			branches,
		);

		const either = await result;

		expect(Result.isSuccess(either)).toBe(true);
		if (Result.isSuccess(either)) {
			expect(either.success.branch).toBe("pnpm/config");
			expect(either.success.created).toBe(false);
			expect(either.success.upToDate).toBe(true);
		}
		// Branch should have been recreated with main SHA
		expect(state.branches.get("pnpm/config")).toBe("main-sha-456");
	});

	it("propagates a failure from upsert", async () => {
		// The old delete-and-recreate had a tolerated delete failure; upsert has
		// no separate delete step, so the failure that remains is upsert's own and
		// it must NOT be swallowed — a branch that could not be reset means the
		// run would push onto stale state.
		const state = { branches: new Map([["main", "main-sha"]]) };
		const failingBranch = branchDouble(state, {
			upsert: () =>
				Effect.fail(new GitHubError({ kind: "rejected", operation: "git.updateRef", reason: "protected branch" })),
		});
		const spawner = fromMap();
		const serviceLayer = BranchManagerLive.pipe(
			Layer.provide(Layer.mergeAll(failingBranch, commitDouble({ commits: [] }), spawner.layer)),
		);

		const either = await Effect.runPromise(
			Effect.result(
				Effect.gen(function* () {
					const manager = yield* BranchManager;
					return yield* manager.manage("pnpm/config", "main");
				}),
			).pipe(
				Effect.provide(Layer.merge(serviceLayer, repoLayer)),
				Effect.provideService(References.MinimumLogLevel, "None"),
			),
		);

		expect(Result.isFailure(either)).toBe(true);
		if (Result.isFailure(either)) {
			expect((either.failure as GitHubError).kind).toBe("rejected");
		}
	});

	it("defaults to 'main' when no default branch specified", async () => {
		const branches = new Map([["main", "sha"]]);
		const { result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.manage("pnpm/config");
			}),
			branches,
		);

		const either = await result;

		expect(Result.isSuccess(either)).toBe(true);
		if (Result.isSuccess(either)) {
			expect(either.success.baseRef).toBe("main");
		}
	});
});

describe("BranchManager.commitChanges", () => {
	it("returns early when there are no changes", async () => {
		const responses = new Map<string, ScriptResult>([
			["git -c core.fileMode=false status --porcelain", { exit: 0, stdout: "", stderr: "" }],
		]);

		const { commitState, result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.commitChanges("test commit", "pnpm/config");
			}),
			undefined,
			responses,
		);

		const either = await result;

		expect(Result.isSuccess(either)).toBe(true);
		// No commits should have been created
		expect(commitState.commits).toHaveLength(0);
	});

	it("commits changed files via GitHub API", async () => {
		const responses = new Map<string, ScriptResult>([
			["git -c core.fileMode=false status --porcelain", { exit: 0, stdout: " M package.json\n", stderr: "" }],
			["git fetch origin pnpm/config", { exit: 0, stdout: "", stderr: "" }],
			["git reset --hard origin/pnpm/config", { exit: 0, stdout: "", stderr: "" }],
		]);

		const { commitState, result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.commitChanges("chore: update deps", "pnpm/config");
			}),
			undefined,
			responses,
		);

		const either = await result;

		expect(Result.isSuccess(either)).toBe(true);
		// commitFiles is a single call in the kit: tree, commit and ref update all
		// happen behind it, so the assertion is on what it was asked to write.
		expect(commitState.commits).toHaveLength(1);
		expect(commitState.commits[0].message).toBe("chore: update deps");
		expect(commitState.commits[0].branch).toBe("pnpm/config");
		expect(commitState.commits[0].changes).toEqual([
			{ _tag: "FileContent", path: "package.json", content: expect.any(String) },
		]);
	});

	it("records a deletion as a FileDeletion member", async () => {
		const responses = new Map<string, ScriptResult>([
			["git -c core.fileMode=false status --porcelain", { exit: 0, stdout: "D  deleted-file.ts\n", stderr: "" }],
			["git fetch origin branch", { exit: 0, stdout: "", stderr: "" }],
			["git reset --hard origin/branch", { exit: 0, stdout: "", stderr: "" }],
		]);

		const { commitState, result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.commitChanges("update", "branch");
			}),
			undefined,
			responses,
		);

		const either = await result;

		expect(Result.isSuccess(either)).toBe(true);
		// A deletion is its own tagged member now, not a `sha: null` sentinel.
		expect(commitState.commits).toHaveLength(1);
		expect(commitState.commits[0].changes).toEqual([{ _tag: "FileDeletion", path: "deleted-file.ts" }]);
	});

	it("skips unreadable files gracefully", async () => {
		const responses = new Map<string, ScriptResult>([
			["git -c core.fileMode=false status --porcelain", { exit: 0, stdout: "M  nonexistent-file.ts\n", stderr: "" }],
		]);

		const { commitState, result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.commitChanges("update", "branch");
			}),
			undefined,
			responses,
		);

		const either = await result;

		expect(Result.isSuccess(either)).toBe(true);
		// No commit should be created since no files could be read
		expect(commitState.commits).toHaveLength(0);
	});

	it("ignores executable-bit-only changes and does not create an empty commit", async () => {
		// Regression: a `run` command (e.g. husky chmod-ing .husky/commit-msg
		// during `savvy-commit init`) can flip a tracked file's executable bit
		// without changing its content. A mode-sensitive `git status` reports it
		// as modified, but committing file content via the GitHub API at mode
		// 100644 yields an empty tree-diff — an empty commit + spurious PR.
		// commitChanges must query status with core.fileMode=false so a mode-only
		// dirty tree is treated as no change.
		const responses = new Map<string, ScriptResult>([
			// Mode-sensitive status (the buggy path) would surface a real, readable
			// file as modified purely because of an executable-bit flip.
			["git status --porcelain", { exit: 0, stdout: " M package.json\n", stderr: "" }],
			// Mode-insensitive status (the correct path) reports nothing — the only
			// working-tree difference was the chmod.
			["git -c core.fileMode=false status --porcelain", { exit: 0, stdout: "", stderr: "" }],
			["git fetch origin pnpm/config", { exit: 0, stdout: "", stderr: "" }],
			["git reset --hard origin/pnpm/config", { exit: 0, stdout: "", stderr: "" }],
		]);

		const { commitState, result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.commitChanges("chore: update deps", "pnpm/config");
			}),
			undefined,
			responses,
		);

		const either = await result;

		expect(Result.isSuccess(either)).toBe(true);
		// No commit should be created from a mode-only change.
		expect(commitState.commits).toHaveLength(0);
	});
});

describe("BranchManager.validateBranches", () => {
	it("succeeds when both branches exist", async () => {
		const branches = new Map([
			["main", "main-sha"],
			["dev", "dev-sha"],
		]);
		const { result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.validateBranches("dev", "main");
			}),
			branches,
		);
		expect(Result.isSuccess(await result)).toBe(true);
	});

	it("succeeds when target equals source (skips redundant check)", async () => {
		const branches = new Map([["dev", "dev-sha"]]);
		const { result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.validateBranches("dev", "dev");
			}),
			branches,
		);
		expect(Result.isSuccess(await result)).toBe(true);
	});

	it("fails with InvalidInputError when source branch is missing", async () => {
		const branches = new Map([["main", "main-sha"]]);
		const { result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.validateBranches("nope", "main");
			}),
			branches,
		);
		const either = await result;
		expect(Result.isFailure(either)).toBe(true);
		if (Result.isFailure(either)) {
			expect(either.failure._tag).toBe("InvalidInputError");
			expect((either.failure as { field: string }).field).toBe("source-branch");
		}
	});

	it("fails with InvalidInputError when target branch is missing", async () => {
		const branches = new Map([["dev", "dev-sha"]]);
		const { result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.validateBranches("dev", "main");
			}),
			branches,
		);
		const either = await result;
		expect(Result.isFailure(either)).toBe(true);
		if (Result.isFailure(either)) {
			expect(either.failure._tag).toBe("InvalidInputError");
			expect((either.failure as { field: string }).field).toBe("target-branch");
		}
	});
});

describe("BranchManager.ensureBaseHistory", () => {
	it("is a no-op when the merge-base already resolves (no fetch)", async () => {
		// merge-base succeeds → the base history is present, so no fetch commands
		// need be mapped; an unmapped fetch would surface if the code fetched anyway.
		const responses = new Map<string, ScriptResult>([
			["git merge-base main HEAD", { exit: 0, stdout: "abc123\n", stderr: "" }],
		]);
		const { result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.ensureBaseHistory("main");
			}),
			undefined,
			responses,
		);
		expect(Result.isSuccess(await result)).toBe(true);
	});

	it("fetches and deepens, then succeeds (warns) when the base is unavailable", async () => {
		// merge-base never resolves → the fallback fetch/unshallow/branch path runs
		// and the effect still succeeds (best-effort, non-fatal — it warns).
		const responses = new Map<string, ScriptResult>([
			["git merge-base main HEAD", { exit: 1, stdout: "", stderr: "no merge base" }],
			["git fetch origin +refs/heads/main:refs/remotes/origin/main", { exit: 0, stdout: "", stderr: "" }],
			["git rev-parse --is-shallow-repository", { exit: 0, stdout: "true\n", stderr: "" }],
			["git fetch --unshallow origin", { exit: 0, stdout: "", stderr: "" }],
			["git branch -f main refs/remotes/origin/main", { exit: 0, stdout: "", stderr: "" }],
		]);
		const { result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.ensureBaseHistory("main");
			}),
			undefined,
			responses,
		);
		expect(Result.isSuccess(await result)).toBe(true);
	});
});

describe("BranchManager.manage — git plumbing", () => {
	it("fetches the branch by explicit refspec, not a bare `git fetch origin`", async () => {
		// A bare fetch honours the clone's configured refspec, which on a
		// single-branch checkout (actions/checkout's default) covers only the
		// checked-out branch — so origin/<branch> never materializes and the
		// checkout below it fails. Live runs masked this with fetch-depth: 0.
		//
		// The spawner answers unscripted commands with a zero exit, so asserting
		// only that `manage` SUCCEEDS proves nothing here; the assertion has to be
		// on the argv actually spawned.
		const branches = new Map([["main", "main-sha"]]);
		const { spawner, result } = runWithBranchManager(
			Effect.gen(function* () {
				const manager = yield* BranchManager;
				return yield* manager.manage("pnpm/config", "main");
			}),
			branches,
		);

		expect(Result.isSuccess(await result)).toBe(true);

		const lines = spawner.spawns.map((call) => [call.command, ...call.args].join(" "));
		expect(lines).toContain("git fetch origin +refs/heads/pnpm/config:refs/remotes/origin/pnpm/config");
		expect(lines).not.toContain("git fetch origin");
		expect(lines).toContain("git checkout -B pnpm/config origin/pnpm/config");
	});
});
