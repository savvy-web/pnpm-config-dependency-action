import { describe, expect, it, vi } from "vitest";

// Mock @actions/core
vi.mock("@actions/core", () => ({
	debug: vi.fn(),
	info: vi.fn(),
	warning: vi.fn(),
	getInput: vi.fn(() => ""),
	getBooleanInput: vi.fn(() => false),
}));

// Mock @actions/github
vi.mock("@actions/github", () => ({
	context: {
		repo: { owner: "test-owner", repo: "test-repo" },
		sha: "test-sha-abc",
	},
}));

// Hoist mock so it's available in vi.mock factory
const { mockOctokit } = vi.hoisted(() => ({
	mockOctokit: {
		rest: {
			repos: {
				getBranch: vi.fn(),
			},
			git: {
				createRef: vi.fn(),
				deleteRef: vi.fn(),
				updateRef: vi.fn(),
				getCommit: vi.fn(),
				createTree: vi.fn(),
				createCommit: vi.fn(),
			},
			checks: {
				create: vi.fn(),
				update: vi.fn(),
			},
			pulls: {
				list: vi.fn(),
				create: vi.fn(),
				update: vi.fn(),
			},
		},
		graphql: vi.fn(),
	},
}));

vi.mock("@octokit/rest", () => ({
	// Must use regular function (not arrow) so it can be called with `new`
	Octokit: function MockOctokit() {
		return mockOctokit;
	},
}));

import { Effect, Either, LogLevel, Logger } from "effect";
import { GitHubClient, makeGitHubClientLayer } from "./index.js";

const runWithGitHubClient = <A, E>(effect: Effect.Effect<A, E, GitHubClient>) => {
	const layer = makeGitHubClientLayer("test-token");
	return Effect.runPromise(
		Effect.either(effect).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
	);
};

describe("makeGitHubClientLayer", () => {
	describe("branchExists", () => {
		it("returns true when branch exists", async () => {
			mockOctokit.rest.repos.getBranch.mockResolvedValueOnce({ data: {} });

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.branchExists("main");
				}),
			);

			expect(Either.isRight(result)).toBe(true);
			if (Either.isRight(result)) {
				expect(result.right).toBe(true);
			}
		});

		it("returns false when branch does not exist (404)", async () => {
			mockOctokit.rest.repos.getBranch.mockRejectedValueOnce({ status: 404 });

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.branchExists("nonexistent");
				}),
			);

			expect(Either.isRight(result)).toBe(true);
			if (Either.isRight(result)) {
				expect(result.right).toBe(false);
			}
		});

		it("fails on non-404 errors", async () => {
			mockOctokit.rest.repos.getBranch.mockRejectedValueOnce({ status: 500, message: "Server error" });

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.branchExists("main");
				}),
			);

			expect(Either.isLeft(result)).toBe(true);
		});
	});

	describe("createBranch", () => {
		it("creates branch with correct ref", async () => {
			mockOctokit.rest.git.createRef.mockResolvedValueOnce({});

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.createBranch("feature/test", "sha123");
				}),
			);

			expect(Either.isRight(result)).toBe(true);
			expect(mockOctokit.rest.git.createRef).toHaveBeenCalledWith({
				owner: "test-owner",
				repo: "test-repo",
				ref: "refs/heads/feature/test",
				sha: "sha123",
			});
		});

		it("fails when API returns error", async () => {
			mockOctokit.rest.git.createRef.mockRejectedValueOnce({ status: 422, message: "Already exists" });

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.createBranch("existing", "sha");
				}),
			);

			expect(Either.isLeft(result)).toBe(true);
		});
	});

	describe("deleteBranch", () => {
		it("deletes branch with correct ref", async () => {
			mockOctokit.rest.git.deleteRef.mockResolvedValueOnce({});

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.deleteBranch("old-branch");
				}),
			);

			expect(Either.isRight(result)).toBe(true);
			expect(mockOctokit.rest.git.deleteRef).toHaveBeenCalledWith({
				owner: "test-owner",
				repo: "test-repo",
				ref: "heads/old-branch",
			});
		});
	});

	describe("getBranchSha", () => {
		it("returns commit SHA", async () => {
			mockOctokit.rest.repos.getBranch.mockResolvedValueOnce({
				data: { commit: { sha: "abc123def" } },
			});

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.getBranchSha("main");
				}),
			);

			expect(Either.isRight(result)).toBe(true);
			if (Either.isRight(result)) {
				expect(result.right).toBe("abc123def");
			}
		});
	});

	describe("updateBranchRef", () => {
		it("force-updates branch ref", async () => {
			mockOctokit.rest.git.updateRef.mockResolvedValueOnce({});

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.updateBranchRef("feature", "new-sha");
				}),
			);

			expect(Either.isRight(result)).toBe(true);
			expect(mockOctokit.rest.git.updateRef).toHaveBeenCalledWith({
				owner: "test-owner",
				repo: "test-repo",
				ref: "heads/feature",
				sha: "new-sha",
				force: true,
			});
		});
	});

	describe("getCommit", () => {
		it("returns tree SHA from commit", async () => {
			mockOctokit.rest.git.getCommit.mockResolvedValueOnce({
				data: { tree: { sha: "tree-sha-123" } },
			});

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.getCommit("commit-sha");
				}),
			);

			expect(Either.isRight(result)).toBe(true);
			if (Either.isRight(result)) {
				expect(result.right.treeSha).toBe("tree-sha-123");
			}
		});
	});

	describe("createTree", () => {
		it("creates tree with entries", async () => {
			mockOctokit.rest.git.createTree.mockResolvedValueOnce({
				data: { sha: "new-tree-sha" },
			});

			const entries = [
				{ path: "file.ts", mode: "100644" as const, type: "blob" as const, content: "console.log('hi')" },
			];

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.createTree("base-tree", entries);
				}),
			);

			expect(Either.isRight(result)).toBe(true);
			if (Either.isRight(result)) {
				expect(result.right).toBe("new-tree-sha");
			}
		});
	});

	describe("createCommit", () => {
		it("creates commit without author for verified signature", async () => {
			mockOctokit.rest.git.createCommit.mockResolvedValueOnce({
				data: { sha: "new-commit-sha" },
			});

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.createCommit("chore: update deps", "tree-sha", ["parent-sha"], {
						name: "bot",
						email: "bot@test.com",
					});
				}),
			);

			expect(Either.isRight(result)).toBe(true);
			if (Either.isRight(result)) {
				expect(result.right).toBe("new-commit-sha");
			}
			// Verify author is NOT passed to the API call
			expect(mockOctokit.rest.git.createCommit).toHaveBeenCalledWith({
				owner: "test-owner",
				repo: "test-repo",
				message: "chore: update deps",
				tree: "tree-sha",
				parents: ["parent-sha"],
			});
		});
	});

	describe("createCheckRun", () => {
		it("creates check run with in_progress status", async () => {
			mockOctokit.rest.checks.create.mockResolvedValueOnce({
				data: { id: 42 },
			});

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.createCheckRun("Dependency Updates");
				}),
			);

			expect(Either.isRight(result)).toBe(true);
			if (Either.isRight(result)) {
				expect(result.right.id).toBe(42);
				expect(result.right.name).toBe("Dependency Updates");
				expect(result.right.status).toBe("in_progress");
			}
		});
	});

	describe("updateCheckRun", () => {
		it("updates check run with completion", async () => {
			mockOctokit.rest.checks.update.mockResolvedValueOnce({});

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.updateCheckRun(42, "completed", "success", "All good");
				}),
			);

			expect(Either.isRight(result)).toBe(true);
			expect(mockOctokit.rest.checks.update).toHaveBeenCalledWith(
				expect.objectContaining({
					check_run_id: 42,
					status: "completed",
					conclusion: "success",
					output: { title: "success", summary: "All good" },
				}),
			);
		});

		it("omits completed_at when not completed", async () => {
			mockOctokit.rest.checks.update.mockResolvedValueOnce({});

			await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.updateCheckRun(42, "in_progress", undefined, undefined);
				}),
			);

			expect(mockOctokit.rest.checks.update).toHaveBeenCalledWith(
				expect.objectContaining({
					status: "in_progress",
					completed_at: undefined,
					output: undefined,
				}),
			);
		});
	});

	describe("findPR", () => {
		it("returns null when no PR found", async () => {
			mockOctokit.rest.pulls.list.mockResolvedValueOnce({ data: [] });

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.findPR("feature", "main");
				}),
			);

			expect(Either.isRight(result)).toBe(true);
			if (Either.isRight(result)) {
				expect(result.right).toBeNull();
			}
		});

		it("returns PR when found", async () => {
			mockOctokit.rest.pulls.list.mockResolvedValueOnce({
				data: [{ number: 42, html_url: "https://github.com/test/pull/42", node_id: "PR_kwDO42" }],
			});

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.findPR("feature", "main");
				}),
			);

			expect(Either.isRight(result)).toBe(true);
			if (Either.isRight(result)) {
				expect(result.right).toEqual({
					number: 42,
					url: "https://github.com/test/pull/42",
					created: false,
					nodeId: "PR_kwDO42",
				});
			}
		});
	});

	describe("createPR", () => {
		it("creates PR and returns result", async () => {
			mockOctokit.rest.pulls.create.mockResolvedValueOnce({
				data: { number: 99, html_url: "https://github.com/test/pull/99", node_id: "PR_kwDO99" },
			});

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.createPR({
						title: "chore: update deps",
						body: "Updates",
						head: "feature",
						base: "main",
					});
				}),
			);

			expect(Either.isRight(result)).toBe(true);
			if (Either.isRight(result)) {
				expect(result.right.number).toBe(99);
				expect(result.right.created).toBe(true);
				expect(result.right.nodeId).toBe("PR_kwDO99");
			}
		});
	});

	describe("updatePR", () => {
		it("updates PR with new data", async () => {
			mockOctokit.rest.pulls.update.mockResolvedValueOnce({});

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.updatePR(42, { title: "updated", body: "new body" });
				}),
			);

			expect(Either.isRight(result)).toBe(true);
			expect(mockOctokit.rest.pulls.update).toHaveBeenCalledWith(
				expect.objectContaining({
					pull_number: 42,
					title: "updated",
					body: "new body",
				}),
			);
		});
	});

	describe("enableAutoMerge", () => {
		it("calls GraphQL mutation", async () => {
			mockOctokit.graphql.mockResolvedValueOnce({});

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.enableAutoMerge("PR_kwDO42", "SQUASH");
				}),
			);

			expect(Either.isRight(result)).toBe(true);
			expect(mockOctokit.graphql).toHaveBeenCalledWith(expect.stringContaining("enablePullRequestAutoMerge"), {
				pullRequestId: "PR_kwDO42",
				mergeMethod: "SQUASH",
			});
		});

		it("fails when GraphQL call fails", async () => {
			mockOctokit.graphql.mockRejectedValueOnce(new Error("GraphQL error"));

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.enableAutoMerge("PR_kwDO42", "MERGE");
				}),
			);

			expect(Either.isLeft(result)).toBe(true);
		});
	});

	// Error path tests - cover catch callbacks for each method
	describe("error paths", () => {
		it("deleteBranch wraps error as GitHubApiError", async () => {
			mockOctokit.rest.git.deleteRef.mockRejectedValueOnce({ status: 500, message: "Server error" });

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.deleteBranch("branch");
				}),
			);

			expect(Either.isLeft(result)).toBe(true);
			if (Either.isLeft(result)) {
				expect(result.left._tag).toBe("GitHubApiError");
			}
		});

		it("getBranchSha wraps error as GitHubApiError", async () => {
			mockOctokit.rest.repos.getBranch.mockRejectedValueOnce({ status: 404, message: "Not found" });

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.getBranchSha("missing");
				}),
			);

			expect(Either.isLeft(result)).toBe(true);
			if (Either.isLeft(result)) {
				expect(result.left._tag).toBe("GitHubApiError");
			}
		});

		it("updateBranchRef wraps error as GitHubApiError", async () => {
			mockOctokit.rest.git.updateRef.mockRejectedValueOnce({ status: 422 });

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.updateBranchRef("branch", "sha");
				}),
			);

			expect(Either.isLeft(result)).toBe(true);
		});

		it("getCommit wraps error as GitHubApiError", async () => {
			mockOctokit.rest.git.getCommit.mockRejectedValueOnce({ status: 404 });

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.getCommit("bad-sha");
				}),
			);

			expect(Either.isLeft(result)).toBe(true);
		});

		it("createTree wraps error as GitHubApiError", async () => {
			mockOctokit.rest.git.createTree.mockRejectedValueOnce({ status: 500 });

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.createTree("base", []);
				}),
			);

			expect(Either.isLeft(result)).toBe(true);
		});

		it("createCommit wraps error as GitHubApiError", async () => {
			mockOctokit.rest.git.createCommit.mockRejectedValueOnce({ status: 500 });

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.createCommit("msg", "tree", ["parent"]);
				}),
			);

			expect(Either.isLeft(result)).toBe(true);
		});

		it("createCheckRun wraps error as GitHubApiError", async () => {
			mockOctokit.rest.checks.create.mockRejectedValueOnce({ status: 403 });

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.createCheckRun("test");
				}),
			);

			expect(Either.isLeft(result)).toBe(true);
		});

		it("updateCheckRun wraps error as GitHubApiError", async () => {
			mockOctokit.rest.checks.update.mockRejectedValueOnce({ status: 500 });

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.updateCheckRun(1, "completed", "failure");
				}),
			);

			expect(Either.isLeft(result)).toBe(true);
		});

		it("findPR wraps error as GitHubApiError", async () => {
			mockOctokit.rest.pulls.list.mockRejectedValueOnce({ status: 500 });

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.findPR("head", "base");
				}),
			);

			expect(Either.isLeft(result)).toBe(true);
		});

		it("createPR wraps error as GitHubApiError", async () => {
			mockOctokit.rest.pulls.create.mockRejectedValueOnce({ status: 422 });

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.createPR({ title: "t", body: "b", head: "h", base: "b" });
				}),
			);

			expect(Either.isLeft(result)).toBe(true);
		});

		it("updatePR wraps error as GitHubApiError", async () => {
			mockOctokit.rest.pulls.update.mockRejectedValueOnce({ status: 500 });

			const result = await runWithGitHubClient(
				Effect.gen(function* () {
					const github = yield* GitHubClient;
					return yield* github.updatePR(1, { title: "t" });
				}),
			);

			expect(Either.isLeft(result)).toBe(true);
		});
	});
});
