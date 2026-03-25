import { describe, expect, it } from "vitest";
import { parseMultiValueInput } from "./input.js";

describe("parseMultiValueInput", () => {
	it("returns empty array for empty string", () => {
		expect(parseMultiValueInput("")).toEqual([]);
	});

	it("returns empty array for whitespace-only string", () => {
		expect(parseMultiValueInput("   ")).toEqual([]);
	});

	it("splits newline-separated values", () => {
		expect(parseMultiValueInput("a\nb\nc")).toEqual(["a", "b", "c"]);
	});

	it("trims whitespace from newline-separated values", () => {
		expect(parseMultiValueInput("  a  \n  b  \n  c  ")).toEqual(["a", "b", "c"]);
	});

	it("strips bullet prefixes", () => {
		expect(parseMultiValueInput("* a\n* b\n* c")).toEqual(["a", "b", "c"]);
	});

	it("filters comment lines", () => {
		expect(parseMultiValueInput("# comment\na\nb")).toEqual(["a", "b"]);
	});

	it("filters empty lines", () => {
		expect(parseMultiValueInput("a\n\nb\n\n")).toEqual(["a", "b"]);
	});

	it("splits comma-separated values", () => {
		expect(parseMultiValueInput("a, b, c")).toEqual(["a", "b", "c"]);
	});

	it("parses JSON array", () => {
		expect(parseMultiValueInput('["a", "b", "c"]')).toEqual(["a", "b", "c"]);
	});

	it("falls through on invalid JSON", () => {
		expect(parseMultiValueInput("[not valid json")).toEqual(["[not valid json"]);
	});

	it("handles single value (no delimiter)", () => {
		expect(parseMultiValueInput("@scope/pkg")).toEqual(["@scope/pkg"]);
	});
});
