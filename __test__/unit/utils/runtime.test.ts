import { describe, expect, it } from "vitest";
import { findRuntimeEntry, isStaticVersion } from "../../../src/utils/runtime.js";

describe("isStaticVersion", () => {
	it("true for bare X.Y.Z", () => expect(isStaticVersion("24.11.0")).toBe(true));
	it("true for prerelease", () => expect(isStaticVersion("24.11.0-rc.1")).toBe(true));
	it("false for caret range", () => expect(isStaticVersion("^24.0.0")).toBe(false));
	it("false for tilde range", () => expect(isStaticVersion("~24.5.0")).toBe(false));
	it("false for partial (24)", () => expect(isStaticVersion("24")).toBe(false));
	it("false for wildcard (24.x)", () => expect(isStaticVersion("24.x")).toBe(false));
	it("false for comparator (>=20)", () => expect(isStaticVersion(">=20.0.0")).toBe(false));
	it("false for OR range", () => expect(isStaticVersion("20.0.0 || 22.0.0")).toBe(false));
});

describe("findRuntimeEntry", () => {
	it("finds in array shape", () => {
		const dev = { runtime: [{ name: "node", version: "^24.0.0" }] };
		expect(findRuntimeEntry(dev, "node")?.version).toBe("^24.0.0");
	});
	it("finds in single-object shape", () => {
		const dev = { runtime: { name: "node", version: "24.11.0" } };
		expect(findRuntimeEntry(dev, "node")?.version).toBe("24.11.0");
	});
	it("returns null when absent", () => {
		expect(findRuntimeEntry({ runtime: [{ name: "node", version: "1" }] }, "bun")).toBeNull();
		expect(findRuntimeEntry(undefined, "node")).toBeNull();
		expect(findRuntimeEntry({}, "node")).toBeNull();
	});
	it("returns the live entry object, so assigning version rewrites the manifest in place", () => {
		const pkg = { devEngines: { runtime: [{ name: "node", version: "^24.0.0", onFail: "ignore" }] } };
		const entry = findRuntimeEntry(pkg.devEngines, "node");
		expect(entry).not.toBeNull();
		if (entry) entry.version = "24.16.0";
		expect(pkg.devEngines.runtime).toEqual([{ name: "node", version: "24.16.0", onFail: "ignore" }]);
	});
});
