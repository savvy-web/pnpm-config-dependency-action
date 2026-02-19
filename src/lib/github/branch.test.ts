import { describe, expect, it, vi } from "vitest";

// Mock @actions/core
vi.mock("@actions/core", () => ({
	debug: vi.fn(),
	info: vi.fn(),
	warning: vi.fn(),
	getInput: vi.fn(() => ""),
	getBooleanInput: vi.fn(() => false),
}));

import type { Octokit } from "@octokit/rest";
import { Effect, Either, Layer, LogLevel, Logger } from "effect";
import { GitHubApiError } from "../schemas/errors.js";
import type { GitExecutorService, GitHubClientService } from "../services/index.js";
import { GitExecutor, GitHubClient } from "../services/index.js";
import { commitChanges, manageBranch, pushBranch } from "./branch.js";

const makeTestGitHubClient = (overrides: Partial<GitHubClientService> = {}): Layer.Layer<GitHubClient> => {
	const noop = () => Effect.void as Effect.Effect<never, never>;
	const service: GitHubClientService = {
		octokit: {} as Octokit,
		owner: "test-owner",
		repo: "test-repo",
		sha: "abc123",
		branchExists: () => Effect.succeed(false),
		createBranch: noop,
		deleteBranch: noop,
		getBranchSha: () => Effect.succeed("sha123"),
		updateBranchRef: noop,
		getCommit: () => Effect.succeed({ treeSha: "tree123" }),
		createTree: () => Effect.succeed("tree456"),
		createCommit: () => Effect.succeed("commit789"),
		createCheckRun: () => Effect.succeed({ id: 1, name: "test", status: "in_progress" as const }),
		updateCheckRun: noop,
		findPR: () => Effect.succeed(null),
		createPR: () =>
			Effect.succeed({ number: 1, url: "https://github.com/test/pull/1", created: true, nodeId: "PR_kwDOTest1" }),
		updatePR: noop,
		enableAutoMerge: noop,
		...overrides,
	};
	return Layer.succeed(GitHubClient, service);
};

const makeTestGitExecutor = (overrides: Partial<GitExecutorService> = {}): Layer.Layer<GitExecutor> => {
	const noop = () => Effect.void as Effect.Effect<never, never>;
	const service: GitExecutorService = {
		checkout: noop,
		checkoutTrack: noop,
		fetch: noop,
		rebase: noop,
		commit: noop,
		push: noop,
		status: () => Effect.succeed({ hasChanges: false, staged: [], unstaged: [], untracked: [] }),
		add: noop,
		configUser: noop,
		...overrides,
	};
	return Layer.succeed(GitExecutor, service);
};

const runWithLayers = <A, E>(
	effect: Effect.Effect<A, E, GitHubClient | GitExecutor>,
	githubOverrides: Partial<GitHubClientService> = {},
	gitOverrides: Partial<GitExecutorService> = {},
) => {
	const layer = Layer.merge(makeTestGitHubClient(githubOverrides), makeTestGitExecutor(gitOverrides));
	return Effect.runPromise(
		Effect.either(effect).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
	);
};

describe("manageBranch", () => {
	it("creates new branch when it does not exist", async () => {
		const createBranchCalls: Array<{ name: string; sha: string }> = [];

		const result = await runWithLayers(manageBranch("pnpm/config", "main"), {
			branchExists: () => Effect.succeed(false),
			getBranchSha: () => Effect.succeed("main-sha-123"),
			createBranch: (name, sha) => {
				createBranchCalls.push({ name, sha });
				return Effect.void;
			},
		});

		expect(Either.isRight(result)).toBe(true);
		if (Either.isRight(result)) {
			expect(result.right.branch).toBe("pnpm/config");
			expect(result.right.created).toBe(true);
			expect(result.right.upToDate).toBe(true);
			expect(result.right.baseRef).toBe("main");
		}
		expect(createBranchCalls).toEqual([{ name: "pnpm/config", sha: "main-sha-123" }]);
	});

	it("resets existing branch to default branch", async () => {
		const deletedBranches: string[] = [];
		const createdBranches: Array<{ name: string; sha: string }> = [];

		const result = await runWithLayers(manageBranch("pnpm/config", "main"), {
			branchExists: () => Effect.succeed(true),
			getBranchSha: () => Effect.succeed("main-sha-456"),
			deleteBranch: (name) => {
				deletedBranches.push(name);
				return Effect.void;
			},
			createBranch: (name, sha) => {
				createdBranches.push({ name, sha });
				return Effect.void;
			},
		});

		expect(Either.isRight(result)).toBe(true);
		if (Either.isRight(result)) {
			expect(result.right.branch).toBe("pnpm/config");
			expect(result.right.created).toBe(false);
			expect(result.right.upToDate).toBe(true);
		}
		expect(deletedBranches).toEqual(["pnpm/config"]);
		expect(createdBranches).toEqual([{ name: "pnpm/config", sha: "main-sha-456" }]);
	});

	it("continues even if delete branch fails", async () => {
		const result = await runWithLayers(manageBranch("pnpm/config", "main"), {
			branchExists: () => Effect.succeed(true),
			getBranchSha: () => Effect.succeed("main-sha"),
			deleteBranch: () =>
				Effect.fail(new GitHubApiError({ operation: "git.deleteRef", statusCode: 404, message: "Not found" })),
		});

		expect(Either.isRight(result)).toBe(true);
	});

	it("defaults to 'main' when no default branch specified", async () => {
		const result = await runWithLayers(manageBranch("pnpm/config"), {
			branchExists: () => Effect.succeed(false),
			getBranchSha: () => Effect.succeed("sha"),
		});

		expect(Either.isRight(result)).toBe(true);
		if (Either.isRight(result)) {
			expect(result.right.baseRef).toBe("main");
		}
	});
});

describe("pushBranch", () => {
	it("is a no-op (API commits update branch directly)", async () => {
		const layer = makeTestGitHubClient();
		const result = await Effect.runPromise(
			Effect.either(pushBranch("pnpm/config")).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(Either.isRight(result)).toBe(true);
	});
});

describe("commitChanges", () => {
	it("returns early when there are no changes", async () => {
		const createCommitCalls: string[] = [];

		const result = await runWithLayers(
			commitChanges("test commit", "pnpm/config"),
			{
				createCommit: (msg) => {
					createCommitCalls.push(msg);
					return Effect.succeed("sha");
				},
			},
			{
				status: () => Effect.succeed({ hasChanges: false, staged: [], unstaged: [], untracked: [] }),
			},
		);

		expect(Either.isRight(result)).toBe(true);
		expect(createCommitCalls).toHaveLength(0);
	});

	it("commits changed files via GitHub API", async () => {
		const createTreeCalls: Array<{ baseTree: string; entries: unknown }> = [];
		const createCommitCalls: Array<{ message: string; tree: string }> = [];
		const updateBranchCalls: Array<{ name: string; sha: string }> = [];

		const result = await runWithLayers(
			commitChanges("chore: update deps", "pnpm/config"),
			{
				getBranchSha: () => Effect.succeed("head-sha"),
				getCommit: () => Effect.succeed({ treeSha: "base-tree-sha" }),
				createTree: (baseTree, entries) => {
					createTreeCalls.push({ baseTree, entries });
					return Effect.succeed("new-tree-sha");
				},
				createCommit: (message, tree) => {
					createCommitCalls.push({ message, tree });
					return Effect.succeed("new-commit-sha");
				},
				updateBranchRef: (name, sha) => {
					updateBranchCalls.push({ name, sha });
					return Effect.void;
				},
			},
			{
				status: () =>
					Effect.succeed({
						hasChanges: true,
						staged: ["package.json"],
						unstaged: [],
						untracked: [],
					}),
			},
		);

		expect(Either.isRight(result)).toBe(true);
		expect(createTreeCalls).toHaveLength(1);
		expect(createTreeCalls[0].baseTree).toBe("base-tree-sha");
		expect(createCommitCalls).toHaveLength(1);
		expect(createCommitCalls[0].message).toBe("chore: update deps");
		expect(createCommitCalls[0].tree).toBe("new-tree-sha");
		expect(updateBranchCalls).toEqual([{ name: "pnpm/config", sha: "new-commit-sha" }]);
	});

	it("handles all file types (staged, unstaged, untracked)", async () => {
		const createTreeCalls: Array<{ entries: unknown }> = [];

		await runWithLayers(
			commitChanges("update", "branch"),
			{
				createTree: (_baseTree, entries) => {
					createTreeCalls.push({ entries });
					return Effect.succeed("tree-sha");
				},
			},
			{
				status: () =>
					Effect.succeed({
						hasChanges: true,
						staged: ["file1.ts"],
						unstaged: ["file2.ts"],
						untracked: ["file3.ts"],
					}),
			},
		);

		expect(createTreeCalls).toHaveLength(1);
	});
});
