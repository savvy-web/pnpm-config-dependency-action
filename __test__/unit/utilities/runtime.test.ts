import { describe, expect, it } from "vitest";
import { isStaticVersion, locateRuntimeEntry } from "../../../src/utils/runtime.js";

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

describe("locateRuntimeEntry", () => {
	it("finds in array shape", () => {
		const dev = { runtime: [{ name: "node", version: "^24.0.0" }] };
		expect(locateRuntimeEntry(dev, "node")?.entry.version).toBe("^24.0.0");
	});
	it("finds in single-object shape", () => {
		const dev = { runtime: { name: "node", version: "24.11.0" } };
		expect(locateRuntimeEntry(dev, "node")?.entry.version).toBe("24.11.0");
	});
	it("returns null when absent", () => {
		expect(locateRuntimeEntry({ runtime: [{ name: "node", version: "1" }] }, "bun")).toBeNull();
		expect(locateRuntimeEntry(undefined, "node")).toBeNull();
		expect(locateRuntimeEntry({}, "node")).toBeNull();
	});

	// The write is a surgical edit applied at this path, so a wrong path does not
	// throw — it writes nothing, or writes to a field nobody reads. These are the
	// assertions that make that failure expressible, and they replace a test that
	// pinned the old mechanism (mutating the live entry object in place), which is
	// no longer how the manifest is written.
	it("reports an INDEXED path for the array shape", () => {
		const dev = {
			runtime: [
				{ name: "deno", version: "1" },
				{ name: "node", version: "^24.0.0" },
			],
		};
		expect(locateRuntimeEntry(dev, "node")?.versionPath).toEqual(["devEngines", "runtime", 1, "version"]);
	});
	it("reports an UNINDEXED path for the single-object shape", () => {
		const dev = { runtime: { name: "node", version: "24.11.0" } };
		expect(locateRuntimeEntry(dev, "node")?.versionPath).toEqual(["devEngines", "runtime", "version"]);
	});
	it("indexes by position in the array, not by the order runtimes are checked", () => {
		// A path built from a fixed runtime ordering rather than the entry's real
		// index would pass the single-entry cases above and corrupt this one.
		const dev = {
			runtime: [
				{ name: "node", version: "1" },
				{ name: "bun", version: "2" },
			],
		};
		expect(locateRuntimeEntry(dev, "bun")?.versionPath).toEqual(["devEngines", "runtime", 1, "version"]);
		expect(locateRuntimeEntry(dev, "node")?.versionPath).toEqual(["devEngines", "runtime", 0, "version"]);
	});
});
