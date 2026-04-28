import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, LogLevel, Logger } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { WorkspacePackage } from "workspaces-effect";
import { WorkspaceDiscovery, WorkspaceDiscoveryError } from "workspaces-effect";
import type { DependencyUpdateResult } from "../schemas/domain.js";
import { computePeerRange, syncPeers } from "./peer-sync.js";

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

/**
 * Build a WorkspaceDiscovery mock layer that returns the given packages list.
 */
const makeWorkspacesLayer = (packages: ReadonlyArray<{ name: string; path: string }>) =>
	Layer.succeed(WorkspaceDiscovery, {
		listPackages: vi.fn(() => Effect.succeed(packages as unknown as ReadonlyArray<WorkspacePackage>)),
		getPackage: vi.fn(() => Effect.die("getPackage not used in peer-sync tests")),
		importerMap: vi.fn(() => Effect.succeed(new Map())),
	});

/**
 * Build a WorkspaceDiscovery mock layer that fails with a WorkspaceDiscoveryError.
 */
const makeFailingWorkspacesLayer = () =>
	Layer.succeed(WorkspaceDiscovery, {
		listPackages: vi.fn((root?: string) =>
			Effect.fail(
				new WorkspaceDiscoveryError({
					root: root ?? "",
					reason: "workspace detection failed",
				}),
			),
		),
		getPackage: vi.fn(() => Effect.die("getPackage not used in peer-sync tests")),
		importerMap: vi.fn(() => Effect.succeed(new Map())),
	});

/**
 * Run a syncPeers Effect with the given WorkspaceDiscovery layer, suppressing logs.
 */
const runSyncPeers = (
	config: { lock: string[]; minor: string[] },
	devUpdates: DependencyUpdateResult[],
	workspacesLayer: Layer.Layer<WorkspaceDiscovery>,
	workspaceRoot: string,
) =>
	Effect.runPromise(
		syncPeers(config, devUpdates, workspaceRoot).pipe(
			Logger.withMinimumLogLevel(LogLevel.None),
			Effect.provide(workspacesLayer),
		),
	);

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

		const workspacesLayer = makeWorkspacesLayer([
			{ name: "root", path: tmpDir },
			{ name: "my-lib", path: pkgDir },
		]);

		const devUpdates: DependencyUpdateResult[] = [
			{
				dependency: "effect",
				from: "^3.12.0",
				to: "^3.12.5",
				type: "devDependency",
				package: "my-lib",
			},
		];

		const results = await runSyncPeers({ lock: ["effect"], minor: [] }, devUpdates, workspacesLayer, tmpDir);

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

		const workspacesLayer = makeWorkspacesLayer([
			{ name: "root", path: tmpDir },
			{ name: "my-lib", path: pkgDir },
		]);

		const devUpdates: DependencyUpdateResult[] = [
			{
				dependency: "effect",
				from: "^3.12.0",
				to: "^3.12.5",
				type: "devDependency",
				package: "my-lib",
			},
		];

		const results = await runSyncPeers({ lock: [], minor: ["effect"] }, devUpdates, workspacesLayer, tmpDir);

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

		const workspacesLayer = makeWorkspacesLayer([
			{ name: "root", path: tmpDir },
			{ name: "my-lib", path: pkgDir },
		]);

		const devUpdates: DependencyUpdateResult[] = [
			{
				dependency: "effect",
				from: "^3.12.0",
				to: "^3.13.2",
				type: "devDependency",
				package: "my-lib",
			},
		];

		const results = await runSyncPeers({ lock: [], minor: ["effect"] }, devUpdates, workspacesLayer, tmpDir);

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

		const workspacesLayer = makeWorkspacesLayer([
			{ name: "root", path: tmpDir },
			{ name: "my-lib", path: pkgDir },
		]);

		const devUpdates: DependencyUpdateResult[] = [
			{
				dependency: "effect",
				from: "^3.12.0",
				to: "^3.12.5",
				type: "devDependency",
				package: "my-lib",
			},
		];

		const results = await runSyncPeers({ lock: ["effect"], minor: [] }, devUpdates, workspacesLayer, tmpDir);

		expect(results).toHaveLength(0);
	});

	it("should continue when workspace info query fails", async () => {
		const tmpDir = makeTempDir();
		writePackageJson(tmpDir, { name: "root", version: "1.0.0" });

		const workspacesLayer = makeFailingWorkspacesLayer();

		const devUpdates: DependencyUpdateResult[] = [
			{
				dependency: "effect",
				from: "^3.12.0",
				to: "^3.12.5",
				type: "devDependency",
				package: "root",
			},
		];

		const results = await runSyncPeers({ lock: ["effect"], minor: [] }, devUpdates, workspacesLayer, tmpDir);

		// Should still return results for packages it can resolve
		// Root package path is resolved independently of workspace-tools
		expect(results).toHaveLength(0);
	});

	it("should warn and skip when package path not found", async () => {
		const tmpDir = makeTempDir();
		writePackageJson(tmpDir, { name: "root", version: "1.0.0" });

		const workspacesLayer = makeWorkspacesLayer([{ name: "root", path: tmpDir }]);

		const devUpdates: DependencyUpdateResult[] = [
			{
				dependency: "effect",
				from: "^3.12.0",
				to: "^3.12.5",
				type: "devDependency",
				package: "nonexistent-package",
			},
		];

		const results = await runSyncPeers({ lock: ["effect"], minor: [] }, devUpdates, workspacesLayer, tmpDir);

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

		const workspacesLayer = makeWorkspacesLayer([
			{ name: "root", path: tmpDir },
			{ name: "my-lib", path: pkgDir },
		]);

		const devUpdates: DependencyUpdateResult[] = [
			{
				dependency: "effect",
				from: null,
				to: "^3.12.5",
				type: "devDependency",
				package: "my-lib",
			},
		];

		const results = await runSyncPeers({ lock: ["effect"], minor: [] }, devUpdates, workspacesLayer, tmpDir);

		expect(results).toHaveLength(0);

		// Verify peer was NOT changed
		const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"));
		expect(pkg.peerDependencies.effect).toBe("^3.0.0");
	});
});
