import { PullRequestTest } from "@savvy-web/github-action-effects";
import type { Context } from "effect";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { Report, ReportLive } from "./services/report.js";
import {
	configUpdate,
	configUpdateNew,
	configUpdates,
	mixedUpdates,
	packageChangeset,
	pullRequest,
	regularUpdateGlob,
	regularUpdates,
	rootChangeset,
} from "./utils/fixtures.test.js";
import { cleanVersion, npmUrl } from "./utils/markdown.js";

/**
 * Helper to run a Report service method.
 */
const withReport = <A>(fn: (report: Context.Tag.Service<typeof Report>) => A): Promise<A> => {
	const state = PullRequestTest.empty();
	const layer = ReportLive.pipe(Layer.provide(PullRequestTest.layer(state)));
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
		const message = await withReport((r) => r.generateCommitMessage(configUpdates, "my-app"));

		expect(message).toContain("chore(deps): update 2 config dependencies");
		expect(message).toContain("- typescript: 5.3.3 -> 5.4.0");
		expect(message).toContain("- @biomejs/biome: new -> 1.6.1");
	});

	it("generates message for regular-only updates", async () => {
		const message = await withReport((r) => r.generateCommitMessage(regularUpdates, "my-app"));

		expect(message).toContain("chore(deps): update 2 regular dependencies");
		expect(message).toContain("- effect: 3.0.0 -> 3.1.0");
	});

	it("generates message for mixed updates", async () => {
		const message = await withReport((r) => r.generateCommitMessage(mixedUpdates, "my-app"));

		expect(message).toContain("chore(deps): update 2 config and 2 regular dependencies");
	});

	it("includes sign-off with app slug", async () => {
		const message = await withReport((r) => r.generateCommitMessage(configUpdates, "my-app"));

		expect(message).toContain("Signed-off-by: my-app[bot] <my-app[bot]@users.noreply.github.com>");
	});

	it("falls back to github-actions[bot] when no app slug", async () => {
		const message = await withReport((r) => r.generateCommitMessage(configUpdates));

		expect(message).toContain("Signed-off-by: github-actions[bot]");
	});
});

describe("generatePRBody", () => {
	it("generates body with config dependencies table", async () => {
		const body = await withReport((r) => r.generatePRBody(configUpdates, []));

		expect(body).toContain("### Config Dependencies");
		expect(body).toContain("| Package | From | To |");
		expect(body).toContain(`[\`typescript\`](https://www.npmjs.com/package/typescript)`);
		expect(body).toContain("5.3.3");
		expect(body).toContain("5.4.0");
	});

	it("generates body with regular dependencies table", async () => {
		const body = await withReport((r) => r.generatePRBody(regularUpdates, []));

		expect(body).toContain("### Regular Dependencies");
		expect(body).toContain(`[\`effect\`](https://www.npmjs.com/package/effect)`);
	});

	it("generates body with both tables", async () => {
		const body = await withReport((r) => r.generatePRBody(mixedUpdates, []));

		expect(body).toContain("### Config Dependencies");
		expect(body).toContain("### Regular Dependencies");
	});

	it("includes changeset details sections", async () => {
		const body = await withReport((r) => r.generatePRBody(configUpdates, [packageChangeset, rootChangeset]));

		expect(body).toContain("### Changesets");
		expect(body).toContain("2 changeset(s) created");
		expect(body).toContain("<summary>@savvy-web/core</summary>");
		expect(body).toContain("<summary>root workspace</summary>");
	});

	it("handles glob patterns in dependency names (no link)", async () => {
		const body = await withReport((r) => r.generatePRBody([regularUpdateGlob], []));

		expect(body).toContain("`@effect/*`");
		expect(body).not.toContain("[`@effect/*`]");
	});

	it("includes footer", async () => {
		const body = await withReport((r) => r.generatePRBody(configUpdates, []));

		expect(body).toContain("---");
		expect(body).toContain("pnpm-config-dependency-action");
	});

	it("shows _new_ for new config dependencies", async () => {
		const body = await withReport((r) => r.generatePRBody([configUpdateNew], []));

		expect(body).toContain("_new_");
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

	it("shows config dependency table with clean versions", async () => {
		const updates = [{ ...configUpdate, to: "5.4.0+sha512-abc123" }];
		const result = await withReport((r) => r.generateSummary(updates, [], null, false));

		expect(result).toContain("5.4.0");
		expect(result).not.toContain("sha512");
	});
});
