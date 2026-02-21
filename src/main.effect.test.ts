import { describe, expect, it, vi } from "vitest";

// Mock @actions/core before any imports that use it
vi.mock("@actions/core", () => ({
	getState: vi.fn(() => ""),
	getInput: vi.fn(() => ""),
	getBooleanInput: vi.fn(() => false),
	setFailed: vi.fn(),
	setOutput: vi.fn(),
	info: vi.fn(),
	debug: vi.fn(),
	warning: vi.fn(),
	summary: { addHeading: vi.fn(), addRaw: vi.fn(), write: vi.fn() },
}));

// Mock @actions/github for branch.ts
vi.mock("@actions/github", () => ({
	context: {
		repo: { owner: "test-owner", repo: "test-repo" },
		sha: "abc123",
	},
}));

import type { Octokit } from "@octokit/rest";
import { Effect, Layer, LogLevel, Logger } from "effect";
import { pnpmUpgradeUpdate } from "./lib/__test__/fixtures.js";
import { GitHubApiError, PnpmError } from "./lib/schemas/errors.js";
import type { GitHubClientService, PnpmExecutorService } from "./lib/services/index.js";
import { GitHubClient, PnpmExecutor } from "./lib/services/index.js";
import { createOrUpdatePR, generatePRBody, runCommands } from "./main.js";

// ══════════════════════════════════════════════════════════════════════════════
// Test Helpers
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Run an Effect with a test PnpmExecutor layer.
 */
const runWithPnpm = <A, E>(effect: Effect.Effect<A, E, PnpmExecutor>, overrides: Partial<PnpmExecutorService> = {}) => {
	const service: PnpmExecutorService = {
		addConfig: (_dep) => Effect.succeed("ok"),
		update: (_pattern) => Effect.succeed("ok"),
		install: () => Effect.void,
		run: (_cmd) => Effect.succeed("ok"),
		...overrides,
	};
	const layer = Layer.succeed(PnpmExecutor, service);
	return Effect.runPromise(effect.pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)));
};

/**
 * Create a mock GitHubClient layer.
 */
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

// ══════════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════════

describe("runCommands", () => {
	it("returns empty result for empty commands", async () => {
		const result = await runWithPnpm(runCommands([]));
		expect(result.successful).toEqual([]);
		expect(result.failed).toEqual([]);
	});

	it("runs each command sequentially", async () => {
		const commandOrder: string[] = [];

		const result = await runWithPnpm(runCommands(["pnpm lint:fix", "pnpm test"]), {
			run: (cmd) => {
				commandOrder.push(cmd);
				return Effect.succeed("ok");
			},
		});

		expect(commandOrder).toEqual(["pnpm lint:fix", "pnpm test"]);
		expect(result.successful).toEqual(["pnpm lint:fix", "pnpm test"]);
		expect(result.failed).toEqual([]);
	});

	it("collects failed commands with error details", async () => {
		const result = await runWithPnpm(runCommands(["pnpm lint:fix"]), {
			run: (_cmd) => Effect.fail(new PnpmError({ command: "lint:fix", exitCode: 1, stderr: "lint errors" })),
		});

		expect(result.successful).toEqual([]);
		expect(result.failed).toHaveLength(1);
		expect(result.failed[0].command).toBe("pnpm lint:fix");
		expect(result.failed[0].error).toContain("lint errors");
	});

	it("continues after failure (all commands run)", async () => {
		const result = await runWithPnpm(runCommands(["pnpm lint", "pnpm test", "pnpm build"]), {
			run: (cmd) => {
				if (cmd === "pnpm test") {
					return Effect.fail(new PnpmError({ command: "test", exitCode: 1, stderr: "test fail" }));
				}
				return Effect.succeed("ok");
			},
		});

		expect(result.successful).toEqual(["pnpm lint", "pnpm build"]);
		expect(result.failed).toHaveLength(1);
		expect(result.failed[0].command).toBe("pnpm test");
	});
});

describe("createOrUpdatePR", () => {
	it("creates new PR when none exists", async () => {
		const layer = makeTestGitHubClient({
			findPR: () => Effect.succeed(null),
			createPR: () =>
				Effect.succeed({
					number: 42,
					url: "https://github.com/test/pull/42",
					created: true,
					nodeId: "PR_kwDOTest42",
				}),
		});

		const result = await Effect.runPromise(
			createOrUpdatePR("pnpm/config", [], []).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(result.number).toBe(42);
		expect(result.created).toBe(true);
	});

	it("updates existing PR when found", async () => {
		const updatedNumbers: number[] = [];
		const layer = makeTestGitHubClient({
			findPR: () =>
				Effect.succeed({
					number: 10,
					url: "https://github.com/test/pull/10",
					created: false,
					nodeId: "PR_kwDOTest10",
				}),
			updatePR: (num) => {
				updatedNumbers.push(num);
				return Effect.void;
			},
		});

		const result = await Effect.runPromise(
			createOrUpdatePR("pnpm/config", [], []).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(result.number).toBe(10);
		expect(result.created).toBe(false);
		expect(updatedNumbers).toEqual([10]);
	});

	it("handles create API failure gracefully (returns zero PR)", async () => {
		const layer = makeTestGitHubClient({
			findPR: () => Effect.succeed(null),
			createPR: () =>
				Effect.fail(new GitHubApiError({ operation: "pulls.create", statusCode: 500, message: "Internal error" })),
		});

		const result = await Effect.runPromise(
			createOrUpdatePR("pnpm/config", [], []).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(result.number).toBe(0);
	});

	it("returns nodeId from created PR", async () => {
		const layer = makeTestGitHubClient({
			findPR: () => Effect.succeed(null),
			createPR: () =>
				Effect.succeed({
					number: 42,
					url: "https://github.com/test/pull/42",
					created: true,
					nodeId: "PR_kwDOTestNode42",
				}),
		});

		const result = await Effect.runPromise(
			createOrUpdatePR("pnpm/config", [], []).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(result.nodeId).toBe("PR_kwDOTestNode42");
	});

	it("returns nodeId from existing PR", async () => {
		const layer = makeTestGitHubClient({
			findPR: () =>
				Effect.succeed({
					number: 10,
					url: "https://github.com/test/pull/10",
					created: false,
					nodeId: "PR_kwDOExisting10",
				}),
		});

		const result = await Effect.runPromise(
			createOrUpdatePR("pnpm/config", [], []).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(result.nodeId).toBe("PR_kwDOExisting10");
	});

	it("returns empty nodeId on create failure", async () => {
		const layer = makeTestGitHubClient({
			findPR: () => Effect.succeed(null),
			createPR: () => Effect.fail(new GitHubApiError({ operation: "pulls.create", statusCode: 500, message: "fail" })),
		});

		const result = await Effect.runPromise(
			createOrUpdatePR("pnpm/config", [], []).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(result.nodeId).toBe("");
	});
});

describe("generatePRBody", () => {
	it("includes pnpm upgrade in config dependencies table", () => {
		const updates = [
			pnpmUpgradeUpdate,
			{ dependency: "typescript", from: "5.3.3", to: "5.4.0", type: "config" as const, package: null },
		];

		const body = generatePRBody(updates, []);

		expect(body).toContain("Config Dependencies");
		expect(body).toContain("`pnpm`");
		expect(body).toContain("10.28.2");
		expect(body).toContain("10.29.0");
		expect(body).toContain("`typescript`");
	});

	it("includes only pnpm upgrade when no other updates", () => {
		const body = generatePRBody([pnpmUpgradeUpdate], []);

		expect(body).toContain("Config Dependencies");
		expect(body).toContain("`pnpm`");
		expect(body).not.toContain("Regular Dependencies");
	});
});
