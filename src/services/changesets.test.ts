/**
 * Unit tests for the rewritten Changesets service.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import type { WorkspacePackage } from "workspaces-effect";
import { PublishTarget, PublishabilityDetector } from "workspaces-effect";

import type { DependencyUpdateResult, LockfileChange } from "../schemas/domain.js";
import { ChangesetConfig } from "./changeset-config.js";
import { Changesets, ChangesetsLive } from "./changesets.js";
import { Workspaces } from "./workspaces.js";

const mockWorkspaces = (packages: ReadonlyArray<{ name: string; path: string }>) =>
	Layer.succeed(Workspaces, {
		listPackages: () => Effect.succeed(packages),
		importerMap: () => Effect.die("not used"),
	});

/**
 * Mock PublishabilityDetector: versionable names produce one PublishTarget,
 * others produce [].
 *
 * Changesets constructs a WorkspacePackage from disk and calls detect().
 * The mock matches by pkg.name.
 */
const mockDetector = (versionableNames: ReadonlySet<string>) =>
	Layer.succeed(PublishabilityDetector, {
		detect: (pkg: WorkspacePackage) =>
			Effect.succeed(
				versionableNames.has(pkg.name)
					? [
							new PublishTarget({
								name: pkg.name,
								registry: "https://registry.npmjs.org/",
								directory: ".",
								access: "public",
							}),
						]
					: [],
			),
	});

/**
 * Mock ChangesetConfig with configurable versionPrivate.
 */
const mockConfig = (versionPrivate = false) =>
	Layer.succeed(ChangesetConfig, {
		mode: () => Effect.succeed("silk" as const),
		versionPrivate: () => Effect.succeed(versionPrivate),
	});

const setupChangesetDir = (root: string): void => {
	mkdirSync(join(root, ".changeset"), { recursive: true });
};

const writePkgJson = (dir: string, content: unknown): void => {
	writeFileSync(join(dir, "package.json"), JSON.stringify(content));
};

const readChangesets = (root: string): ReadonlyArray<{ name: string; content: string }> => {
	const dir = join(root, ".changeset");
	return readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.map((f) => ({ name: f, content: readFileSync(join(dir, f), "utf-8") }));
};

describe("Changesets — versionable + trigger gating", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "cs-"));
	});

	const runCreate = (
		packages: ReadonlyArray<{ name: string; path: string }>,
		versionable: ReadonlySet<string>,
		lockfileChanges: ReadonlyArray<LockfileChange>,
		devUpdates: ReadonlyArray<DependencyUpdateResult> = [],
		peerUpdates: ReadonlyArray<DependencyUpdateResult> = [],
		versionPrivate = false,
	) =>
		Effect.runPromise(
			Effect.flatMap(Changesets, (c) => c.create(tmpDir, lockfileChanges, devUpdates, peerUpdates)).pipe(
				Effect.provide(
					ChangesetsLive.pipe(
						Layer.provide(
							Layer.mergeAll(mockWorkspaces(packages), mockDetector(versionable), mockConfig(versionPrivate)),
						),
					),
				),
			),
		);

	it("returns [] when .changeset/ does not exist", async () => {
		writePkgJson(tmpDir, { name: "@x/a", version: "1.0.0" });
		const result = await runCreate([{ name: "@x/a", path: tmpDir }], new Set(["@x/a"]), [
			{ type: "dependency", dependency: "lodash", from: "^4.17.20", to: "^4.17.21", affectedPackages: ["@x/a"] },
		]);
		expect(result).toEqual([]);
	});

	it("writes a changeset for a versionable package with a dependency trigger", async () => {
		setupChangesetDir(tmpDir);
		writePkgJson(tmpDir, { name: "@x/a", version: "1.0.0" });
		const result = await runCreate([{ name: "@x/a", path: tmpDir }], new Set(["@x/a"]), [
			{ type: "dependency", dependency: "lodash", from: "^4.17.20", to: "^4.17.21", affectedPackages: ["@x/a"] },
		]);
		expect(result).toHaveLength(1);
		const files = readChangesets(tmpDir);
		expect(files[0].content).toContain('"@x/a": patch');
		expect(files[0].content).toContain("| lodash |");
	});

	it("does NOT write a changeset for devDep-only changes", async () => {
		setupChangesetDir(tmpDir);
		writePkgJson(tmpDir, { name: "@x/a", version: "1.0.0" });
		const result = await runCreate(
			[{ name: "@x/a", path: tmpDir }],
			new Set(["@x/a"]),
			[],
			[{ dependency: "rslib-builder", from: "^0.20.0", to: "^0.20.1", type: "devDependency", package: "@x/a" }],
		);
		expect(result).toEqual([]);
		expect(readChangesets(tmpDir)).toHaveLength(0);
	});

	it("does NOT write a changeset for non-versionable package even with trigger", async () => {
		setupChangesetDir(tmpDir);
		writePkgJson(tmpDir, { name: "@x/a", version: "1.0.0" });
		const result = await runCreate([{ name: "@x/a", path: tmpDir }], new Set(), [
			{ type: "dependency", dependency: "lodash", from: "^4.17.20", to: "^4.17.21", affectedPackages: ["@x/a"] },
		]);
		expect(result).toEqual([]);
	});

	it("writes a changeset for peer-sync rewrites", async () => {
		setupChangesetDir(tmpDir);
		writePkgJson(tmpDir, { name: "@x/a", version: "1.0.0" });
		const result = await runCreate(
			[{ name: "@x/a", path: tmpDir }],
			new Set(["@x/a"]),
			[],
			[],
			[{ dependency: "react", from: "^17.0.0", to: "^18.0.0", type: "peerDependency", package: "@x/a" }],
		);
		expect(result).toHaveLength(1);
	});

	it("includes devDep rows in table when changeset is created for other reasons", async () => {
		setupChangesetDir(tmpDir);
		writePkgJson(tmpDir, { name: "@x/a", version: "1.0.0" });
		await runCreate(
			[{ name: "@x/a", path: tmpDir }],
			new Set(["@x/a"]),
			[{ type: "dependency", dependency: "lodash", from: "^4.17.20", to: "^4.17.21", affectedPackages: ["@x/a"] }],
			[{ dependency: "rslib-builder", from: "^0.20.0", to: "^0.20.1", type: "devDependency", package: "@x/a" }],
		);
		const files = readChangesets(tmpDir);
		expect(files[0].content).toContain("| lodash |");
		expect(files[0].content).toContain("| rslib-builder |");
	});

	it("never writes empty changesets", async () => {
		setupChangesetDir(tmpDir);
		writePkgJson(tmpDir, { name: "@x/a", version: "1.0.0" });
		const result = await runCreate([{ name: "@x/a", path: tmpDir }], new Set(["@x/a"]), [], [], []);
		expect(result).toEqual([]);
		expect(readChangesets(tmpDir)).toHaveLength(0);
	});

	it("config-type lockfile changes never trigger a changeset", async () => {
		setupChangesetDir(tmpDir);
		writePkgJson(tmpDir, { name: "@x/a", version: "1.0.0" });
		const result = await runCreate([{ name: "@x/a", path: tmpDir }], new Set(["@x/a"]), [
			{ type: "config", dependency: "@savvy-web/x", from: "1.0.0", to: "2.0.0", affectedPackages: [] },
		]);
		expect(result).toEqual([]);
	});

	it("catalog change in devDependency does NOT trigger (informational only)", async () => {
		setupChangesetDir(tmpDir);
		writePkgJson(tmpDir, { name: "@x/a", version: "1.0.0" });
		const result = await runCreate([{ name: "@x/a", path: tmpDir }], new Set(["@x/a"]), [
			{ type: "devDependency", dependency: "lodash", from: "^4.17.20", to: "^4.17.21", affectedPackages: ["@x/a"] },
		]);
		expect(result).toEqual([]);
	});

	it("catalog change in peerDependency triggers a changeset", async () => {
		setupChangesetDir(tmpDir);
		writePkgJson(tmpDir, { name: "@x/a", version: "1.0.0" });
		const result = await runCreate([{ name: "@x/a", path: tmpDir }], new Set(["@x/a"]), [
			{ type: "peerDependency", dependency: "react", from: "^17", to: "^18", affectedPackages: ["@x/a"] },
		]);
		expect(result).toHaveLength(1);
	});

	it("non-publishable + versionPrivate=true → changeset written", async () => {
		setupChangesetDir(tmpDir);
		writePkgJson(tmpDir, { name: "@x/a", version: "1.0.0", private: true });
		// empty versionable set (not publishable), but versionPrivate=true
		const result = await runCreate(
			[{ name: "@x/a", path: tmpDir }],
			new Set(),
			[{ type: "dependency", dependency: "lodash", from: "^4.17.20", to: "^4.17.21", affectedPackages: ["@x/a"] }],
			[],
			[],
			true,
		);
		expect(result).toHaveLength(1);
	});
});
