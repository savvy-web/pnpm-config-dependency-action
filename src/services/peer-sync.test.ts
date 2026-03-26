import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, LogLevel, Logger } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { DependencyUpdateResult } from "../schemas/domain.js";
import { computePeerRange, syncPeers } from "./peer-sync.js";

// Mock workspace-tools to return our test workspace info
const { mockGetPackageInfosAsync } = vi.hoisted(() => ({
	mockGetPackageInfosAsync: vi.fn(),
}));

vi.mock("workspace-tools", () => ({
	getPackageInfosAsync: (...args: unknown[]) => mockGetPackageInfosAsync(...args),
}));

// ══════════════════════════════════════════════════════════════════════════════
// Test Helpers
// ══════════════════════════════════════════════════════════════════════════════

const makeTempDir = () => mkdtempSync(join(tmpdir(), "peer-sync-test-"));

const writePackageJson = (dir: string, content: Record<string, unknown>) => {
	writeFileSync(join(dir, "package.json"), `${JSON.stringify(content, null, "\t")}\n`, "utf-8");
};

const readPackageJson = (dir: string) => {
	return JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
};

// ══════════════════════════════════════════════════════════════════════════════
// computePeerRange
// ══════════════════════════════════════════════════════════════════════════════

describe("computePeerRange", () => {
	describe("lock strategy", () => {
		it("should sync on patch bump", async () => {
			const result = await Effect.runPromise(
				computePeerRange({
					strategy: "lock",
					currentPeerSpecifier: "^1.0.0",
					oldVersion: "1.0.0",
					newVersion: "1.0.3",
				}),
			);
			expect(result).toBe("^1.0.3");
		});

		it("should sync on minor bump", async () => {
			const result = await Effect.runPromise(
				computePeerRange({
					strategy: "lock",
					currentPeerSpecifier: "^1.0.0",
					oldVersion: "1.0.0",
					newVersion: "1.1.0",
				}),
			);
			expect(result).toBe("^1.1.0");
		});

		it("should preserve >= prefix", async () => {
			const result = await Effect.runPromise(
				computePeerRange({
					strategy: "lock",
					currentPeerSpecifier: ">=1.0.0",
					oldVersion: "1.0.0",
					newVersion: "1.2.3",
				}),
			);
			expect(result).toBe(">=1.2.3");
		});

		it("should preserve ~ prefix", async () => {
			const result = await Effect.runPromise(
				computePeerRange({
					strategy: "lock",
					currentPeerSpecifier: "~1.0.0",
					oldVersion: "1.0.0",
					newVersion: "1.0.5",
				}),
			);
			expect(result).toBe("~1.0.5");
		});

		it("should preserve exact (no prefix)", async () => {
			const result = await Effect.runPromise(
				computePeerRange({
					strategy: "lock",
					currentPeerSpecifier: "1.0.0",
					oldVersion: "1.0.0",
					newVersion: "1.0.3",
				}),
			);
			expect(result).toBe("1.0.3");
		});
	});

	describe("minor strategy", () => {
		it("should NOT sync on patch bump (returns null)", async () => {
			const result = await Effect.runPromise(
				computePeerRange({
					strategy: "minor",
					currentPeerSpecifier: "^1.0.0",
					oldVersion: "1.0.0",
					newVersion: "1.0.5",
				}),
			);
			expect(result).toBeNull();
		});

		it("should sync on minor bump with .0 patch", async () => {
			const result = await Effect.runPromise(
				computePeerRange({
					strategy: "minor",
					currentPeerSpecifier: "^1.0.0",
					oldVersion: "1.0.0",
					newVersion: "1.1.0",
				}),
			);
			expect(result).toBe("^1.1.0");
		});

		it("should sync on minor bump and floor patch to .0", async () => {
			const result = await Effect.runPromise(
				computePeerRange({
					strategy: "minor",
					currentPeerSpecifier: "^3.1.0",
					oldVersion: "3.1.0",
					newVersion: "3.2.5",
				}),
			);
			expect(result).toBe("^3.2.0");
		});

		it("should sync on major bump and floor patch to .0", async () => {
			const result = await Effect.runPromise(
				computePeerRange({
					strategy: "minor",
					currentPeerSpecifier: ">=3.6.0",
					oldVersion: "3.6.0",
					newVersion: "4.1.1",
				}),
			);
			expect(result).toBe(">=4.1.0");
		});

		it("should preserve exact prefix on minor bump", async () => {
			const result = await Effect.runPromise(
				computePeerRange({
					strategy: "minor",
					currentPeerSpecifier: "2.0.0",
					oldVersion: "2.0.0",
					newVersion: "2.1.3",
				}),
			);
			expect(result).toBe("2.1.0");
		});
	});
});

// ══════════════════════════════════════════════════════════════════════════════
// syncPeers
// ══════════════════════════════════════════════════════════════════════════════

describe("syncPeers", () => {
	it("should sync peer range with lock strategy on patch bump", async () => {
		const tmpDir = makeTempDir();
		writePackageJson(tmpDir, { name: "root", version: "1.0.0" });
		const pkgDir = join(tmpDir, "packages", "my-lib");
		mkdirSync(pkgDir, { recursive: true });

		writePackageJson(pkgDir, {
			name: "my-lib",
			version: "1.0.0",
			devDependencies: { effect: "^3.12.5" },
			peerDependencies: { effect: "^3.12.0" },
		});

		mockGetPackageInfosAsync.mockResolvedValue({
			"my-lib": {
				name: "my-lib",
				packageJsonPath: join(pkgDir, "package.json"),
				path: pkgDir,
				version: "1.0.0",
			},
		});

		const devUpdates: DependencyUpdateResult[] = [
			{
				dependency: "effect",
				from: "^3.12.0",
				to: "^3.12.5",
				type: "devDependency",
				package: "my-lib",
			},
		];

		const results = await Effect.runPromise(
			syncPeers({ lock: ["effect"], minor: [] }, devUpdates, tmpDir).pipe(Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(results).toHaveLength(1);
		expect(results[0].to).toBe("^3.12.5");

		const updated = readPackageJson(pkgDir);
		expect(updated.peerDependencies.effect).toBe("^3.12.5");
	});

	it("should skip peer sync with minor strategy on patch bump", async () => {
		const tmpDir = makeTempDir();
		writePackageJson(tmpDir, { name: "root", version: "1.0.0" });
		const pkgDir = join(tmpDir, "packages", "my-lib");
		mkdirSync(pkgDir, { recursive: true });

		writePackageJson(pkgDir, {
			name: "my-lib",
			version: "1.0.0",
			devDependencies: { effect: "^3.12.5" },
			peerDependencies: { effect: "^3.12.0" },
		});

		mockGetPackageInfosAsync.mockResolvedValue({
			"my-lib": {
				name: "my-lib",
				packageJsonPath: join(pkgDir, "package.json"),
				path: pkgDir,
				version: "1.0.0",
			},
		});

		const devUpdates: DependencyUpdateResult[] = [
			{
				dependency: "effect",
				from: "^3.12.0",
				to: "^3.12.5",
				type: "devDependency",
				package: "my-lib",
			},
		];

		const results = await Effect.runPromise(
			syncPeers({ lock: [], minor: ["effect"] }, devUpdates, tmpDir).pipe(Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(results).toHaveLength(0);

		// Verify file is unchanged
		const updated = readPackageJson(pkgDir);
		expect(updated.peerDependencies.effect).toBe("^3.12.0");
	});

	it("should sync peer range with minor strategy on minor bump", async () => {
		const tmpDir = makeTempDir();
		writePackageJson(tmpDir, { name: "root", version: "1.0.0" });
		const pkgDir = join(tmpDir, "packages", "my-lib");
		mkdirSync(pkgDir, { recursive: true });

		writePackageJson(pkgDir, {
			name: "my-lib",
			version: "1.0.0",
			devDependencies: { effect: "^3.13.0" },
			peerDependencies: { effect: "^3.12.0" },
		});

		mockGetPackageInfosAsync.mockResolvedValue({
			"my-lib": {
				name: "my-lib",
				packageJsonPath: join(pkgDir, "package.json"),
				path: pkgDir,
				version: "1.0.0",
			},
		});

		const devUpdates: DependencyUpdateResult[] = [
			{
				dependency: "effect",
				from: "^3.12.0",
				to: "^3.13.2",
				type: "devDependency",
				package: "my-lib",
			},
		];

		const results = await Effect.runPromise(
			syncPeers({ lock: [], minor: ["effect"] }, devUpdates, tmpDir).pipe(Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(results).toHaveLength(1);
		expect(results[0].to).toBe("^3.13.0");

		const updated = readPackageJson(pkgDir);
		expect(updated.peerDependencies.effect).toBe("^3.13.0");
	});

	it("should warn and skip when no peer entry exists", async () => {
		const tmpDir = makeTempDir();
		writePackageJson(tmpDir, { name: "root", version: "1.0.0" });
		const pkgDir = join(tmpDir, "packages", "my-lib");
		mkdirSync(pkgDir, { recursive: true });

		writePackageJson(pkgDir, {
			name: "my-lib",
			version: "1.0.0",
			devDependencies: { effect: "^3.12.5" },
			// No peerDependencies at all
		});

		mockGetPackageInfosAsync.mockResolvedValue({
			"my-lib": {
				name: "my-lib",
				packageJsonPath: join(pkgDir, "package.json"),
				path: pkgDir,
				version: "1.0.0",
			},
		});

		const devUpdates: DependencyUpdateResult[] = [
			{
				dependency: "effect",
				from: "^3.12.0",
				to: "^3.12.5",
				type: "devDependency",
				package: "my-lib",
			},
		];

		const results = await Effect.runPromise(
			syncPeers({ lock: ["effect"], minor: [] }, devUpdates, tmpDir).pipe(Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(results).toHaveLength(0);
	});

	it("should skip newly-added deps (from is null)", async () => {
		const tmpDir = makeTempDir();
		writePackageJson(tmpDir, { name: "root", version: "1.0.0" });
		const pkgDir = join(tmpDir, "packages", "my-lib");
		mkdirSync(pkgDir, { recursive: true });
		writePackageJson(pkgDir, {
			name: "my-lib",
			peerDependencies: { effect: "^3.0.0" },
		});

		mockGetPackageInfosAsync.mockResolvedValue({
			"my-lib": { packageJsonPath: join(pkgDir, "package.json") },
		});

		const devUpdates: DependencyUpdateResult[] = [
			{
				dependency: "effect",
				from: null,
				to: "^3.12.5",
				type: "devDependency",
				package: "my-lib",
			},
		];

		const results = await Effect.runPromise(
			syncPeers({ lock: ["effect"], minor: [] }, devUpdates, tmpDir).pipe(Logger.withMinimumLogLevel(LogLevel.None)),
		);

		expect(results).toHaveLength(0);

		// Verify peer was NOT changed
		const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"));
		expect(pkg.peerDependencies.effect).toBe("^3.0.0");
	});
});
