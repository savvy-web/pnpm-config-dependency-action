import { describe, expect, it } from "@effect/vitest";
import { GitHubError, PullRequest, Repo, RepoRef } from "@effected/github";
import { Cause, Effect, Layer, References } from "effect";
import type { CatalogDelta } from "../../../src/schema/domain.js";
import { Report, ReportLive } from "../../../src/services/report.js";
import type { PullRequestTestState } from "../../utils/fixtures.js";
import { emptyPullRequestState, fakeSha, pnpmUpgradeUpdate, pullRequestTestLayer } from "../../utils/fixtures.js";

/** Every resource method resolves `Repo` per call, so tests provide one. */
const repoLayer = Repo.layer(RepoRef.make({ owner: "test", repo: "repo" }));

// ══════════════════════════════════════════════════════════════════════════════
// Test Helpers
// ══════════════════════════════════════════════════════════════════════════════

const makeReportLayer = (state: PullRequestTestState) =>
	Layer.merge(ReportLive.pipe(Layer.provide(pullRequestTestLayer(state))), repoLayer);

// ══════════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════════

describe("createOrUpdatePR", () => {
	it.effect("creates new PR when none exists", () =>
		Effect.gen(function* () {
			const state = emptyPullRequestState();
			state.nextNumber = 42;
			const layer = makeReportLayer(state);

			const result = yield* Effect.gen(function* () {
				const report = yield* Report;
				return yield* report.createOrUpdatePR("pnpm/config", "main", [], []);
			}).pipe(Effect.provide(layer), Effect.provideService(References.MinimumLogLevel, "None"));

			expect(result.number).toBe(42);
			expect(result.created).toBe(true);
		}),
	);

	it.effect("titles the PR from the run contents", () =>
		Effect.gen(function* () {
			const state = emptyPullRequestState();
			state.nextNumber = 7;
			const layer = makeReportLayer(state);

			yield* Effect.gen(function* () {
				const report = yield* Report;
				return yield* report.createOrUpdatePR(
					"pnpm/config",
					"main",
					[{ dependency: "pnpm", from: "11.6.0", to: "11.7.0", type: "config", package: null }],
					[],
				);
			}).pipe(Effect.provide(layer), Effect.provideService(References.MinimumLogLevel, "None"));

			const created = state.prs.find((p) => p.number === 7);
			expect(created?.title).toBe("chore(deps): upgrade pnpm to 11.7.0");
		}),
	);

	it.effect("refreshes the title of a reused PR to match the new contents", () =>
		Effect.gen(function* () {
			const state = emptyPullRequestState();
			state.prs.push({
				number: 10,
				url: "https://github.com/test/pull/10",
				nodeId: "PR_kwDOTest10",
				title: "chore(deps): Update Silk Dependencies",
				state: "open",
				head: "pnpm/config",
				headSha: fakeSha("head", 10),
				base: "main",
				baseSha: fakeSha("base", 10),
				draft: false,
				merged: false,
				autoMerge: undefined,
				body: "old body",
			});
			const layer = makeReportLayer(state);

			yield* Effect.gen(function* () {
				const report = yield* Report;
				return yield* report.createOrUpdatePR(
					"pnpm/config",
					"main",
					[{ dependency: "node", from: "^24.0.0", to: "^26.1.0", type: "runtime", package: null }],
					[],
				);
			}).pipe(Effect.provide(layer), Effect.provideService(References.MinimumLogLevel, "None"));

			const reused = state.prs.find((p) => p.number === 10);
			expect(reused?.title).toBe("chore(deps): upgrade Node to 26.1.0");
		}),
	);

	it.effect("updates existing PR when found", () =>
		Effect.gen(function* () {
			const state = emptyPullRequestState();
			state.prs.push({
				number: 10,
				url: "https://github.com/test/pull/10",
				nodeId: "PR_kwDOTest10",
				title: "old title",
				state: "open",
				head: "pnpm/config",
				headSha: fakeSha("head", 10),
				base: "main",
				baseSha: fakeSha("base", 10),
				draft: false,
				merged: false,
				autoMerge: undefined,
				body: "old body",
			});
			const layer = makeReportLayer(state);

			const result = yield* Effect.gen(function* () {
				const report = yield* Report;
				return yield* report.createOrUpdatePR("pnpm/config", "main", [], []);
			}).pipe(Effect.provide(layer), Effect.provideService(References.MinimumLogLevel, "None"));

			expect(result.number).toBe(10);
			expect(result.created).toBe(false);
		}),
	);

	it.effect("returns nodeId from created PR", () =>
		Effect.gen(function* () {
			const state = emptyPullRequestState();
			state.nextNumber = 42;
			const layer = makeReportLayer(state);

			const result = yield* Effect.gen(function* () {
				const report = yield* Report;
				return yield* report.createOrUpdatePR("pnpm/config", "main", [], []);
			}).pipe(Effect.provide(layer), Effect.provideService(References.MinimumLogLevel, "None"));

			expect(result.nodeId).toBeTruthy();
			expect(result.number).toBe(42);
		}),
	);

	it.effect("returns nodeId from existing PR", () =>
		Effect.gen(function* () {
			const state = emptyPullRequestState();
			state.prs.push({
				number: 10,
				url: "https://github.com/test/pull/10",
				nodeId: "PR_kwDOExisting10",
				title: "old title",
				state: "open",
				head: "pnpm/config",
				headSha: fakeSha("head", 10),
				base: "main",
				baseSha: fakeSha("base", 10),
				draft: false,
				merged: false,
				autoMerge: undefined,
				body: "old body",
			});
			const layer = makeReportLayer(state);

			const result = yield* Effect.gen(function* () {
				const report = yield* Report;
				return yield* report.createOrUpdatePR("pnpm/config", "main", [], []);
			}).pipe(Effect.provide(layer), Effect.provideService(References.MinimumLogLevel, "None"));

			expect(result.nodeId).toBe("PR_kwDOExisting10");
		}),
	);

	it.effect("passes autoMerge to getOrCreate", () =>
		Effect.gen(function* () {
			const state = emptyPullRequestState();
			state.nextNumber = 50;
			const layer = makeReportLayer(state);

			const result = yield* Effect.gen(function* () {
				const report = yield* Report;
				return yield* report.createOrUpdatePR("pnpm/config", "main", [], [], "squash");
			}).pipe(Effect.provide(layer), Effect.provideService(References.MinimumLogLevel, "None"));

			expect(result.number).toBe(50);
			expect(result.created).toBe(true);
			// Verify auto-merge was set on the PR record
			expect(state.prs[0].autoMerge).toBe("squash");
		}),
	);

	it.effect("logs created PR number when successful", () =>
		Effect.gen(function* () {
			const state = emptyPullRequestState();
			state.nextNumber = 99;
			const layer = makeReportLayer(state);

			const result = yield* Effect.gen(function* () {
				const report = yield* Report;
				return yield* report.createOrUpdatePR("pnpm/config", "main", [], []);
			}).pipe(Effect.provide(layer), Effect.provideService(References.MinimumLogLevel, "None"));

			expect(result.number).toBe(99);
			expect(result.created).toBe(true);
		}),
	);

	it.effect("returns GitHubError in error channel on failure", () =>
		Effect.gen(function* () {
			// Only `upsert` needs stubbing: every other member of the double dies
			// naming itself, which proves createOrUpdatePR touches nothing else.
			const failingPrLayer = PullRequest.layerTest({
				upsert: () =>
					Effect.fail(
						new GitHubError({
							kind: "rateLimited",
							operation: "pulls.upsert",
							reason: "API rate limit exceeded",
						}),
					),
			});
			const layer = Layer.merge(ReportLive.pipe(Layer.provide(failingPrLayer)), repoLayer);

			const exit = yield* Effect.exit(
				Effect.gen(function* () {
					const report = yield* Report;
					return yield* report.createOrUpdatePR("pnpm/config", "main", [], []);
				}).pipe(Effect.provide(layer), Effect.provideService(References.MinimumLogLevel, "None")),
			);

			expect(exit._tag).toBe("Failure");
			// The error propagates as a GitHubError, not a sentinel value. `_tag` is
			// "GitHubError" for every failure now, so `kind` is what discriminates.
			if (exit._tag === "Failure") {
				const failure = Cause.findErrorOption(exit.cause);
				expect(failure._tag).toBe("Some");
				if (failure._tag === "Some") {
					const error = failure.value as GitHubError;
					expect(error._tag).toBe("GitHubError");
					expect(error.kind).toBe("rateLimited");
					expect(error.operation).toBe("pulls.upsert");
				}
			}
		}),
	);
	it.effect("passes base to getOrCreate", () =>
		Effect.gen(function* () {
			const state = emptyPullRequestState();
			state.nextNumber = 7;
			const layer = makeReportLayer(state);

			yield* Effect.gen(function* () {
				const report = yield* Report;
				return yield* report.createOrUpdatePR("pnpm/config", "dev", [], []);
			}).pipe(Effect.provide(layer), Effect.provideService(References.MinimumLogLevel, "None"));

			expect(state.prs[0].base).toBe("dev");
		}),
	);

	it.effect("passes deltas into the rendered PR body", () =>
		Effect.gen(function* () {
			const state = emptyPullRequestState();
			state.nextNumber = 11;
			const layer = makeReportLayer(state);

			const deltas: ReadonlyArray<CatalogDelta> = [
				{ catalog: "silk", dependency: "effect", from: "^3.20.0", to: "^3.21.0", action: "updated" },
			];

			yield* Effect.gen(function* () {
				const report = yield* Report;
				return yield* report.createOrUpdatePR("pnpm/config", "main", [], [], undefined, deltas);
			}).pipe(Effect.provide(layer), Effect.provideService(References.MinimumLogLevel, "None"));

			const created = state.prs.find((p) => p.number === 11);
			expect(created?.body).toContain("### Catalog Changes");
		}),
	);
});

describe("generateCommitMessage", () => {
	it.effect("uses the varied subject and lists each update in the body", () =>
		Effect.gen(function* () {
			const state = emptyPullRequestState();
			const layer = makeReportLayer(state);

			const msg = yield* Effect.gen(function* () {
				const report = yield* Report;
				return report.generateCommitMessage([
					{ dependency: "node", from: "^24.0.0", to: "^24.16.0", type: "runtime", package: null },
				]);
			}).pipe(Effect.provide(layer), Effect.provideService(References.MinimumLogLevel, "None"));

			// Subject is the contents-aware headline (rule 2), not a count summary.
			// The range operator is stripped for a clean display version.
			expect(msg.split("\n")[0]).toBe("chore(deps): upgrade Node to 24.16.0");
			// Body still lists every update verbatim.
			expect(msg).toContain("- node: ^24.0.0 -> ^24.16.0");
			// Sign-off footer preserved.
			expect(msg).toContain("Signed-off-by: github-actions[bot] <");
		}),
	);

	it.effect("falls back to a generic subject when there are no updates", () =>
		Effect.gen(function* () {
			const state = emptyPullRequestState();
			const layer = makeReportLayer(state);

			const msg = yield* Effect.gen(function* () {
				const report = yield* Report;
				return report.generateCommitMessage([]);
			}).pipe(Effect.provide(layer), Effect.provideService(References.MinimumLogLevel, "None"));

			expect(msg.split("\n")[0]).toBe("chore(deps): update dependencies");
		}),
	);
});

describe("generatePRBody", () => {
	it.effect("includes pnpm upgrade in root workspace table", () =>
		Effect.gen(function* () {
			const state = emptyPullRequestState();
			const layer = makeReportLayer(state);

			const updates = [
				pnpmUpgradeUpdate,
				{ dependency: "typescript", from: "5.3.3", to: "5.4.0", type: "config" as const, package: null },
			];

			const body = yield* Effect.gen(function* () {
				const report = yield* Report;
				return report.generatePRBody(updates, []);
			}).pipe(Effect.provide(layer));

			expect(body).toContain("### root workspace");
			expect(body).toContain("pnpm");
			expect(body).toContain("10.28.2");
			expect(body).toContain("10.29.0");
			expect(body).toContain("typescript");
		}),
	);

	it.effect("includes only pnpm upgrade when no other updates", () =>
		Effect.gen(function* () {
			const state = emptyPullRequestState();
			const layer = makeReportLayer(state);

			const body = yield* Effect.gen(function* () {
				const report = yield* Report;
				return report.generatePRBody([pnpmUpgradeUpdate], []);
			}).pipe(Effect.provide(layer));

			expect(body).toContain("### root workspace");
			expect(body).toContain("pnpm");
		}),
	);

	it.effect("renders a Catalog Changes section grouped by catalog, excluding kept deltas", () =>
		Effect.gen(function* () {
			const state = emptyPullRequestState();
			const layer = makeReportLayer(state);

			const deltas: ReadonlyArray<CatalogDelta> = [
				{ catalog: "silk", dependency: "effect", from: "^3.20.0", to: "^3.21.0", action: "updated" },
				{ catalog: "silk", dependency: "zod", from: null, to: "^3.24.0", action: "added" },
				{ catalog: "silk", dependency: "lodash", from: "^4.17.0", to: null, action: "removed" },
				// A "kept" delta is a surviving user override, not a change — it must not
				// appear in the rendered table, or every run would show it as news.
				{ catalog: "silk", dependency: "typescript", from: "5.0.2", to: "5.0.2", action: "kept" },
				{ catalog: "default", dependency: "chalk", from: "^4.0.0", to: "^5.0.0", action: "updated" },
			];

			const body = yield* Effect.gen(function* () {
				const report = yield* Report;
				return report.generatePRBody([], [], deltas);
			}).pipe(Effect.provide(layer));

			expect(body).toContain("### Catalog Changes");
			expect(body).toContain("#### silk catalog");
			expect(body).toContain("#### default catalog");
			expect(body).toContain("effect");
			expect(body).toContain("zod");
			expect(body).toContain("lodash");
			expect(body).toContain("chalk");
			expect(body).not.toContain("typescript");
		}),
	);

	it.effect("omits the Catalog Changes section entirely when every delta is kept", () =>
		Effect.gen(function* () {
			const state = emptyPullRequestState();
			const layer = makeReportLayer(state);

			const deltas: ReadonlyArray<CatalogDelta> = [
				{ catalog: "silk", dependency: "typescript", from: "5.0.2", to: "5.0.2", action: "kept" },
			];

			const body = yield* Effect.gen(function* () {
				const report = yield* Report;
				return report.generatePRBody([], [], deltas);
			}).pipe(Effect.provide(layer));

			expect(body).not.toContain("Catalog Changes");
		}),
	);

	it.effect("produces byte-for-byte the same body whether deltas is omitted or an empty array", () =>
		Effect.gen(function* () {
			const state = emptyPullRequestState();
			const layer = makeReportLayer(state);

			const updates = [pnpmUpgradeUpdate];

			const [omitted, empty] = yield* Effect.gen(function* () {
				const report = yield* Report;
				return [report.generatePRBody(updates, []), report.generatePRBody(updates, [], [])] as const;
			}).pipe(Effect.provide(layer));

			expect(omitted).toBe(empty);
		}),
	);
});

describe("generateSummary", () => {
	it.effect("renders a Catalog Changes section grouped by catalog, excluding kept deltas", () =>
		Effect.gen(function* () {
			const state = emptyPullRequestState();
			const layer = makeReportLayer(state);

			const deltas: ReadonlyArray<CatalogDelta> = [
				{ catalog: "silk", dependency: "effect", from: "^3.20.0", to: "^3.21.0", action: "updated" },
				{ catalog: "silk", dependency: "typescript", from: "5.0.2", to: "5.0.2", action: "kept" },
			];

			const summary = yield* Effect.gen(function* () {
				const report = yield* Report;
				return report.generateSummary([], [], null, false, deltas);
			}).pipe(Effect.provide(layer));

			expect(summary).toContain("### Catalog Changes");
			expect(summary).toContain("#### silk catalog");
			expect(summary).toContain("effect");
			expect(summary).not.toContain("typescript");
		}),
	);

	it.effect("produces byte-for-byte the same summary whether deltas is omitted or an empty array", () =>
		Effect.gen(function* () {
			const state = emptyPullRequestState();
			const layer = makeReportLayer(state);

			const updates = [pnpmUpgradeUpdate];

			const [omitted, empty] = yield* Effect.gen(function* () {
				const report = yield* Report;
				return [
					report.generateSummary(updates, [], null, false),
					report.generateSummary(updates, [], null, false, []),
				] as const;
			}).pipe(Effect.provide(layer));

			expect(omitted).toBe(empty);
		}),
	);

	it.effect("threads deltas into the dry-run PR body preview", () =>
		Effect.gen(function* () {
			const state = emptyPullRequestState();
			const layer = makeReportLayer(state);

			const deltas: ReadonlyArray<CatalogDelta> = [
				{ catalog: "silk", dependency: "effect", from: "^3.20.0", to: "^3.21.0", action: "updated" },
			];

			const summary = yield* Effect.gen(function* () {
				const report = yield* Report;
				return report.generateSummary([pnpmUpgradeUpdate], [], null, true, deltas);
			}).pipe(Effect.provide(layer));

			expect(summary).toContain("### PR Body Preview");
			expect(summary).toContain("Catalog Changes");
		}),
	);
});
