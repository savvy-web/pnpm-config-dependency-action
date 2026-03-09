import type { CommandRunnerError } from "@savvy-web/github-action-effects";
import { CommandRunner, PullRequestTest } from "@savvy-web/github-action-effects";
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
		const state = PullRequestTest.empty();
		state.nextNumber = 42;
		const layer = PullRequestTest.layer(state);

		const result = await Effect.runPromise(
			createOrUpdatePR("pnpm/config", [], []).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(result.number).toBe(42);
		expect(result.created).toBe(true);
	});

	it("updates existing PR when found", async () => {
		const state = PullRequestTest.empty();
		state.prs.push({
			number: 10,
			url: "https://github.com/test/pull/10",
			nodeId: "PR_kwDOTest10",
			title: "old title",
			state: "open",
			head: "pnpm/config",
			base: "main",
			draft: false,
			merged: false,
			labels: [],
			reviewers: [],
			teamReviewers: [],
			autoMerge: undefined,
			body: "old body",
		});
		const layer = PullRequestTest.layer(state);

		const result = await Effect.runPromise(
			createOrUpdatePR("pnpm/config", [], []).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(result.number).toBe(10);
		expect(result.created).toBe(false);
	});

	it("returns nodeId from created PR", async () => {
		const state = PullRequestTest.empty();
		state.nextNumber = 42;
		const layer = PullRequestTest.layer(state);

		const result = await Effect.runPromise(
			createOrUpdatePR("pnpm/config", [], []).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(result.nodeId).toBeTruthy();
		expect(result.number).toBe(42);
	});

	it("returns nodeId from existing PR", async () => {
		const state = PullRequestTest.empty();
		state.prs.push({
			number: 10,
			url: "https://github.com/test/pull/10",
			nodeId: "PR_kwDOExisting10",
			title: "old title",
			state: "open",
			head: "pnpm/config",
			base: "main",
			draft: false,
			merged: false,
			labels: [],
			reviewers: [],
			teamReviewers: [],
			autoMerge: undefined,
			body: "old body",
		});
		const layer = PullRequestTest.layer(state);

		const result = await Effect.runPromise(
			createOrUpdatePR("pnpm/config", [], []).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(result.nodeId).toBe("PR_kwDOExisting10");
	});

	it("passes autoMerge to getOrCreate", async () => {
		const state = PullRequestTest.empty();
		state.nextNumber = 50;
		const layer = PullRequestTest.layer(state);

		const result = await Effect.runPromise(
			createOrUpdatePR("pnpm/config", [], [], "squash").pipe(
				Effect.provide(layer),
				Logger.withMinimumLogLevel(LogLevel.None),
			),
		);

		expect(result.number).toBe(50);
		expect(result.created).toBe(true);
		// Verify auto-merge was set on the PR record
		expect(state.prs[0].autoMerge).toBe("squash");
	});

	it("logs created PR number when successful", async () => {
		const state = PullRequestTest.empty();
		state.nextNumber = 99;
		const layer = PullRequestTest.layer(state);

		const result = await Effect.runPromise(
			createOrUpdatePR("pnpm/config", [], []).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(result.number).toBe(99);
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
