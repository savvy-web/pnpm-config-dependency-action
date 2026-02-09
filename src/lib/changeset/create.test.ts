import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LockfileChange } from "../../types/index.js";
import { analyzeAffectedPackages, createChangesets, formatChangesetSummary, hasChangesets } from "./create.js";

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

describe("createChangesets", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "create-changeset-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns empty array when .changeset directory is missing", async () => {
		const changes: LockfileChange[] = [
			{ type: "regular", dependency: "effect", from: "3.0.0", to: "3.1.0", affectedPackages: ["@savvy-web/core"] },
		];

		const result = await Effect.runPromise(createChangesets(changes, tempDir));
		expect(result).toEqual([]);
	});

	it("returns empty array when no changes", async () => {
		mkdirSync(join(tempDir, ".changeset"));

		const result = await Effect.runPromise(createChangesets([], tempDir));
		expect(result).toEqual([]);
	});

	it("creates changeset file for regular dependency changes", async () => {
		mkdirSync(join(tempDir, ".changeset"));

		const changes: LockfileChange[] = [
			{ type: "regular", dependency: "effect", from: "3.0.0", to: "3.1.0", affectedPackages: ["@savvy-web/core"] },
		];

		const result = await Effect.runPromise(createChangesets(changes, tempDir));

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

		const result = await Effect.runPromise(createChangesets(changes, tempDir));

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

		const result = await Effect.runPromise(createChangesets(changes, tempDir));

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
			{ type: "regular", dependency: "effect", from: "3.0.0", to: "3.1.0", affectedPackages: ["@savvy-web/core"] },
		];

		const result = await Effect.runPromise(createChangesets(changes, tempDir));

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
				type: "regular",
				dependency: "effect",
				from: "3.0.0",
				to: "3.1.0",
				affectedPackages: ["@savvy-web/core", "@savvy-web/utils"],
			},
		];

		const result = await Effect.runPromise(createChangesets(changes, tempDir));

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
			{ type: "regular", dependency: "effect", from: "3.0.0", to: "3.1.0", affectedPackages: ["@savvy-web/core"] },
		];

		const result = analyzeAffectedPackages(changes);

		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("@savvy-web/core");
		expect(result[0].changes).toHaveLength(1);
		expect(result[0].changes[0].dependency).toBe("effect");
	});

	it("maps change fields correctly", () => {
		const changes: LockfileChange[] = [
			{ type: "regular", dependency: "effect", from: "3.0.0", to: "3.1.0", affectedPackages: ["@savvy-web/core"] },
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
				type: "regular",
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
	it("formats config dependency changes with arrows", () => {
		const changes: LockfileChange[] = [
			{ type: "config", dependency: "typescript", from: "5.3.3", to: "5.4.0", affectedPackages: [] },
		];

		const result = formatChangesetSummary(changes);

		expect(result).toContain("**Config dependencies:**");
		expect(result).toContain("- typescript: 5.3.3 → 5.4.0");
	});

	it("formats regular dependency changes", () => {
		const changes: LockfileChange[] = [
			{ type: "regular", dependency: "effect", from: "3.0.0", to: "3.1.0", affectedPackages: ["@savvy-web/core"] },
		];

		const result = formatChangesetSummary(changes);

		expect(result).toContain("**Dependencies:**");
		expect(result).toContain("- effect: 3.0.0 → 3.1.0");
	});

	it("handles new dependencies (from is null)", () => {
		const changes: LockfileChange[] = [
			{
				type: "regular",
				dependency: "@effect/schema",
				from: null,
				to: "0.61.0",
				affectedPackages: ["@savvy-web/core"],
			},
		];

		const result = formatChangesetSummary(changes);

		expect(result).toContain("- @effect/schema: 0.61.0 (new)");
	});

	it("formats mixed config and regular changes", () => {
		const changes: LockfileChange[] = [
			{ type: "config", dependency: "typescript", from: "5.3.3", to: "5.4.0", affectedPackages: [] },
			{ type: "regular", dependency: "effect", from: "3.0.0", to: "3.1.0", affectedPackages: ["@savvy-web/core"] },
		];

		const result = formatChangesetSummary(changes);

		expect(result).toContain("**Config dependencies:**");
		expect(result).toContain("**Dependencies:**");
		expect(result).toContain("- typescript: 5.3.3 → 5.4.0");
		expect(result).toContain("- effect: 3.0.0 → 3.1.0");
	});

	it("starts with Update dependencies header", () => {
		const changes: LockfileChange[] = [
			{ type: "regular", dependency: "effect", from: "3.0.0", to: "3.1.0", affectedPackages: ["@savvy-web/core"] },
		];

		const result = formatChangesetSummary(changes);

		expect(result).toMatch(/^Update dependencies:/);
	});

	it("handles config-only changes with new dependency", () => {
		const changes: LockfileChange[] = [
			{ type: "config", dependency: "@biomejs/biome", from: null, to: "1.6.1", affectedPackages: [] },
		];

		const result = formatChangesetSummary(changes);

		expect(result).toContain("- @biomejs/biome: 1.6.1 (new)");
	});
});
