import { ActionInputsTest, ActionLoggerTest, ActionOutputsTest } from "@savvy-web/github-action-effects";
import type { ParseResult } from "effect";
import { Effect, Layer, LogLevel, Logger } from "effect";
import { describe, expect, it } from "vitest";

import { getFieldFromParseIssue, getReasonFromParseIssue, parseInputs, parseMultilineInput } from "./inputs.js";

/** Run parseInputs with a test layer built from the given input map. */
const runParseInputs = (inputs: Record<string, string>) => {
	const layer = Layer.mergeAll(
		ActionInputsTest.layer(inputs),
		ActionOutputsTest.layer(ActionOutputsTest.empty()),
		ActionLoggerTest.layer(ActionLoggerTest.empty()),
	);
	return Effect.runPromise(
		Effect.either(parseInputs).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
	);
};

/** Run parseInputs expecting success. */
const runParseInputsOk = async (inputs: Record<string, string>) => {
	const result = await runParseInputs(inputs);
	if (result._tag === "Left") {
		throw new Error(`Expected success but got error: ${JSON.stringify(result.left)}`);
	}
	return result.right;
};

const validInputs: Record<string, string> = {
	"app-id": "12345",
	"app-private-key": "fake-key",
	branch: "pnpm/config-deps",
	"config-dependencies": "typescript",
	dependencies: "effect",
	run: "",
	"update-pnpm": "true",
	changesets: "true",
	"auto-merge": "",
	"dry-run": "false",
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
		const result = await runParseInputsOk(validInputs);

		expect(result.appId).toBe("12345");
		expect(result.branch).toBe("pnpm/config-deps");
		expect(result.configDependencies).toEqual(["typescript"]);
		expect(result.dependencies).toEqual(["effect"]);
		expect(result.run).toEqual([]);
		expect(result.updatePnpm).toBe(true);
		expect(result.changesets).toBe(true);
	});

	it("uses default branch when not specified", async () => {
		const result = await runParseInputsOk({ ...validInputs, branch: "" });
		expect(result.branch).toBe("pnpm/config-deps");
	});

	it("fails when no dependencies specified and updatePnpm is false", async () => {
		const result = await runParseInputs({
			...validInputs,
			"config-dependencies": "",
			dependencies: "",
			"update-pnpm": "false",
		});
		expect(result._tag).toBe("Left");
	});

	it("succeeds with only update-pnpm true and no dependencies", async () => {
		const result = await runParseInputsOk({
			...validInputs,
			"config-dependencies": "",
			dependencies: "",
			"update-pnpm": "true",
		});
		expect(result.updatePnpm).toBe(true);
		expect(result.configDependencies).toEqual([]);
		expect(result.dependencies).toEqual([]);
	});

	it("fails for invalid branch name", async () => {
		const result = await runParseInputs({ ...validInputs, branch: "invalid branch!" });
		expect(result._tag).toBe("Left");
	});

	it("fails for missing app-id", async () => {
		const result = await runParseInputs({ ...validInputs, "app-id": "" });
		expect(result._tag).toBe("Left");
	});

	it("error includes field name for invalid branch", async () => {
		const result = await runParseInputs({ ...validInputs, branch: "bad branch!" });
		expect(result._tag).toBe("Left");
		if (result._tag === "Left") {
			expect(result.left._tag).toBe("InvalidInputError");
		}
	});

	it("error for missing private key", async () => {
		const result = await runParseInputs({ ...validInputs, "app-private-key": "" });
		expect(result._tag).toBe("Left");
	});

	it("parses run commands", async () => {
		const result = await runParseInputsOk({ ...validInputs, run: "pnpm lint:fix\npnpm test" });
		expect(result.run).toEqual(["pnpm lint:fix", "pnpm test"]);
	});

	it("parses auto-merge input with empty default", async () => {
		const result = await runParseInputsOk({ ...validInputs, "auto-merge": "" });
		expect(result.autoMerge).toBe("");
	});

	it("parses auto-merge input with squash value", async () => {
		const result = await runParseInputsOk({ ...validInputs, "auto-merge": "squash" });
		expect(result.autoMerge).toBe("squash");
	});

	it("parses changesets input as false", async () => {
		const result = await runParseInputsOk({ ...validInputs, changesets: "false" });
		expect(result.changesets).toBe(false);
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
