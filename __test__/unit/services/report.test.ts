import { describe, expect, it } from "@effect/vitest";
import { GitHubError, PullRequest, Repo, RepoRef } from "@effected/github";
import { Cause, Effect, Layer, References } from "effect";
import type { CatalogDelta } from "../../../src/schema/domain.js";
import { Report } from "../../../src/services/report.js";
import { actionStateTestLayer, emptyActionState } from "../../utils/action-doubles.js";
import type { PullRequestTestState } from "../../utils/fixtures.js";
import { emptyPullRequestState, fakeSha, pnpmUpgradeUpdate, pullRequestTestLayer } from "../../utils/fixtures.js";

/** Every resource method resolves `Repo` per call, so tests provide one. */
const repoLayer = Repo.layer(RepoRef.make({ owner: "test", repo: "repo" }));

// ══════════════════════════════════════════════════════════════════════════════
// Test Helpers
// ══════════════════════════════════════════════════════════════════════════════

/**
 * `Report.layer` resolves the DCO sign-off in its layer body, so it needs an
 * `ActionState` to read the persisted token from. The double holds no token, so
 * `resolveSignoff` takes its documented outer fallback and every assertion below
 * sees `BotIdentity.githubActions` — byte-identical to what the hand-rolled
 * `signoffLine()` this replaced produced with no slug, which is why the sign-off
 * assertions in this file did not have to move.
 */
const makeReportLayer = (state: PullRequestTestState) =>
	Layer.merge(
		Report.layer.pipe(
			Layer.provide(Layer.merge(pullRequestTestLayer(state), actionStateTestLayer(emptyActionState()))),
		),
		repoLayer,
	);

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

	// ── The carry-through contract (#240) ──────────────────────────────────────
	//
	// These are the point of adopting ManagedPrBody. The mechanism is easy to wire
	// up and have do nothing: if the prior body were never read, every one of the
	// tests above would still pass while a human's notes were destroyed on every
	// run. So the capability is asserted directly.

	const prWithBody = (body: string | undefined) => {
		const state = emptyPullRequestState();
		state.prs.push({
			number: 7,
			url: "https://github.com/test/pull/7",
			nodeId: "PR_kwDOTest7",
			title: "old title",
			state: "open",
			head: "pnpm/config",
			headSha: fakeSha("head", 7),
			base: "main",
			baseSha: fakeSha("base", 7),
			draft: false,
			merged: false,
			autoMerge: undefined,
			body,
		});
		return state;
	};

	it.effect("PRESERVES human prose written outside the managed markers", () =>
		Effect.gen(function* () {
			const humanNote = "Reviewer note: hold this until the release freeze lifts.";
			const state = prWithBody(
				`${humanNote}\n\n<!-- silk-release:start -->\nstale generated content\n<!-- silk-release:end -->`,
			);
			const layer = makeReportLayer(state);

			yield* Effect.gen(function* () {
				const report = yield* Report;
				return yield* report.createOrUpdatePR("pnpm/config", "main", [], []);
			}).pipe(Effect.provide(layer), Effect.provideService(References.MinimumLogLevel, "None"));

			const written = state.prs[0].body;
			// The capability #240 adds: the note survives a regeneration.
			expect(written).toContain(humanNote);
			// And the previous generated content does NOT — it is regenerated, not
			// carried, because the dependency tables describe THIS run.
			expect(written).not.toContain("stale generated content");
		}),
	);

	it.effect("puts this run's generated content inside the managed region", () =>
		Effect.gen(function* () {
			const state = prWithBody("");
			const layer = makeReportLayer(state);

			yield* Effect.gen(function* () {
				const report = yield* Report;
				return yield* report.createOrUpdatePR("pnpm/config", "main", [pnpmUpgradeUpdate], []);
			}).pipe(Effect.provide(layer), Effect.provideService(References.MinimumLogLevel, "None"));

			const written = state.prs[0].body;
			expect(written).toContain("<!-- silk-release:start -->");
			expect(written).toContain("<!-- silk-release:end -->");
			// The dependency the run updated is reported inside it.
			expect(written).toContain("pnpm");
		}),
	);

	it.effect("handles an ABSENT body, which is how GitHub reports an empty description", () =>
		Effect.gen(function* () {
			// PullRequestInfo.body is optional-ABSENT, not "" — GitHub sends
			// `body: null` and the projection drops the key. ReleaseInfo and
			// CommentRecord coalesce null to "" on a REQUIRED body; PullRequestInfo
			// is the odd one out, so a test asserting "" here would pin the wrong
			// convention and still look correct.
			const state = prWithBody(undefined);
			const layer = makeReportLayer(state);

			const result = yield* Effect.gen(function* () {
				const report = yield* Report;
				return yield* report.createOrUpdatePR("pnpm/config", "main", [pnpmUpgradeUpdate], []);
			}).pipe(Effect.provide(layer), Effect.provideService(References.MinimumLogLevel, "None"));

			expect(result.number).toBe(7);
			expect(state.prs[0].body).toContain("<!-- silk-release:start -->");
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
				list: () => Effect.succeed([]),
				upsert: () =>
					Effect.fail(
						new GitHubError({
							kind: "rateLimited",
							operation: "pulls.upsert",
							reason: "API rate limit exceeded",
						}),
					),
			});
			const layer = Layer.merge(
				Report.layer.pipe(Layer.provide(Layer.merge(failingPrLayer, actionStateTestLayer(emptyActionState())))),
				repoLayer,
			);

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

describe("generatePRBody — peer issues", () => {
	const unmet = {
		importer: "packages/app",
		dependency: "react",
		wanted: "^18.3.1",
		found: "17.0.2",
		optional: false,
		parents: ["react-dom@18.3.1"],
	};

	it.effect("renders unsatisfied peers as a table naming who wanted them", () =>
		Effect.gen(function* () {
			const body = yield* Effect.gen(function* () {
				const report = yield* Report;
				return report.generatePRBody([], [], [], [unmet]);
			}).pipe(Effect.provide(makeReportLayer(emptyPullRequestState())));

			expect(body).toContain("Peer Dependencies");
			expect(body).toContain("react");
			expect(body).toContain("^18.3.1");
			expect(body).toContain("17.0.2");
			// The parent chain is the actionable half: "react is wrong" is not a
			// bug report, "react-dom wants a react you do not have" is.
			expect(body).toContain("react-dom@18.3.1");
		}),
	);

	// `found: null` IS the missing case. Rendering a raw null into someone
	// else's pull request is the visible half of that modelling decision.
	it.effect("renders a missing peer without printing a null", () =>
		Effect.gen(function* () {
			const body = yield* Effect.gen(function* () {
				const report = yield* Report;
				return report.generatePRBody([], [], [], [{ ...unmet, found: null }]);
			}).pipe(Effect.provide(makeReportLayer(emptyPullRequestState())));

			expect(body).toContain("react");
			expect(body).not.toContain("null");
		}),
	);

	it.effect("omits the section entirely when there are no peer issues", () =>
		Effect.gen(function* () {
			const body = yield* Effect.gen(function* () {
				const report = yield* Report;
				return report.generatePRBody([], [], [], []);
			}).pipe(Effect.provide(makeReportLayer(emptyPullRequestState())));

			expect(body).not.toContain("Peer Dependencies");
		}),
	);
});
