import { describe, expect, it } from "vitest";
import { cleanVersion, npmUrl } from "../../../src/utils/markdown.js";

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
