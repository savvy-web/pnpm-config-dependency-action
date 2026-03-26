import type { PullRequestError } from "@savvy-web/github-action-effects";
import { PullRequestTest } from "@savvy-web/github-action-effects";
import { Cause, Effect, Layer, LogLevel, Logger } from "effect";
import { describe, expect, it } from "vitest";
import { pnpmUpgradeUpdate } from "../utils/fixtures.test.js";
import { Report, ReportLive } from "./report.js";

// ══════════════════════════════════════════════════════════════════════════════
// Test Helpers
// ══════════════════════════════════════════════════════════════════════════════

const makeReportLayer = (state: ReturnType<typeof PullRequestTest.empty>) => {
	const prLayer = PullRequestTest.layer(state);
	return ReportLive.pipe(Layer.provide(prLayer));
};

// ══════════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════════

describe("createOrUpdatePR", () => {
	it("creates new PR when none exists", async () => {
		const state = PullRequestTest.empty();
		state.nextNumber = 42;
		const layer = makeReportLayer(state);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const report = yield* Report;
				return yield* report.createOrUpdatePR("pnpm/config", [], []);
			}).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
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
		const layer = makeReportLayer(state);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const report = yield* Report;
				return yield* report.createOrUpdatePR("pnpm/config", [], []);
			}).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(result.number).toBe(10);
		expect(result.created).toBe(false);
	});

	it("returns nodeId from created PR", async () => {
		const state = PullRequestTest.empty();
		state.nextNumber = 42;
		const layer = makeReportLayer(state);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const report = yield* Report;
				return yield* report.createOrUpdatePR("pnpm/config", [], []);
			}).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
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
		const layer = makeReportLayer(state);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const report = yield* Report;
				return yield* report.createOrUpdatePR("pnpm/config", [], []);
			}).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(result.nodeId).toBe("PR_kwDOExisting10");
	});

	it("passes autoMerge to getOrCreate", async () => {
		const state = PullRequestTest.empty();
		state.nextNumber = 50;
		const layer = makeReportLayer(state);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const report = yield* Report;
				return yield* report.createOrUpdatePR("pnpm/config", [], [], "squash");
			}).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(result.number).toBe(50);
		expect(result.created).toBe(true);
		// Verify auto-merge was set on the PR record
		expect(state.prs[0].autoMerge).toBe("squash");
	});

	it("logs created PR number when successful", async () => {
		const state = PullRequestTest.empty();
		state.nextNumber = 99;
		const layer = makeReportLayer(state);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const report = yield* Report;
				return yield* report.createOrUpdatePR("pnpm/config", [], []);
			}).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(result.number).toBe(99);
		expect(result.created).toBe(true);
	});

	it("returns PullRequestError in error channel on failure", async () => {
		// Force failure by making getOrCreate throw - use a layer that fails
		const failingPrLayer = Layer.succeed((await import("@savvy-web/github-action-effects")).PullRequest, {
			get: () => Effect.fail({ _tag: "PullRequestError", operation: "get", reason: "fail" } as PullRequestError),
			list: () => Effect.fail({ _tag: "PullRequestError", operation: "list", reason: "fail" } as PullRequestError),
			create: () => Effect.fail({ _tag: "PullRequestError", operation: "create", reason: "fail" } as PullRequestError),
			update: () => Effect.fail({ _tag: "PullRequestError", operation: "update", reason: "fail" } as PullRequestError),
			getOrCreate: () =>
				Effect.fail({
					_tag: "PullRequestError",
					operation: "getOrCreate",
					reason: "API rate limit exceeded",
				} as PullRequestError),
			merge: () => Effect.fail({ _tag: "PullRequestError", operation: "merge", reason: "fail" } as PullRequestError),
			addLabels: () =>
				Effect.fail({
					_tag: "PullRequestError",
					operation: "addLabels",
					reason: "fail",
				} as PullRequestError),
			requestReviewers: () =>
				Effect.fail({
					_tag: "PullRequestError",
					operation: "requestReviewers",
					reason: "fail",
				} as PullRequestError),
		} as unknown as typeof import("@savvy-web/github-action-effects")["PullRequest"]["Service"]);
		const layer = ReportLive.pipe(Layer.provide(failingPrLayer));

		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const report = yield* Report;
				return yield* report.createOrUpdatePR("pnpm/config", [], []);
			}).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(exit._tag).toBe("Failure");
		// The error should be a PullRequestError, not a sentinel value
		if (exit._tag === "Failure") {
			const failure = Cause.failureOption(exit.cause);
			expect(failure._tag).toBe("Some");
			if (failure._tag === "Some") {
				expect(failure.value._tag).toBe("PullRequestError");
				expect(failure.value.operation).toBe("getOrCreate");
				expect(failure.value.reason).toBe("API rate limit exceeded");
			}
		}
	});
});

describe("generatePRBody", () => {
	it("includes pnpm upgrade in root workspace table", async () => {
		const state = PullRequestTest.empty();
		const layer = makeReportLayer(state);

		const updates = [
			pnpmUpgradeUpdate,
			{ dependency: "typescript", from: "5.3.3", to: "5.4.0", type: "config" as const, package: null },
		];

		const body = await Effect.runPromise(
			Effect.gen(function* () {
				const report = yield* Report;
				return report.generatePRBody(updates, []);
			}).pipe(Effect.provide(layer)),
		);

		expect(body).toContain("### root workspace");
		expect(body).toContain("pnpm");
		expect(body).toContain("10.28.2");
		expect(body).toContain("10.29.0");
		expect(body).toContain("typescript");
	});

	it("includes only pnpm upgrade when no other updates", async () => {
		const state = PullRequestTest.empty();
		const layer = makeReportLayer(state);

		const body = await Effect.runPromise(
			Effect.gen(function* () {
				const report = yield* Report;
				return report.generatePRBody([pnpmUpgradeUpdate], []);
			}).pipe(Effect.provide(layer)),
		);

		expect(body).toContain("### root workspace");
		expect(body).toContain("pnpm");
	});
});
