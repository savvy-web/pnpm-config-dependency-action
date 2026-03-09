import type { CommandRunnerError, GitHubClientError } from "@savvy-web/github-action-effects";
import { CommandRunner, GitHubClient } from "@savvy-web/github-action-effects";
import { Effect, Layer, LogLevel, Logger } from "effect";
import { describe, expect, it } from "vitest";
import { pnpmUpgradeUpdate } from "./lib/__test__/fixtures.js";
import { createOrUpdatePR, generatePRBody, runCommands } from "./main.js";

// ══════════════════════════════════════════════════════════════════════════════
// Test Helpers
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Create a mock CommandRunner service.
 */
const makeTestRunner = (
	overrides: Partial<{
		exec: CommandRunner["exec"];
		execCapture: CommandRunner["execCapture"];
		execJson: CommandRunner["execJson"];
		execLines: CommandRunner["execLines"];
	}> = {},
): Layer.Layer<CommandRunner> => {
	const service: CommandRunner = {
		exec: () => Effect.succeed(0),
		execCapture: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
		execJson: () => Effect.succeed(null as never),
		execLines: () => Effect.succeed([]),
		...overrides,
	};
	return Layer.succeed(CommandRunner, service);
};

/**
 * Create a mock GitHubClient layer that invokes the `fn` callback
 * passed to `rest()`, exercising the inner Octokit callback code paths
 * in functions like `createOrUpdatePR`.
 */
const makeTestGitHubClient = (config?: {
	pullsList?: Array<{ number: number; html_url: string; node_id: string }>;
	pullsCreate?: { number: number; html_url: string; node_id: string };
	pullsCreateError?: boolean;
	pullsUpdateError?: boolean;
}): Layer.Layer<GitHubClient> => {
	const fakeOctokit = {
		rest: {
			pulls: {
				list: async () => ({ data: config?.pullsList ?? [] }),
				create: async () => {
					if (config?.pullsCreateError) throw new Error("create failed");
					return {
						data: config?.pullsCreate ?? { number: 0, html_url: "", node_id: "" },
					};
				},
				update: async () => {
					if (config?.pullsUpdateError) throw new Error("update failed");
					return { data: {} };
				},
			},
		},
	};

	const service: GitHubClient = {
		rest: (_op, fn) =>
			Effect.tryPromise({
				try: () => fn(fakeOctokit as never).then((r) => (r as { data: unknown }).data),
				catch: (e) =>
					({
						_tag: "GitHubClientError",
						operation: _op,
						statusCode: 500,
						reason: String(e),
					}) as unknown as GitHubClientError,
			}),
		graphql: () => Effect.succeed(null as never),
		paginate: () => Effect.succeed([]),
		repo: Effect.succeed({ owner: "test-owner", repo: "test-repo" }),
	};
	return Layer.succeed(GitHubClient, service);
};

// ══════════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════════

describe("runCommands", () => {
	it("returns empty result for empty commands", async () => {
		const layer = makeTestRunner();
		const result = await Effect.runPromise(
			runCommands([]).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);
		expect(result.successful).toEqual([]);
		expect(result.failed).toEqual([]);
	});

	it("runs each command sequentially", async () => {
		const commandOrder: string[] = [];

		const layer = makeTestRunner({
			execCapture: (_cmd, args) => {
				// The command is passed via sh -c, so args[1] is the actual command
				const actualCmd = args?.[1] ?? "";
				commandOrder.push(actualCmd as string);
				return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
			},
		});

		const result = await Effect.runPromise(
			runCommands(["pnpm lint:fix", "pnpm test"]).pipe(
				Effect.provide(layer),
				Logger.withMinimumLogLevel(LogLevel.None),
			),
		);

		expect(commandOrder).toEqual(["pnpm lint:fix", "pnpm test"]);
		expect(result.successful).toEqual(["pnpm lint:fix", "pnpm test"]);
		expect(result.failed).toEqual([]);
	});

	it("collects failed commands with error details", async () => {
		const layer = makeTestRunner({
			execCapture: () =>
				Effect.fail({
					_tag: "CommandRunnerError",
					command: "sh",
					exitCode: 1,
					reason: "lint errors",
				} as unknown as CommandRunnerError),
		});

		const result = await Effect.runPromise(
			runCommands(["pnpm lint:fix"]).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(result.successful).toEqual([]);
		expect(result.failed).toHaveLength(1);
		expect(result.failed[0].command).toBe("pnpm lint:fix");
		expect(result.failed[0].error).toContain("lint errors");
	});

	it("continues after failure (all commands run)", async () => {
		const layer = makeTestRunner({
			execCapture: (_cmd, args) => {
				const actualCmd = args?.[1] ?? "";
				if (actualCmd === "pnpm test") {
					return Effect.fail({
						_tag: "CommandRunnerError",
						command: "sh",
						exitCode: 1,
						reason: "test fail",
					} as unknown as CommandRunnerError);
				}
				return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
			},
		});

		const result = await Effect.runPromise(
			runCommands(["pnpm lint", "pnpm test", "pnpm build"]).pipe(
				Effect.provide(layer),
				Logger.withMinimumLogLevel(LogLevel.None),
			),
		);

		expect(result.successful).toEqual(["pnpm lint", "pnpm build"]);
		expect(result.failed).toHaveLength(1);
		expect(result.failed[0].command).toBe("pnpm test");
	});
});

describe("createOrUpdatePR", () => {
	it("creates new PR when none exists", async () => {
		const layer = makeTestGitHubClient({
			pullsList: [],
			pullsCreate: {
				number: 42,
				html_url: "https://github.com/test/pull/42",
				node_id: "PR_kwDOTest42",
			},
		});

		const result = await Effect.runPromise(
			createOrUpdatePR("pnpm/config", [], []).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(result.number).toBe(42);
		expect(result.created).toBe(true);
	});

	it("updates existing PR when found", async () => {
		const layer = makeTestGitHubClient({
			pullsList: [
				{
					number: 10,
					html_url: "https://github.com/test/pull/10",
					node_id: "PR_kwDOTest10",
				},
			],
		});

		const result = await Effect.runPromise(
			createOrUpdatePR("pnpm/config", [], []).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(result.number).toBe(10);
		expect(result.created).toBe(false);
	});

	it("handles create API failure gracefully (returns zero PR)", async () => {
		const layer = makeTestGitHubClient({
			pullsList: [],
			pullsCreateError: true,
		});

		const result = await Effect.runPromise(
			createOrUpdatePR("pnpm/config", [], []).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(result.number).toBe(0);
	});

	it("returns nodeId from created PR", async () => {
		const layer = makeTestGitHubClient({
			pullsList: [],
			pullsCreate: {
				number: 42,
				html_url: "https://github.com/test/pull/42",
				node_id: "PR_kwDOTestNode42",
			},
		});

		const result = await Effect.runPromise(
			createOrUpdatePR("pnpm/config", [], []).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(result.nodeId).toBe("PR_kwDOTestNode42");
	});

	it("returns nodeId from existing PR", async () => {
		const layer = makeTestGitHubClient({
			pullsList: [
				{
					number: 10,
					html_url: "https://github.com/test/pull/10",
					node_id: "PR_kwDOExisting10",
				},
			],
		});

		const result = await Effect.runPromise(
			createOrUpdatePR("pnpm/config", [], []).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(result.nodeId).toBe("PR_kwDOExisting10");
	});

	it("returns empty nodeId on create failure", async () => {
		const layer = makeTestGitHubClient({
			pullsList: [],
			pullsCreateError: true,
		});

		const result = await Effect.runPromise(
			createOrUpdatePR("pnpm/config", [], []).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(result.nodeId).toBe("");
	});

	it("handles pulls.update failure gracefully", async () => {
		const layer = makeTestGitHubClient({
			pullsList: [
				{
					number: 10,
					html_url: "https://github.com/test/pull/10",
					node_id: "PR_kwDOTest10",
				},
			],
			pullsUpdateError: true,
		});

		const result = await Effect.runPromise(
			createOrUpdatePR("pnpm/config", [], []).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		// Should still return the existing PR info even if update fails
		expect(result.number).toBe(10);
		expect(result.created).toBe(false);
		expect(result.nodeId).toBe("PR_kwDOTest10");
	});

	it("handles pulls.list API failure gracefully (creates new PR)", async () => {
		const service: GitHubClient = {
			rest: (_op, _fn) =>
				_op === "pulls.list"
					? Effect.fail({
							_tag: "GitHubClientError",
							operation: "pulls.list",
							statusCode: 500,
							reason: "API down",
						} as unknown as GitHubClientError)
					: Effect.tryPromise({
							try: () =>
								_fn({
									rest: {
										pulls: {
											create: async () => ({
												data: { number: 77, html_url: "https://github.com/test/pull/77", node_id: "PR_kwDO77" },
											}),
										},
									},
								} as never).then((r) => (r as { data: unknown }).data),
							catch: (e) =>
								({
									_tag: "GitHubClientError",
									operation: _op,
									statusCode: 500,
									reason: String(e),
								}) as unknown as GitHubClientError,
						}),
			graphql: () => Effect.succeed(null as never),
			paginate: () => Effect.succeed([]),
			repo: Effect.succeed({ owner: "test-owner", repo: "test-repo" }),
		};
		const layer = Layer.succeed(GitHubClient, service);

		const result = await Effect.runPromise(
			createOrUpdatePR("pnpm/config", [], []).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		// When list fails, existingPR is null, so it creates a new PR
		expect(result.number).toBe(77);
		expect(result.created).toBe(true);
	});

	it("logs created PR number when successful", async () => {
		const layer = makeTestGitHubClient({
			pullsList: [],
			pullsCreate: {
				number: 99,
				html_url: "https://github.com/test/pull/99",
				node_id: "PR_kwDOTest99",
			},
		});

		const result = await Effect.runPromise(
			createOrUpdatePR("pnpm/config", [], []).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(result.number).toBe(99);
		expect(result.url).toBe("https://github.com/test/pull/99");
		expect(result.created).toBe(true);
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
