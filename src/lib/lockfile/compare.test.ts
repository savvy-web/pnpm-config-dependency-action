import type { LockfileObject } from "@pnpm/lockfile.types";
import { Effect, Either, LogLevel, Logger } from "effect";
import { describe, expect, it, vi } from "vitest";

// Mock @actions/core to suppress ::debug:: output from logging.ts
vi.mock("@actions/core", () => ({
	debug: vi.fn(),
	info: vi.fn(),
	warning: vi.fn(),
	getInput: vi.fn(() => ""),
	getBooleanInput: vi.fn(() => false),
}));

// Hoist mock for @pnpm/lockfile.fs
const { mockReadWantedLockfile } = vi.hoisted(() => ({
	mockReadWantedLockfile: vi.fn(),
}));

vi.mock("@pnpm/lockfile.fs", () => ({
	readWantedLockfile: (...args: unknown[]) => mockReadWantedLockfile(...args),
}));

import type { LockfileChange } from "../../types/index.js";
import { captureLockfileState, compareLockfiles, groupChangesByPackage } from "./compare.js";

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

const runEffect = <A, E>(effect: Effect.Effect<A, E>) =>
	Effect.runPromise(Effect.either(effect).pipe(Logger.withMinimumLogLevel(LogLevel.None)));

describe("captureLockfileState", () => {
	it("returns lockfile object on success", async () => {
		const fakeLockfile = { lockfileVersion: "9.0", importers: {} };
		mockReadWantedLockfile.mockResolvedValueOnce(fakeLockfile);

		const result = await runEffect(captureLockfileState("/workspace"));

		expect(Either.isRight(result)).toBe(true);
		if (Either.isRight(result)) {
			expect(result.right).toBe(fakeLockfile);
		}
	});

	it("returns null when lockfile does not exist", async () => {
		mockReadWantedLockfile.mockResolvedValueOnce(null);

		const result = await runEffect(captureLockfileState("/workspace"));

		expect(Either.isRight(result)).toBe(true);
		if (Either.isRight(result)) {
			expect(result.right).toBeNull();
		}
	});

	it("returns LockfileError when read fails", async () => {
		mockReadWantedLockfile.mockRejectedValueOnce(new Error("ENOENT"));

		const result = await runEffect(captureLockfileState("/workspace"));

		expect(Either.isLeft(result)).toBe(true);
		if (Either.isLeft(result)) {
			expect(result.left._tag).toBe("LockfileError");
		}
	});
});

describe("compareLockfiles - null handling", () => {
	it("returns empty array when before is null", async () => {
		const after = makeLockfile();
		const changes = await Effect.runPromise(
			compareLockfiles(null, after, "/workspace").pipe(Logger.withMinimumLogLevel(LogLevel.None)),
		);
		expect(changes).toEqual([]);
	});

	it("returns empty array when after is null", async () => {
		const before = makeLockfile();
		const changes = await Effect.runPromise(
			compareLockfiles(before, null, "/workspace").pipe(Logger.withMinimumLogLevel(LogLevel.None)),
		);
		expect(changes).toEqual([]);
	});

	it("returns empty array when both are null", async () => {
		const changes = await Effect.runPromise(
			compareLockfiles(null, null, "/workspace").pipe(Logger.withMinimumLogLevel(LogLevel.None)),
		);
		expect(changes).toEqual([]);
	});
});

describe("compareLockfiles - removed catalogs", () => {
	it("detects removed catalog entries", async () => {
		const before = makeLockfile({
			catalogs: {
				default: {
					turbo: { specifier: "^2.8.4", version: "2.8.6" },
					vitest: { specifier: "^1.0.0", version: "1.0.4" },
				},
			},
			importers: {},
		});

		const after = makeLockfile({
			catalogs: {
				default: {
					turbo: { specifier: "^2.8.4", version: "2.8.6" },
					// vitest removed
				},
			},
			importers: {},
		});

		const changes = await runCompare(before, after);

		expect(changes).toHaveLength(1);
		expect(changes[0].dependency).toBe("vitest");
		expect(changes[0].from).toBe("^1.0.0");
		expect(changes[0].to).toBe("(removed)");
	});

	it("detects entire catalog group removed", async () => {
		const before = makeLockfile({
			catalogs: {
				silk: {
					effect: { specifier: "^3.0.0", version: "3.0.5" },
				},
			},
			importers: {},
		});

		const after = makeLockfile({
			catalogs: {},
			importers: {},
		});

		const changes = await runCompare(before, after);

		expect(changes).toHaveLength(1);
		expect(changes[0].dependency).toBe("effect");
		expect(changes[0].to).toBe("(removed)");
	});
});

describe("compareLockfiles - named catalogs", () => {
	it("detects changes in non-default catalog and finds affected packages", async () => {
		const before = makeLockfile({
			catalogs: {
				silk: {
					effect: { specifier: "^3.0.0", version: "3.0.5" },
				},
			},
			importers: {
				"pkgs/core": {
					dependencies: {
						effect: { specifier: "catalog:silk", version: "3.0.5" },
					},
				} as LockfileObject["importers"][string],
			},
		});

		const after = makeLockfile({
			catalogs: {
				silk: {
					effect: { specifier: "^3.1.0", version: "3.1.2" },
				},
			},
			importers: {
				"pkgs/core": {
					dependencies: {
						effect: { specifier: "catalog:silk", version: "3.1.2" },
					},
				} as LockfileObject["importers"][string],
			},
		});

		const changes = await runCompare(before, after);

		expect(changes).toHaveLength(1);
		expect(changes[0].dependency).toBe("effect");
		expect(changes[0].from).toBe("^3.0.0");
		expect(changes[0].to).toBe("^3.1.0");
		expect(changes[0].affectedPackages).toContain("@savvy-web/core");
	});
});

describe("compareLockfiles - importer specifier changes", () => {
	it("detects non-catalog specifier changes in importers", async () => {
		const before = makeLockfile({
			importers: {
				"pkgs/core": {
					specifiers: {
						lodash: "^4.17.0",
					},
				} as unknown as LockfileObject["importers"][string],
			},
		});

		const after = makeLockfile({
			importers: {
				"pkgs/core": {
					specifiers: {
						lodash: "^4.18.0",
					},
				} as unknown as LockfileObject["importers"][string],
			},
		});

		const changes = await runCompare(before, after);

		expect(changes).toHaveLength(1);
		expect(changes[0].dependency).toBe("lodash");
		expect(changes[0].from).toBe("^4.17.0");
		expect(changes[0].to).toBe("^4.18.0");
		expect(changes[0].affectedPackages).toContain("@savvy-web/core");
	});

	it("skips catalog specifiers in importers", async () => {
		const before = makeLockfile({
			importers: {
				"pkgs/core": {
					specifiers: {
						effect: "catalog:silk",
					},
				} as unknown as LockfileObject["importers"][string],
			},
		});

		const after = makeLockfile({
			importers: {
				"pkgs/core": {
					specifiers: {
						effect: "catalog:silk",
					},
				} as unknown as LockfileObject["importers"][string],
			},
		});

		const changes = await runCompare(before, after);

		expect(changes).toHaveLength(0);
	});

	it("detects removed specifiers in importers", async () => {
		const before = makeLockfile({
			importers: {
				"pkgs/core": {
					specifiers: {
						lodash: "^4.17.0",
						underscore: "^1.13.0",
					},
				} as unknown as LockfileObject["importers"][string],
			},
		});

		const after = makeLockfile({
			importers: {
				"pkgs/core": {
					specifiers: {
						lodash: "^4.17.0",
						// underscore removed
					},
				} as unknown as LockfileObject["importers"][string],
			},
		});

		const changes = await runCompare(before, after);

		expect(changes).toHaveLength(1);
		expect(changes[0].dependency).toBe("underscore");
		expect(changes[0].from).toBe("^1.13.0");
		expect(changes[0].to).toBe("(removed)");
	});

	it("uses importerId as package name when not in workspace map", async () => {
		const before = makeLockfile({
			importers: {
				"pkgs/unknown": {
					specifiers: {
						lodash: "^4.17.0",
					},
				} as unknown as LockfileObject["importers"][string],
			},
		});

		const after = makeLockfile({
			importers: {
				"pkgs/unknown": {
					specifiers: {
						lodash: "^4.18.0",
					},
				} as unknown as LockfileObject["importers"][string],
			},
		});

		const changes = await runCompare(before, after);

		expect(changes).toHaveLength(1);
		expect(changes[0].affectedPackages).toContain("pkgs/unknown");
	});
});

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
