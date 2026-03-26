import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, LogLevel, Logger } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DependencyUpdateResult, LockfileChange } from "../schemas/domain.js";
import {
	Changesets,
	ChangesetsLive,
	analyzeAffectedPackages,
	createChangesets,
	formatChangesetSummary,
	hasChangesets,
} from "./changesets.js";

/**
 * Run an Effect with logging suppressed.
 */
const runEffect = <A, E>(effect: Effect.Effect<A, E>) =>
	Effect.runPromise(effect.pipe(Logger.withMinimumLogLevel(LogLevel.None)) as Effect.Effect<A>);

describe("hasChangesets", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "changeset-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns true when .changeset directory exists", () => {
		mkdirSync(join(tempDir, ".changeset"));
		expect(hasChangesets(tempDir)).toBe(true);
	});

	it("returns false when .changeset directory is missing", () => {
		expect(hasChangesets(tempDir)).toBe(false);
	});
});

describe("Changesets.create", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "create-changeset-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns empty array when .changeset directory is missing", async () => {
		const changes: LockfileChange[] = [
			{ type: "dependency", dependency: "effect", from: "3.0.0", to: "3.1.0", affectedPackages: ["@savvy-web/core"] },
		];

		const result = await runEffect(
			Effect.gen(function* () {
				const cs = yield* Changesets;
				return yield* cs.create(changes, [], [], tempDir);
			}).pipe(Effect.provide(ChangesetsLive)),
		);
		expect(result).toEqual([]);
	});

	it("returns empty array when no changes", async () => {
		mkdirSync(join(tempDir, ".changeset"));

		const result = await runEffect(
			Effect.gen(function* () {
				const cs = yield* Changesets;
				return yield* cs.create([], [], [], tempDir);
			}).pipe(Effect.provide(ChangesetsLive)),
		);
		expect(result).toEqual([]);
	});

	it("creates changeset file for regular dependency changes", async () => {
		mkdirSync(join(tempDir, ".changeset"));

		const changes: LockfileChange[] = [
			{ type: "dependency", dependency: "effect", from: "3.0.0", to: "3.1.0", affectedPackages: ["@savvy-web/core"] },
		];

		const result = await runEffect(
			Effect.gen(function* () {
				const cs = yield* Changesets;
				return yield* cs.create(changes, [], [], tempDir);
			}).pipe(Effect.provide(ChangesetsLive)),
		);

		expect(result).toHaveLength(1);
		expect(result[0].packages).toEqual(["@savvy-web/core"]);
		expect(result[0].type).toBe("patch");
		expect(result[0].summary).toContain("effect");

		// Verify file was actually written
		const changesetFiles = readdirSync(join(tempDir, ".changeset")).filter((f) => f.endsWith(".md"));
		expect(changesetFiles).toHaveLength(1);

		const content = readFileSync(join(tempDir, ".changeset", changesetFiles[0]), "utf-8");
		expect(content).toContain('"@savvy-web/core": patch');
		expect(content).toContain("effect");
	});

	it("creates empty changeset for config dependency changes", async () => {
		mkdirSync(join(tempDir, ".changeset"));

		const changes: LockfileChange[] = [
			{ type: "config", dependency: "typescript", from: "5.3.3", to: "5.4.0", affectedPackages: [] },
		];

		const result = await runEffect(
			Effect.gen(function* () {
				const cs = yield* Changesets;
				return yield* cs.create(changes, [], [], tempDir);
			}).pipe(Effect.provide(ChangesetsLive)),
		);

		expect(result).toHaveLength(1);
		expect(result[0].packages).toEqual([]);
		expect(result[0].type).toBe("patch");
		expect(result[0].summary).toContain("typescript");
	});

	it("includes pnpm upgrade in root changeset summary", async () => {
		mkdirSync(join(tempDir, ".changeset"));

		const changes: LockfileChange[] = [
			{ type: "config", dependency: "pnpm", from: "10.28.2", to: "10.29.0", affectedPackages: [] },
			{ type: "config", dependency: "typescript", from: "5.3.3", to: "5.4.0", affectedPackages: [] },
		];

		const result = await runEffect(
			Effect.gen(function* () {
				const cs = yield* Changesets;
				return yield* cs.create(changes, [], [], tempDir);
			}).pipe(Effect.provide(ChangesetsLive)),
		);

		expect(result).toHaveLength(1);
		expect(result[0].packages).toEqual([]);
		expect(result[0].summary).toContain("pnpm");
		expect(result[0].summary).toContain("10.28.2");
		expect(result[0].summary).toContain("10.29.0");
		expect(result[0].summary).toContain("typescript");
	});

	it("creates separate changesets for packages and root", async () => {
		mkdirSync(join(tempDir, ".changeset"));

		const changes: LockfileChange[] = [
			{ type: "config", dependency: "typescript", from: "5.3.3", to: "5.4.0", affectedPackages: [] },
			{ type: "dependency", dependency: "effect", from: "3.0.0", to: "3.1.0", affectedPackages: ["@savvy-web/core"] },
		];

		const result = await runEffect(
			Effect.gen(function* () {
				const cs = yield* Changesets;
				return yield* cs.create(changes, [], [], tempDir);
			}).pipe(Effect.provide(ChangesetsLive)),
		);

		expect(result).toHaveLength(2);
		// Should have one package changeset and one root/empty changeset
		const pkgChangeset = result.find((cs) => cs.packages.length > 0);
		const rootChangeset = result.find((cs) => cs.packages.length === 0);
		expect(pkgChangeset).toBeDefined();
		expect(rootChangeset).toBeDefined();
	});

	it("creates changeset for multiple affected packages from same dependency", async () => {
		mkdirSync(join(tempDir, ".changeset"));

		const changes: LockfileChange[] = [
			{
				type: "dependency",
				dependency: "effect",
				from: "3.0.0",
				to: "3.1.0",
				affectedPackages: ["@savvy-web/core", "@savvy-web/utils"],
			},
		];

		const result = await runEffect(
			Effect.gen(function* () {
				const cs = yield* Changesets;
				return yield* cs.create(changes, [], [], tempDir);
			}).pipe(Effect.provide(ChangesetsLive)),
		);

		// Each affected package gets its own changeset
		expect(result).toHaveLength(2);
		const packageNames = result.flatMap((cs) => cs.packages).sort();
		expect(packageNames).toEqual(["@savvy-web/core", "@savvy-web/utils"]);
	});
});

describe("analyzeAffectedPackages", () => {
	it("groups changes by package, excludes (root)", () => {
		const changes: LockfileChange[] = [
			{ type: "config", dependency: "typescript", from: "5.3.3", to: "5.4.0", affectedPackages: [] },
			{ type: "dependency", dependency: "effect", from: "3.0.0", to: "3.1.0", affectedPackages: ["@savvy-web/core"] },
		];

		const result = analyzeAffectedPackages(changes);

		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("@savvy-web/core");
		expect(result[0].changes).toHaveLength(1);
		expect(result[0].changes[0].dependency).toBe("effect");
	});

	it("maps change fields correctly", () => {
		const changes: LockfileChange[] = [
			{ type: "dependency", dependency: "effect", from: "3.0.0", to: "3.1.0", affectedPackages: ["@savvy-web/core"] },
		];

		const result = analyzeAffectedPackages(changes);

		expect(result[0].changes[0]).toEqual({
			dependency: "effect",
			from: "3.0.0",
			to: "3.1.0",
		});
	});

	it("returns empty array for config-only changes", () => {
		const changes: LockfileChange[] = [
			{ type: "config", dependency: "typescript", from: "5.3.3", to: "5.4.0", affectedPackages: [] },
		];

		const result = analyzeAffectedPackages(changes);
		expect(result).toHaveLength(0);
	});

	it("handles empty changes array", () => {
		const result = analyzeAffectedPackages([]);
		expect(result).toHaveLength(0);
	});

	it("handles changes affecting multiple packages", () => {
		const changes: LockfileChange[] = [
			{
				type: "dependency",
				dependency: "effect",
				from: "3.0.0",
				to: "3.1.0",
				affectedPackages: ["@savvy-web/core", "@savvy-web/utils"],
			},
		];

		const result = analyzeAffectedPackages(changes);

		expect(result).toHaveLength(2);
		expect(result.map((p) => p.name).sort()).toEqual(["@savvy-web/core", "@savvy-web/utils"]);
	});
});

describe("formatChangesetSummary", () => {
	it("starts with ## Dependencies heading and table header", () => {
		const changes: LockfileChange[] = [
			{ type: "dependency", dependency: "effect", from: "3.0.0", to: "3.1.0", affectedPackages: ["@savvy-web/core"] },
		];

		const result = formatChangesetSummary(changes);

		expect(result).toMatch(/^## Dependencies/);
		expect(result).toContain("| Dependency | Type | Action | From | To |");
		expect(result).toContain("| :--- | :--- | :--- | :--- | :--- |");
	});

	it("formats config dependency as table row with type 'config'", () => {
		const changes: LockfileChange[] = [
			{ type: "config", dependency: "typescript", from: "5.3.3", to: "5.4.0", affectedPackages: [] },
		];

		const result = formatChangesetSummary(changes);

		expect(result).toContain("| typescript | config | updated | 5.3.3 | 5.4.0 |");
	});

	it("formats regular dependency as table row with type 'dependency'", () => {
		const changes: LockfileChange[] = [
			{ type: "dependency", dependency: "effect", from: "3.0.0", to: "3.1.0", affectedPackages: ["@savvy-web/core"] },
		];

		const result = formatChangesetSummary(changes);

		expect(result).toContain("| effect | dependency | updated | 3.0.0 | 3.1.0 |");
	});

	it("uses em dash and 'added' action when from is null", () => {
		const changes: LockfileChange[] = [
			{
				type: "dependency",
				dependency: "@effect/schema",
				from: null,
				to: "0.61.0",
				affectedPackages: ["@savvy-web/core"],
			},
		];

		const result = formatChangesetSummary(changes);

		expect(result).toContain("| @effect/schema | dependency | added | \u2014 | 0.61.0 |");
	});

	it("renders all changes in a single table without sub-headings", () => {
		const changes: LockfileChange[] = [
			{ type: "config", dependency: "typescript", from: "5.3.3", to: "5.4.0", affectedPackages: [] },
			{ type: "dependency", dependency: "effect", from: "3.0.0", to: "3.1.0", affectedPackages: ["@savvy-web/core"] },
		];

		const result = formatChangesetSummary(changes);

		expect(result).toContain("| typescript | config | updated | 5.3.3 | 5.4.0 |");
		expect(result).toContain("| effect | dependency | updated | 3.0.0 | 3.1.0 |");
		expect(result).not.toContain("### Config");
		expect(result).not.toContain("### Packages");
	});

	it("handles config-only new dependency with em dash", () => {
		const changes: LockfileChange[] = [
			{ type: "config", dependency: "@biomejs/biome", from: null, to: "1.6.1", affectedPackages: [] },
		];

		const result = formatChangesetSummary(changes);

		expect(result).toContain("| @biomejs/biome | config | added | \u2014 | 1.6.1 |");
	});
});

describe("changeset triggering rules", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "changeset-trigger-test-"));
		mkdirSync(join(tempDir, ".changeset"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("should NOT create changeset for devDependency-only changes", async () => {
		const devUpdates: DependencyUpdateResult[] = [
			{
				dependency: "vitest",
				from: "1.0.0",
				to: "1.1.0",
				type: "devDependency",
				package: "@savvy-web/core",
			},
		];

		const result = await runEffect(createChangesets([], devUpdates, [], tempDir));

		expect(result).toEqual([]);
	});

	it("should create changeset when peerDependency changed, including all rows", async () => {
		const peerUpdates: DependencyUpdateResult[] = [
			{
				dependency: "react",
				from: "^18.0.0",
				to: "^19.0.0",
				type: "peerDependency",
				package: "@savvy-web/ui",
			},
		];

		const devUpdates: DependencyUpdateResult[] = [
			{
				dependency: "vitest",
				from: "1.0.0",
				to: "1.1.0",
				type: "devDependency",
				package: "@savvy-web/ui",
			},
		];

		const result = await runEffect(createChangesets([], devUpdates, peerUpdates, tempDir));

		expect(result).toHaveLength(1);
		expect(result[0].packages).toEqual(["@savvy-web/ui"]);

		// Summary should contain both the peer and the dev rows
		expect(result[0].summary).toContain("react");
		expect(result[0].summary).toContain("peerDependency");
		expect(result[0].summary).toContain("vitest");
		expect(result[0].summary).toContain("devDependency");

		// Verify file was written
		const changesetFiles = readdirSync(join(tempDir, ".changeset")).filter((f) => f.endsWith(".md"));
		expect(changesetFiles).toHaveLength(1);

		const content = readFileSync(join(tempDir, ".changeset", changesetFiles[0]), "utf-8");
		expect(content).toContain('"@savvy-web/ui": patch');
	});

	it("should create changeset when lockfile change exists, including dev rows", async () => {
		const lockfileChanges: LockfileChange[] = [
			{
				type: "dependency",
				dependency: "effect",
				from: "3.0.0",
				to: "3.1.0",
				affectedPackages: ["@savvy-web/core"],
			},
		];

		const devUpdates: DependencyUpdateResult[] = [
			{
				dependency: "vitest",
				from: "1.0.0",
				to: "1.1.0",
				type: "devDependency",
				package: "@savvy-web/core",
			},
		];

		const result = await runEffect(createChangesets(lockfileChanges, devUpdates, [], tempDir));

		expect(result).toHaveLength(1);
		expect(result[0].packages).toEqual(["@savvy-web/core"]);

		// Summary should contain both the lockfile change and the dev row
		expect(result[0].summary).toContain("effect");
		expect(result[0].summary).toContain("dependency");
		expect(result[0].summary).toContain("vitest");
		expect(result[0].summary).toContain("devDependency");
	});

	it("should not create changeset for package with only dev updates when another package has lockfile changes", async () => {
		const lockfileChanges: LockfileChange[] = [
			{
				type: "dependency",
				dependency: "effect",
				from: "3.0.0",
				to: "3.1.0",
				affectedPackages: ["@savvy-web/core"],
			},
		];

		const devUpdates: DependencyUpdateResult[] = [
			{
				dependency: "vitest",
				from: "1.0.0",
				to: "1.1.0",
				type: "devDependency",
				package: "@savvy-web/utils",
			},
		];

		const result = await runEffect(createChangesets(lockfileChanges, devUpdates, [], tempDir));

		// Only @savvy-web/core should get a changeset, not @savvy-web/utils
		expect(result).toHaveLength(1);
		expect(result[0].packages).toEqual(["@savvy-web/core"]);
	});
});
