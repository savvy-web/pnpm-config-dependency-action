import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
	configDepUpgradeRange,
	resolutionRangeForSpecifier,
	resolveLatestSatisfying,
} from "../../../src/utils/semver.js";

// ══════════════════════════════════════════════════════════════════════════════
// configDepUpgradeRange
// ══════════════════════════════════════════════════════════════════════════════

describe("configDepUpgradeRange", () => {
	it("keeps a >=1.0.0 dep within its current major", () => {
		// 1.14.5 may advance across the 1.x line but must not reach 2.0.0.
		expect(configDepUpgradeRange("1.14.5")).toBe(">=1.14.5 <2.0.0");
	});

	it("keeps a higher-major dep within its major", () => {
		expect(configDepUpgradeRange("2.3.0")).toBe(">=2.3.0 <3.0.0");
	});

	it("lets a sub-1.0.0 dep advance across 0.x and into 1.x but never 2.x", () => {
		// A 0.x dep may track newer 0.x releases or adopt the first stable major
		// (1.x), but a single run never crosses two majors at once.
		expect(configDepUpgradeRange("0.14.5")).toBe(">=0.14.5 <2.0.0");
	});

	it("treats a 0.0.x dep the same way (ceiling 2.0.0)", () => {
		expect(configDepUpgradeRange("0.0.5")).toBe(">=0.0.5 <2.0.0");
	});

	it("returns null for a version with no numeric major", () => {
		expect(configDepUpgradeRange("latest")).toBeNull();
	});

	it("resolves the latest 1.x for a sub-1.0.0 dep when a stable major exists", async () => {
		const range = configDepUpgradeRange("0.14.5");
		expect(range).not.toBeNull();
		const resolved = await Effect.runPromise(
			resolveLatestSatisfying(["0.14.5", "0.20.0", "1.2.0", "2.0.0"], range as string),
		);
		expect(resolved).toBe("1.2.0");
	});

	it("resolves the latest 0.x for a sub-1.0.0 dep when no stable major exists", async () => {
		const range = configDepUpgradeRange("0.14.5");
		const resolved = await Effect.runPromise(resolveLatestSatisfying(["0.14.5", "0.20.0"], range as string));
		expect(resolved).toBe("0.20.0");
	});

	it("resolves the latest in-major version for a >=1.0.0 dep", async () => {
		const range = configDepUpgradeRange("1.14.5");
		const resolved = await Effect.runPromise(
			resolveLatestSatisfying(["1.14.5", "1.20.0", "2.0.0", "2.3.0"], range as string),
		);
		expect(resolved).toBe("1.20.0");
	});
});

// ══════════════════════════════════════════════════════════════════════════════
// resolutionRangeForSpecifier
// ══════════════════════════════════════════════════════════════════════════════

describe("resolutionRangeForSpecifier", () => {
	it("widens a caret-on-zero specifier to the config-dep range", () => {
		// ^0.5.0 would be trapped in 0.5.x by caret semantics; instead it gets
		// the config-dep roll-forward range so it can advance across 0.x and into 1.x.
		expect(resolutionRangeForSpecifier("^", "0.5.0")).toBe(">=0.5.0 <2.0.0");
	});

	it("widens a caret-on-0.0.x specifier the same way", () => {
		expect(resolutionRangeForSpecifier("^", "0.0.3")).toBe(">=0.0.3 <2.0.0");
	});

	it("leaves a caret on a >=1.0.0 version as the literal specifier", () => {
		expect(resolutionRangeForSpecifier("^", "4.0.0")).toBe("^4.0.0");
	});

	it("leaves a tilde-on-zero specifier as the literal specifier", () => {
		expect(resolutionRangeForSpecifier("~", "0.5.0")).toBe("~0.5.0");
	});

	it("leaves an exact-on-zero specifier as the literal specifier", () => {
		expect(resolutionRangeForSpecifier("", "0.5.0")).toBe("0.5.0");
	});

	it("leaves a comparator-range-on-zero specifier as the literal specifier", () => {
		expect(resolutionRangeForSpecifier(">=", "0.5.0")).toBe(">=0.5.0");
	});

	it("falls back to the literal specifier when the version has no numeric major", () => {
		// Defensive: parseSpecifier guarantees a numeric major upstream, but the
		// helper must not synthesize a range it cannot build.
		expect(resolutionRangeForSpecifier("^", "x.y.z")).toBe("^x.y.z");
	});
});
