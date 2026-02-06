import { describe, expect, it, vi } from "vitest";

// Mock @actions/core before any imports that use it
vi.mock("@actions/core", () => ({
	getState: vi.fn((key: string) => {
		if (key === "appSlug") return "my-app";
		return "";
	}),
	getInput: vi.fn(() => ""),
	getBooleanInput: vi.fn(() => false),
	setFailed: vi.fn(),
	setOutput: vi.fn(),
	info: vi.fn(),
	debug: vi.fn(),
	warning: vi.fn(),
	summary: { addHeading: vi.fn(), addRaw: vi.fn(), write: vi.fn() },
}));

import { getState } from "@actions/core";

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
} from "./lib/__test__/fixtures.js";
import { cleanVersion, generateCommitMessage, generatePRBody, generateSummary, npmUrl } from "./main.js";

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
	it("generates message for config-only updates", () => {
		const message = generateCommitMessage(configUpdates);

		expect(message).toContain("chore(deps): update 2 config dependencies");
		expect(message).toContain("- typescript: 5.3.3 -> 5.4.0");
		expect(message).toContain("- @biomejs/biome: new -> 1.6.1");
	});

	it("generates message for regular-only updates", () => {
		const message = generateCommitMessage(regularUpdates);

		expect(message).toContain("chore(deps): update 2 regular dependencies");
		expect(message).toContain("- effect: 3.0.0 -> 3.1.0");
	});

	it("generates message for mixed updates", () => {
		const message = generateCommitMessage(mixedUpdates);

		expect(message).toContain("chore(deps): update 2 config and 2 regular dependencies");
	});

	it("includes sign-off with app slug from state", () => {
		const message = generateCommitMessage(configUpdates);

		expect(message).toContain("Signed-off-by: my-app[bot] <my-app[bot]@users.noreply.github.com>");
	});

	it("falls back to github-actions[bot] when no app slug", () => {
		vi.mocked(getState).mockReturnValueOnce("");

		const message = generateCommitMessage(configUpdates);

		expect(message).toContain("Signed-off-by: github-actions[bot]");
	});
});

describe("generatePRBody", () => {
	it("generates body with config dependencies table", () => {
		const body = generatePRBody(configUpdates, []);

		expect(body).toContain("### 🔧 Config Dependencies");
		expect(body).toContain("| Package | From | To |");
		expect(body).toContain(`[\`typescript\`](https://www.npmjs.com/package/typescript)`);
		expect(body).toContain("5.3.3");
		expect(body).toContain("5.4.0");
	});

	it("generates body with regular dependencies table", () => {
		const body = generatePRBody(regularUpdates, []);

		expect(body).toContain("### 📦 Regular Dependencies");
		expect(body).toContain(`[\`effect\`](https://www.npmjs.com/package/effect)`);
	});

	it("generates body with both tables", () => {
		const body = generatePRBody(mixedUpdates, []);

		expect(body).toContain("### 🔧 Config Dependencies");
		expect(body).toContain("### 📦 Regular Dependencies");
	});

	it("includes changeset details sections", () => {
		const body = generatePRBody(configUpdates, [packageChangeset, rootChangeset]);

		expect(body).toContain("### 📝 Changesets");
		expect(body).toContain("2 changeset(s) created");
		expect(body).toContain("<summary>📦 @savvy-web/core</summary>");
		expect(body).toContain("<summary>🔧 root workspace</summary>");
	});

	it("handles glob patterns in dependency names (no link)", () => {
		const body = generatePRBody([regularUpdateGlob], []);

		expect(body).toContain("`@effect/*`");
		expect(body).not.toContain("[`@effect/*`]");
	});

	it("includes footer", () => {
		const body = generatePRBody(configUpdates, []);

		expect(body).toContain("---");
		expect(body).toContain("pnpm-config-dependency-action");
	});

	it("shows _new_ for new config dependencies", () => {
		const body = generatePRBody([configUpdateNew], []);

		expect(body).toContain("_new_");
	});
});

describe("generateSummary", () => {
	it("generates summary with PR link", () => {
		const summary = generateSummary(configUpdates, [], pullRequest, false);

		expect(summary).toContain(`[#42](${pullRequest.url})`);
		expect(summary).toContain("**Dependencies updated:** 2");
	});

	it("generates summary without PR (null)", () => {
		const summary = generateSummary(configUpdates, [], null, false);

		expect(summary).not.toContain("Pull request:");
		expect(summary).toContain("**Dependencies updated:** 2");
	});

	it("generates dry-run summary with PR body preview", () => {
		const summary = generateSummary(mixedUpdates, [], null, true);

		expect(summary).toContain("### 📋 PR Body Preview");
		expect(summary).toContain("View PR body");
	});

	it("does not show PR body preview when not dry-run", () => {
		const summary = generateSummary(mixedUpdates, [], pullRequest, false);

		expect(summary).not.toContain("PR Body Preview");
	});

	it("shows changeset details", () => {
		const summary = generateSummary(configUpdates, [packageChangeset, rootChangeset], null, false);

		expect(summary).toContain("### 📝 Changesets Created");
		expect(summary).toContain("**Changesets created:** 2");
	});

	it("shows config dependency table with clean versions", () => {
		const updates = [{ ...configUpdate, to: "5.4.0+sha512-abc123" }];
		const summary = generateSummary(updates, [], null, false);

		expect(summary).toContain("5.4.0");
		expect(summary).not.toContain("sha512");
	});
});
