import type { LockfileObject } from "@pnpm/lockfile.types";
import { Effect, LogLevel, Logger } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { LockfileChange } from "../../types/index.js";
import { compareLockfiles, groupChangesByPackage } from "./compare.js";

// Mock workspace-tools so buildImporterToPackageMap doesn't hit the filesystem
vi.mock("workspace-tools", () => ({
	getPackageInfosAsync: vi.fn(() =>
		Promise.resolve({
			"@savvy-web/core": {
				packageJsonPath: "/workspace/pkgs/core/package.json",
			},
			"@savvy-web/utils": {
				packageJsonPath: "/workspace/pkgs/utils/package.json",
			},
		}),
	),
}));

/**
 * Create a minimal LockfileObject for testing.
 */
const makeLockfile = (overrides: Partial<LockfileObject> = {}): LockfileObject =>
	({
		lockfileVersion: "9.0",
		importers: {},
		...overrides,
	}) as LockfileObject;

/**
 * Run compareLockfiles with logging suppressed.
 */
const runCompare = (before: LockfileObject, after: LockfileObject) =>
	Effect.runPromise(compareLockfiles(before, after, "/workspace").pipe(Logger.withMinimumLogLevel(LogLevel.None)));

describe("groupChangesByPackage", () => {
	it("groups config changes under (root) key", () => {
		const changes: LockfileChange[] = [
			{ type: "config", dependency: "typescript", from: "5.3.3", to: "5.4.0", affectedPackages: [] },
			{ type: "config", dependency: "biome", from: "1.5.0", to: "1.6.1", affectedPackages: [] },
		];

		const result = groupChangesByPackage(changes);

		expect(result.size).toBe(1);
		expect(result.has("(root)")).toBe(true);
		expect(result.get("(root)")).toHaveLength(2);
	});

	it("groups regular changes by affected package names", () => {
		const changes: LockfileChange[] = [
			{ type: "regular", dependency: "effect", from: "3.0.0", to: "3.1.0", affectedPackages: ["@savvy-web/core"] },
			{
				type: "regular",
				dependency: "zod",
				from: "3.22.0",
				to: "3.23.0",
				affectedPackages: ["@savvy-web/utils"],
			},
		];

		const result = groupChangesByPackage(changes);

		expect(result.size).toBe(2);
		expect(result.get("@savvy-web/core")).toHaveLength(1);
		expect(result.get("@savvy-web/core")?.[0].dependency).toBe("effect");
		expect(result.get("@savvy-web/utils")).toHaveLength(1);
		expect(result.get("@savvy-web/utils")?.[0].dependency).toBe("zod");
	});

	it("handles changes affecting multiple packages", () => {
		const changes: LockfileChange[] = [
			{
				type: "regular",
				dependency: "effect",
				from: "3.0.0",
				to: "3.1.0",
				affectedPackages: ["@savvy-web/core", "@savvy-web/utils"],
			},
		];

		const result = groupChangesByPackage(changes);

		expect(result.size).toBe(2);
		expect(result.get("@savvy-web/core")).toHaveLength(1);
		expect(result.get("@savvy-web/utils")).toHaveLength(1);
	});

	it("handles empty changes array", () => {
		const result = groupChangesByPackage([]);
		expect(result.size).toBe(0);
	});

	it("handles mix of config and regular changes", () => {
		const changes: LockfileChange[] = [
			{ type: "config", dependency: "typescript", from: "5.3.3", to: "5.4.0", affectedPackages: [] },
			{ type: "regular", dependency: "effect", from: "3.0.0", to: "3.1.0", affectedPackages: ["@savvy-web/core"] },
		];

		const result = groupChangesByPackage(changes);

		expect(result.size).toBe(2);
		expect(result.has("(root)")).toBe(true);
		expect(result.has("@savvy-web/core")).toBe(true);
	});

	it("accumulates multiple changes for the same package", () => {
		const changes: LockfileChange[] = [
			{ type: "regular", dependency: "effect", from: "3.0.0", to: "3.1.0", affectedPackages: ["@savvy-web/core"] },
			{
				type: "regular",
				dependency: "@effect/schema",
				from: "0.60.0",
				to: "0.61.0",
				affectedPackages: ["@savvy-web/core"],
			},
		];

		const result = groupChangesByPackage(changes);

		expect(result.size).toBe(1);
		expect(result.get("@savvy-web/core")).toHaveLength(2);
	});
});

describe("compareLockfiles - catalog resolved version changes", () => {
	it("detects resolved version change when specifier is unchanged", async () => {
		const before = makeLockfile({
			catalogs: {
				default: {
					turbo: { specifier: "^2.8.4", version: "2.8.6" },
				},
			},
			importers: {
				".": {
					devDependencies: {
						turbo: { specifier: "catalog:", version: "2.8.6" },
					},
				} as LockfileObject["importers"][string],
			},
		});

		const after = makeLockfile({
			catalogs: {
				default: {
					turbo: { specifier: "^2.8.4", version: "2.8.7" },
				},
			},
			importers: {
				".": {
					devDependencies: {
						turbo: { specifier: "catalog:", version: "2.8.7" },
					},
				} as LockfileObject["importers"][string],
			},
		});

		const changes = await runCompare(before, after);

		expect(changes).toHaveLength(1);
		expect(changes[0].dependency).toBe("turbo");
		expect(changes[0].from).toBe("2.8.6");
		expect(changes[0].to).toBe("2.8.7");
	});

	it("reports specifier versions when specifier changed", async () => {
		const before = makeLockfile({
			catalogs: {
				default: {
					turbo: { specifier: "^2.8.4", version: "2.8.6" },
				},
			},
			importers: {},
		});

		const after = makeLockfile({
			catalogs: {
				default: {
					turbo: { specifier: "^2.9.0", version: "2.9.1" },
				},
			},
			importers: {},
		});

		const changes = await runCompare(before, after);

		expect(changes).toHaveLength(1);
		expect(changes[0].dependency).toBe("turbo");
		expect(changes[0].from).toBe("^2.8.4");
		expect(changes[0].to).toBe("^2.9.0");
	});

	it("reports specifier versions when both specifier and version changed", async () => {
		const before = makeLockfile({
			catalogs: {
				default: {
					effect: { specifier: "^3.0.0", version: "3.0.5" },
				},
			},
			importers: {},
		});

		const after = makeLockfile({
			catalogs: {
				default: {
					effect: { specifier: "^3.1.0", version: "3.1.2" },
				},
			},
			importers: {},
		});

		const changes = await runCompare(before, after);

		expect(changes).toHaveLength(1);
		expect(changes[0].from).toBe("^3.0.0");
		expect(changes[0].to).toBe("^3.1.0");
	});

	it("reports no changes when both specifier and version are identical", async () => {
		const before = makeLockfile({
			catalogs: {
				default: {
					turbo: { specifier: "^2.8.4", version: "2.8.6" },
				},
			},
			importers: {},
		});

		const after = makeLockfile({
			catalogs: {
				default: {
					turbo: { specifier: "^2.8.4", version: "2.8.6" },
				},
			},
			importers: {},
		});

		const changes = await runCompare(before, after);

		expect(changes).toHaveLength(0);
	});
});
