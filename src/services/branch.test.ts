import type { CommandResponse, GitBranchTestState } from "@savvy-web/github-action-effects";
import {
	CommandRunnerTest,
	GitBranch,
	GitBranchError,
	GitBranchTest,
	GitCommitTest,
} from "@savvy-web/github-action-effects";
import { Effect, Either, Layer, LogLevel, Logger } from "effect";
import { describe, expect, it } from "vitest";
import { BranchManager, BranchManagerLive } from "./branch.js";

/**
 * Create a GitBranch test layer with optional initial branches.
 */
const makeTestBranchLayer = (
	branches?: Map<string, string>,
): { state: GitBranchTestState; layer: Layer.Layer<GitBranch> } => {
	const state = GitBranchTest.empty();
	if (branches) {
		for (const [name, sha] of branches) {
			state.branches.set(name, sha);
		}
	}
	return { state, layer: GitBranchTest.layer(state) };
};

/**
 * Create a CommandRunner test layer with optional command responses.
 */
const makeTestCommandLayer = (responses?: ReadonlyMap<string, CommandResponse>) => {
	if (responses) {
		return CommandRunnerTest.layer(responses);
	}
	return CommandRunnerTest.empty();
};

/**
 * Run an effect that uses BranchManager with test layers.
 */
const runWithBranchManager = <A, E>(
	effect: Effect.Effect<A, E, BranchManager>,
	branches?: Map<string, string>,
	responses?: ReadonlyMap<string, CommandResponse>,
) => {
	const { state, layer: branchLayer } = makeTestBranchLayer(branches);
	const cmdLayer = makeTestCommandLayer(responses);
	const commitState = GitCommitTest.empty();
	const commitLayer = GitCommitTest.layer(commitState);

	const serviceLayer = BranchManagerLive.pipe(Layer.provide(Layer.mergeAll(branchLayer, commitLayer, cmdLayer)));

	return {
		state,
		commitState,
		result: Effect.runPromise(
			Effect.either(effect).pipe(Effect.provide(serviceLayer), Logger.withMinimumLogLevel(LogLevel.None)),
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

		expect(Either.isRight(either)).toBe(true);
		if (Either.isRight(either)) {
			expect(either.right.branch).toBe("pnpm/config");
			expect(either.right.created).toBe(true);
			expect(either.right.upToDate).toBe(true);
			expect(either.right.baseRef).toBe("main");
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

		expect(Either.isRight(either)).toBe(true);
		if (Either.isRight(either)) {
			expect(either.right.branch).toBe("pnpm/config");
			expect(either.right.created).toBe(false);
			expect(either.right.upToDate).toBe(true);
		}
		// Branch should have been recreated with main SHA
		expect(state.branches.get("pnpm/config")).toBe("main-sha-456");
	});

	it("continues even if delete branch fails", async () => {
		const branchState: GitBranchTestState = {
			branches: new Map([
				["main", "main-sha"],
				["pnpm/config", "old-sha"],
			]),
		};
		const branchLayer = Layer.succeed(GitBranch, {
			create: (name, sha) =>
				Effect.sync(() => {
					branchState.branches.set(name, sha);
				}),
			exists: (name) => Effect.succeed(branchState.branches.has(name)),
			delete: () =>
				Effect.fail(
					new GitBranchError({
						branch: "pnpm/config",
						operation: "delete",
						reason: "Not found",
					}),
				),
			getSha: (name) => {
				const sha = branchState.branches.get(name);
				if (sha) return Effect.succeed(sha);
				return Effect.fail(
					new GitBranchError({
						branch: name,
						operation: "get",
						reason: "Branch not found",
					}),
				);
			},
			reset: (_name, _sha) => Effect.void,
		});

		const cmdLayer = CommandRunnerTest.empty();
		const commitState = GitCommitTest.empty();
		const commitLayer = GitCommitTest.layer(commitState);

		const serviceLayer = BranchManagerLive.pipe(Layer.provide(Layer.mergeAll(branchLayer, commitLayer, cmdLayer)));

		const either = await Effect.runPromise(
			Effect.either(
				Effect.gen(function* () {
					const manager = yield* BranchManager;
					return yield* manager.manage("pnpm/config", "main");
				}),
			).pipe(Effect.provide(serviceLayer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(Either.isRight(either)).toBe(true);
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

		expect(Either.isRight(either)).toBe(true);
		if (Either.isRight(either)) {
			expect(either.right.baseRef).toBe("main");
		}
	});
});

describe("BranchManager.commitChanges", () => {
	it("returns early when there are no changes", async () => {
		const responses = new Map<string, CommandResponse>([
			["git status --porcelain", { exitCode: 0, stdout: "", stderr: "" }],
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

		expect(Either.isRight(either)).toBe(true);
		// No commits should have been created
		expect(commitState.commits).toHaveLength(0);
	});

	it("commits changed files via GitHub API", async () => {
		const responses = new Map<string, CommandResponse>([
			[
				"git status --porcelain",
				{
					exitCode: 0,
					stdout: " M package.json\n",
					stderr: "",
				},
			],
			["git fetch origin", { exitCode: 0, stdout: "", stderr: "" }],
			["git checkout -B pnpm/config origin/pnpm/config", { exitCode: 0, stdout: "", stderr: "" }],
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

		expect(Either.isRight(either)).toBe(true);
		// A tree and commit should have been created via commitFiles
		expect(commitState.trees.length).toBeGreaterThanOrEqual(1);
		expect(commitState.commits).toHaveLength(1);
		expect(commitState.commits[0].message).toBe("chore: update deps");
		// commitFiles uses `parent-of-<branch>` as parent in test state
		expect(commitState.commits[0].parentShas).toEqual(["parent-of-pnpm/config"]);
		// Ref should have been updated (commitFiles records the branch name directly)
		expect(commitState.refUpdates).toHaveLength(1);
		expect(commitState.refUpdates[0].ref).toBe("pnpm/config");
	});

	it("handles deleted files with sha: null", async () => {
		const responses = new Map<string, CommandResponse>([
			[
				"git status --porcelain",
				{
					exitCode: 0,
					stdout: "D  deleted-file.ts\n",
					stderr: "",
				},
			],
			["git fetch origin", { exitCode: 0, stdout: "", stderr: "" }],
			["git checkout -B branch origin/branch", { exitCode: 0, stdout: "", stderr: "" }],
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

		expect(Either.isRight(either)).toBe(true);
		// Should have created a tree with the deletion entry
		expect(commitState.trees).toHaveLength(1);
		expect(commitState.trees[0].entries).toEqual([{ path: "deleted-file.ts", mode: "100644", sha: null }]);
		expect(commitState.commits).toHaveLength(1);
	});

	it("skips unreadable files gracefully", async () => {
		const responses = new Map<string, CommandResponse>([
			[
				"git status --porcelain",
				{
					exitCode: 0,
					stdout: "M  nonexistent-file.ts\n",
					stderr: "",
				},
			],
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

		expect(Either.isRight(either)).toBe(true);
		// No commit should be created since no files could be read
		expect(commitState.commits).toHaveLength(0);
	});
});
