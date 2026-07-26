import { describe, expect, it } from "vitest";
import { resolveTargetBranch } from "../../../src/utils/branch.js";

describe("resolveTargetBranch", () => {
	it("falls back to source when target is empty", () => {
		expect(resolveTargetBranch("", "main")).toBe("main");
	});

	it("falls back to source when target is whitespace only", () => {
		expect(resolveTargetBranch("   ", "dev")).toBe("dev");
	});

	it("uses target when provided", () => {
		expect(resolveTargetBranch("release", "dev")).toBe("release");
	});

	it("trims the provided target", () => {
		expect(resolveTargetBranch("  release  ", "dev")).toBe("release");
	});
});
