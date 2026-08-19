import { InstallationToken } from "@effected/github";
import { ActionState } from "@effected/github-actions";
import { DateTime, Effect, Layer, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { Report } from "../../src/services/report.js";
import { cleanVersion, npmUrl } from "../../src/utils/markdown.js";
import { actionStateTestLayer, emptyActionState } from "../utils/action-doubles.js";
import {
	configUpdate,
	configUpdateNew,
	configUpdates,
	emptyPullRequestState,
	mixedUpdates,
	packageChangeset,
	pullRequest,
	pullRequestTestLayer,
	regularUpdate,
	regularUpdateGlob,
	regularUpdates,
	rootChangeset,
} from "../utils/fixtures.js";

/**
 * An `ActionState` whose `get` answers with a real `InstallationToken`.
 *
 * A real `InstallationToken.make(...)` rather than a structurally-correct
 * literal: `botIdentity()` is a method on the class, so a plain object
 * typechecks through the double and then fails at runtime.
 */
const stateWithToken = (identity: { appSlug: string; appName: string }): Layer.Layer<ActionState> =>
	ActionState.layerTest({
		get: (() =>
			Effect.succeed(
				InstallationToken.make({
					token: Redacted.make("ghs_test_token_123"),
					expiresAt: DateTime.makeUnsafe("2030-01-01T01:00:00Z"),
					installationId: 4242,
					permissions: {},
					...identity,
				}),
			)) as ActionState["Service"]["get"],
	});

/**
 * Helper to run a Report service method.
 */
const withReport = <A>(
	fn: (report: Effect.Success<typeof Report>) => A,
	actionState: Layer.Layer<ActionState> = actionStateTestLayer(emptyActionState()),
): Promise<A> => {
	const state = emptyPullRequestState();
	const layer = Report.layer.pipe(Layer.provide(Layer.merge(pullRequestTestLayer(state), actionState)));
	return Effect.runPromise(
		Effect.gen(function* () {
			const report = yield* Report;
			return fn(report);
		}).pipe(Effect.provide(layer)),
	);
};

describe("cleanVersion", () => {
	it("strips +sha512-... suffix", () => {
		expect(cleanVersion("5.4.0+sha512-abc123def")).toBe("5.4.0");
	});

	it("returns null for null input", () => {
		expect(cleanVersion(null)).toBe(null);
	});

	it("returns version unchanged if no + suffix", () => {
		expect(cleanVersion("5.4.0")).toBe("5.4.0");
	});

	it("handles empty string", () => {
		expect(cleanVersion("")).toBe(null);
	});
});

describe("npmUrl", () => {
	it("returns correct npm URL for scoped package", () => {
		expect(npmUrl("@savvy-web/core")).toBe("https://www.npmjs.com/package/@savvy-web/core");
	});

	it("returns correct npm URL for unscoped package", () => {
		expect(npmUrl("typescript")).toBe("https://www.npmjs.com/package/typescript");
	});
});

describe("generateCommitMessage", () => {
	it("generates message for config-only updates", async () => {
		const message = await withReport((r) => r.generateCommitMessage(configUpdates));

		expect(message).toContain("chore(deps): update 2 config dependencies");
		expect(message).toContain("- typescript: 5.3.3 -> 5.4.0");
		expect(message).toContain("- @biomejs/biome: new -> 1.6.1");
	});

	it("generates message for dev-only updates", async () => {
		const message = await withReport((r) => r.generateCommitMessage(regularUpdates));

		expect(message).toContain("chore(deps): update 2 devDependencies");
		expect(message).toContain("- effect: 3.0.0 -> 3.1.0");
	});

	it("generates message for mixed updates", async () => {
		const message = await withReport((r) => r.generateCommitMessage(mixedUpdates));

		expect(message).toContain("chore(deps): update 2 config dependencies and 2 devDependencies");
	});

	// The sign-off used to be a `signoffLine(appSlug?)` parameter that NOTHING
	// ever passed — `steps/commit-and-pr.ts` calls `generateCommitMessage` with
	// updates only — so the App-bot branch was reachable from this suite and
	// from nowhere else, and every real run signed as `github-actions[bot]`
	// while the App bot authored the commit. It now comes from the persisted
	// token, so these two cases assert the identity the RUN would use.
	it("signs off as the App bot named by the persisted token", async () => {
		const message = await withReport(
			(r) => r.generateCommitMessage(configUpdates),
			stateWithToken({ appSlug: "my-app", appName: "My App" }),
		);

		expect(message).toContain("Signed-off-by: my-app[bot] <my-app[bot]@users.noreply.github.com>");
	});

	it("falls back to github-actions[bot] when no token is persisted", async () => {
		const message = await withReport((r) => r.generateCommitMessage(configUpdates));

		expect(message).toContain(
			"Signed-off-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
		);
	});
});

describe("generatePRBody", () => {
	it("generates body with per-package tables", async () => {
		const body = await withReport((r) => r.generatePRBody(configUpdates, []));

		expect(body).toContain("### root workspace");
		expect(body).toContain("| Dependency | Type | Action | From | To |");
		expect(body).toContain("typescript");
		expect(body).toContain("5.3.3");
		expect(body).toContain("5.4.0");
	});

	it("groups regular dependencies by package", async () => {
		const body = await withReport((r) => r.generatePRBody([regularUpdate], []));

		expect(body).toContain("### @savvy-web/core");
		expect(body).toContain("effect");
		expect(body).toContain("devDependency");
	});

	it("generates body with multiple package sections for mixed updates", async () => {
		const body = await withReport((r) => r.generatePRBody(mixedUpdates, []));

		expect(body).toContain("### root workspace");
		expect(body).toContain("### @savvy-web/core");
	});

	it("includes changeset details sections", async () => {
		const body = await withReport((r) => r.generatePRBody(configUpdates, [packageChangeset, rootChangeset]));

		expect(body).toContain("### Changesets");
		expect(body).toContain("2 changeset(s) created");
		expect(body).toContain("<summary>@savvy-web/core</summary>");
		expect(body).toContain("<summary>root workspace</summary>");
	});

	it("shows glob patterns in dependency column", async () => {
		const body = await withReport((r) => r.generatePRBody([regularUpdateGlob], []));

		expect(body).toContain("@effect/*");
	});

	it("includes footer", async () => {
		const body = await withReport((r) => r.generatePRBody(configUpdates, []));

		expect(body).toContain("---");
		expect(body).toContain("silk-update-action");
	});

	it("shows added action for new dependencies", async () => {
		const body = await withReport((r) => r.generatePRBody([configUpdateNew], []));

		expect(body).toContain("added");
		expect(body).toContain("\u2014");
	});
});

describe("generateSummary", () => {
	it("generates summary with PR link", async () => {
		const result = await withReport((r) => r.generateSummary(configUpdates, [], pullRequest, false));

		expect(result).toContain(`[#42](${pullRequest.url})`);
		expect(result).toContain("**Dependencies updated:** 2");
	});

	it("generates summary without PR (null)", async () => {
		const result = await withReport((r) => r.generateSummary(configUpdates, [], null, false));

		expect(result).not.toContain("Pull request:");
		expect(result).toContain("**Dependencies updated:** 2");
	});

	it("generates dry-run summary with PR body preview", async () => {
		const result = await withReport((r) => r.generateSummary(mixedUpdates, [], null, true));

		expect(result).toContain("### PR Body Preview");
		expect(result).toContain("View PR body");
	});

	it("does not show PR body preview when not dry-run", async () => {
		const result = await withReport((r) => r.generateSummary(mixedUpdates, [], pullRequest, false));

		expect(result).not.toContain("PR Body Preview");
	});

	it("shows changeset details", async () => {
		const result = await withReport((r) =>
			r.generateSummary(configUpdates, [packageChangeset, rootChangeset], null, false),
		);

		expect(result).toContain("### Changesets Created");
		expect(result).toContain("**Changesets created:** 2");
	});

	it("shows per-package tables in summary", async () => {
		const updates = [configUpdate, regularUpdate];
		const result = await withReport((r) => r.generateSummary(updates, [], null, false));

		expect(result).toContain("root workspace");
		expect(result).toContain("@savvy-web/core");
		expect(result).toContain("| Dependency | Type | Action | From | To |");
	});
});
