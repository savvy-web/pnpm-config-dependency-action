import type { ParseResult } from "effect";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

// Mock @actions/core before importing anything that uses it
vi.mock("@actions/core", () => ({
	getInput: vi.fn((_name: string) => ""),
	getBooleanInput: vi.fn((_name: string) => false),
	setFailed: vi.fn(),
	setOutput: vi.fn(),
	info: vi.fn(),
	debug: vi.fn(),
	warning: vi.fn(),
}));

import { getBooleanInput, getInput } from "@actions/core";

import {
	getFieldFromParseIssue,
	getGitHubToken,
	getLogLevel,
	getReasonFromParseIssue,
	isDebugMode,
	isDryRun,
	parseInputs,
	parseMultilineInput,
	shouldSkipTokenRevoke,
} from "./inputs.js";

// Helper to set up mocked inputs
const mockInputs = (inputs: Record<string, string>) => {
	vi.mocked(getInput).mockImplementation((name: string) => inputs[name] ?? "");
};

describe("parseMultilineInput", () => {
	it("parses newline-separated strings into array", () => {
		const result = parseMultilineInput("typescript\n@biomejs/biome\neffect");
		expect(result).toEqual(["typescript", "@biomejs/biome", "effect"]);
	});

	it("trims whitespace from each line", () => {
		const result = parseMultilineInput("  typescript  \n  @biomejs/biome  ");
		expect(result).toEqual(["typescript", "@biomejs/biome"]);
	});

	it("filters empty lines", () => {
		const result = parseMultilineInput("typescript\n\n\n@biomejs/biome\n\n");
		expect(result).toEqual(["typescript", "@biomejs/biome"]);
	});

	it("filters comment lines starting with #", () => {
		const result = parseMultilineInput("# Config deps\ntypescript\n# Regular deps\neffect");
		expect(result).toEqual(["typescript", "effect"]);
	});

	it("returns empty array for empty string", () => {
		const result = parseMultilineInput("");
		expect(result).toEqual([]);
	});

	it("returns empty array for whitespace-only input", () => {
		const result = parseMultilineInput("   \n  \n  ");
		expect(result).toEqual([]);
	});

	it("handles single line input", () => {
		const result = parseMultilineInput("typescript");
		expect(result).toEqual(["typescript"]);
	});

	it("handles mixed empty lines and comments", () => {
		const result = parseMultilineInput("\n# comment\n\ntypescript\n# another\n\neffect\n");
		expect(result).toEqual(["typescript", "effect"]);
	});
});

describe("parseInputs", () => {
	it("succeeds with valid inputs", async () => {
		mockInputs({
			"app-id": "12345",
			"app-private-key": "fake-key",
			branch: "pnpm/config-deps",
			"config-dependencies": "typescript",
			dependencies: "effect",
			run: "",
		});

		const result = await Effect.runPromise(parseInputs);

		expect(result.appId).toBe("12345");
		expect(result.branch).toBe("pnpm/config-deps");
		expect(result.configDependencies).toEqual(["typescript"]);
		expect(result.dependencies).toEqual(["effect"]);
		expect(result.run).toEqual([]);
	});

	it("uses default branch when not specified", async () => {
		mockInputs({
			"app-id": "12345",
			"app-private-key": "fake-key",
			branch: "",
			"config-dependencies": "typescript",
			dependencies: "",
			run: "",
		});

		const result = await Effect.runPromise(parseInputs);
		expect(result.branch).toBe("pnpm/config-deps");
	});

	it("fails when no dependencies specified", async () => {
		mockInputs({
			"app-id": "12345",
			"app-private-key": "fake-key",
			branch: "pnpm/config",
			"config-dependencies": "",
			dependencies: "",
			run: "",
		});

		const result = await Effect.runPromise(Effect.either(parseInputs));
		expect(result._tag).toBe("Left");
	});

	it("fails for invalid branch name", async () => {
		mockInputs({
			"app-id": "12345",
			"app-private-key": "fake-key",
			branch: "invalid branch!",
			"config-dependencies": "typescript",
			dependencies: "",
			run: "",
		});

		const result = await Effect.runPromise(Effect.either(parseInputs));
		expect(result._tag).toBe("Left");
	});

	it("fails for missing app-id", async () => {
		mockInputs({
			"app-id": "",
			"app-private-key": "fake-key",
			branch: "pnpm/config",
			"config-dependencies": "typescript",
			dependencies: "",
			run: "",
		});

		const result = await Effect.runPromise(Effect.either(parseInputs));
		expect(result._tag).toBe("Left");
	});

	it("error includes field name for invalid branch", async () => {
		mockInputs({
			"app-id": "12345",
			"app-private-key": "fake-key",
			branch: "bad branch!",
			"config-dependencies": "typescript",
			dependencies: "",
			run: "",
		});

		const result = await Effect.runPromise(Effect.either(parseInputs));
		expect(result._tag).toBe("Left");
		if (result._tag === "Left") {
			// The error should be an InvalidInputError with useful field info
			expect(result.left._tag).toBe("InvalidInputError");
		}
	});

	it("error for missing private key (redacted value)", async () => {
		mockInputs({
			"app-id": "12345",
			"app-private-key": "",
			branch: "pnpm/config",
			"config-dependencies": "typescript",
			dependencies: "",
			run: "",
		});

		const result = await Effect.runPromise(Effect.either(parseInputs));
		expect(result._tag).toBe("Left");
	});

	it("parses run commands", async () => {
		mockInputs({
			"app-id": "12345",
			"app-private-key": "fake-key",
			branch: "pnpm/config",
			"config-dependencies": "typescript",
			dependencies: "",
			run: "pnpm lint:fix\npnpm test",
		});

		const result = await Effect.runPromise(parseInputs);
		expect(result.run).toEqual(["pnpm lint:fix", "pnpm test"]);
	});
});

describe("getFieldFromParseIssue", () => {
	it("extracts field name from path with key", () => {
		const issue = {
			_tag: "Type" as const,
			path: [{ key: "branch" }],
			actual: "bad",
		} as unknown as ParseResult.ParseIssue;

		expect(getFieldFromParseIssue(issue)).toBe("branch");
	});

	it("returns input when no path", () => {
		const issue = { _tag: "Type" as const, actual: "bad" } as unknown as ParseResult.ParseIssue;
		expect(getFieldFromParseIssue(issue)).toBe("input");
	});

	it("returns input when path is empty", () => {
		const issue = { _tag: "Type" as const, path: [], actual: "bad" } as unknown as ParseResult.ParseIssue;
		expect(getFieldFromParseIssue(issue)).toBe("input");
	});

	it("returns input when path segment has no key", () => {
		const issue = { _tag: "Type" as const, path: ["nokey"], actual: "bad" } as unknown as ParseResult.ParseIssue;
		expect(getFieldFromParseIssue(issue)).toBe("input");
	});
});

describe("getReasonFromParseIssue", () => {
	it("returns message when present", () => {
		const issue = {
			_tag: "Type" as const,
			message: "Custom message",
			actual: "bad",
		} as unknown as ParseResult.ParseIssue;
		expect(getReasonFromParseIssue(issue)).toBe("Custom message");
	});

	it("returns required message for Missing tag", () => {
		const issue = { _tag: "Missing" as const } as unknown as ParseResult.ParseIssue;
		expect(getReasonFromParseIssue(issue)).toBe("This field is required");
	});

	it("returns type error message for Type tag", () => {
		const issue = { _tag: "Type" as const, actual: "bad-val" } as unknown as ParseResult.ParseIssue;
		expect(getReasonFromParseIssue(issue)).toBe('Expected valid value but got: "bad-val"');
	});

	it("returns generic message for unknown tag", () => {
		const issue = { _tag: "Composite" as const } as unknown as ParseResult.ParseIssue;
		expect(getReasonFromParseIssue(issue)).toBe("Validation failed");
	});
});

describe("isDryRun", () => {
	it("returns false by default", () => {
		expect(isDryRun()).toBe(false);
	});

	it("returns true when dry-run is true", () => {
		vi.mocked(getBooleanInput).mockReturnValueOnce(true);
		expect(isDryRun()).toBe(true);
	});
});

describe("shouldSkipTokenRevoke", () => {
	it("returns false by default", () => {
		expect(shouldSkipTokenRevoke()).toBe(false);
	});
});

describe("getLogLevel", () => {
	it("returns info by default", () => {
		mockInputs({ "log-level": "" });
		expect(getLogLevel()).toBe("info");
	});

	it("returns debug when log-level is debug", () => {
		mockInputs({ "log-level": "debug" });
		expect(getLogLevel()).toBe("debug");
	});

	it("returns info for unrecognized values", () => {
		mockInputs({ "log-level": "verbose" });
		expect(getLogLevel()).toBe("info");
	});
});

describe("isDebugMode", () => {
	it("returns false when log-level is info", () => {
		mockInputs({ "log-level": "info" });
		expect(isDebugMode()).toBe(false);
	});

	it("returns true when log-level is debug", () => {
		mockInputs({ "log-level": "debug" });
		expect(isDebugMode()).toBe(true);
	});
});

describe("getGitHubToken", () => {
	it("returns undefined when token is empty", () => {
		mockInputs({ "github-token": "" });
		expect(getGitHubToken()).toBeUndefined();
	});

	it("returns token when provided", () => {
		mockInputs({ "github-token": "ghp_test123" });
		expect(getGitHubToken()).toBe("ghp_test123");
	});

	it("returns undefined for whitespace-only token", () => {
		mockInputs({ "github-token": "   " });
		expect(getGitHubToken()).toBeUndefined();
	});
});
