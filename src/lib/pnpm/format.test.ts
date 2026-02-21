import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, LogLevel, Logger } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const runEffect = <A>(effect: Effect.Effect<A>) =>
	Effect.runPromise(effect.pipe(Logger.withMinimumLogLevel(LogLevel.None)));

import type { PnpmWorkspaceContent } from "./format.js";
import { formatWorkspaceYaml, getConfigDependencyVersion, readWorkspaceYaml, sortContent } from "./format.js";

describe("sortContent", () => {
	it("sorts top-level keys alphabetically with packages first", () => {
		const input: PnpmWorkspaceContent = {
			onlyBuiltDependencies: ["pkg-b"],
			configDependencies: { typescript: "5.4.0" },
			packages: ["pkgs/*"],
		};

		const result = sortContent(input);
		const keys = Object.keys(result);

		expect(keys[0]).toBe("packages");
		expect(keys).toEqual(["packages", "configDependencies", "onlyBuiltDependencies"]);
	});

	it("sorts array values for sortable keys", () => {
		const input: PnpmWorkspaceContent = {
			packages: ["pkgs/*", "apps/*", "lib/*"],
			onlyBuiltDependencies: ["sharp", "better-sqlite3", "argon2"],
			publicHoistPattern: ["@types/*", "@biomejs/*"],
		};

		const result = sortContent(input);

		expect(result.packages).toEqual(["apps/*", "lib/*", "pkgs/*"]);
		expect(result.onlyBuiltDependencies).toEqual(["argon2", "better-sqlite3", "sharp"]);
		expect(result.publicHoistPattern).toEqual(["@biomejs/*", "@types/*"]);
	});

	it("sorts configDependencies keys alphabetically", () => {
		const input: PnpmWorkspaceContent = {
			configDependencies: { typescript: "5.4.0", "@biomejs/biome": "1.6.1", "@savvy-web/silk": "0.6.3" },
			customKey: "some-value",
		};

		const result = sortContent(input);

		expect(Object.keys(result.configDependencies ?? {})).toEqual(["@biomejs/biome", "@savvy-web/silk", "typescript"]);
		expect(result.configDependencies).toEqual({
			"@biomejs/biome": "1.6.1",
			"@savvy-web/silk": "0.6.3",
			typescript: "5.4.0",
		});
		expect(result.customKey).toBe("some-value");
	});

	it("handles empty input", () => {
		const result = sortContent({});
		expect(result).toEqual({});
	});

	it("handles input with only packages", () => {
		const input: PnpmWorkspaceContent = {
			packages: ["b", "a"],
		};

		const result = sortContent(input);

		expect(Object.keys(result)).toEqual(["packages"]);
		expect(result.packages).toEqual(["a", "b"]);
	});

	it("handles input with no sortable arrays", () => {
		const input: PnpmWorkspaceContent = {
			configDependencies: { zlib: "1.0.0", acorn: "8.0.0" },
			customField: 42,
		};

		const result = sortContent(input);

		expect(Object.keys(result)).toEqual(["configDependencies", "customField"]);
		// configDependencies keys should be sorted
		expect(Object.keys(result.configDependencies ?? {})).toEqual(["acorn", "zlib"]);
	});

	it("does not mutate the input object", () => {
		const originalPackages = ["c", "a", "b"];
		const input: PnpmWorkspaceContent = {
			packages: originalPackages,
		};

		sortContent(input);

		expect(originalPackages).toEqual(["c", "a", "b"]);
	});
});

describe("formatWorkspaceYaml", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "format-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("formats and sorts pnpm-workspace.yaml", async () => {
		writeFileSync(
			join(tempDir, "pnpm-workspace.yaml"),
			`onlyBuiltDependencies:\n  - sharp\n  - argon2\npackages:\n  - "pkgs/*"\n  - "apps/*"\n`,
		);

		await runEffect(formatWorkspaceYaml(tempDir));

		const result = await runEffect(readWorkspaceYaml(tempDir));
		expect(result).not.toBeNull();
		// After formatting, packages should be first and sorted
		const keys = Object.keys(result ?? {});
		expect(keys[0]).toBe("packages");
		expect(result?.packages).toEqual(["apps/*", "pkgs/*"]);
		expect(result?.onlyBuiltDependencies).toEqual(["argon2", "sharp"]);
	});

	it("handles missing pnpm-workspace.yaml gracefully", async () => {
		// Should not throw when file doesn't exist
		await runEffect(formatWorkspaceYaml(tempDir));
	});

	it("handles invalid YAML gracefully", async () => {
		writeFileSync(join(tempDir, "pnpm-workspace.yaml"), ": invalid: yaml: {{{}");

		const result = await runEffect(formatWorkspaceYaml(tempDir).pipe(Effect.either));

		expect(result._tag).toBe("Left");
	});

	it("handles unreadable file", async () => {
		const filepath = join(tempDir, "pnpm-workspace.yaml");
		writeFileSync(filepath, `packages:\n  - "pkgs/*"\n`);
		chmodSync(filepath, 0o000);

		const result = await runEffect(formatWorkspaceYaml(tempDir).pipe(Effect.either));

		expect(result._tag).toBe("Left");
		// Restore perms for cleanup
		chmodSync(filepath, 0o644);
	});

	it("handles unwritable file", async () => {
		const filepath = join(tempDir, "pnpm-workspace.yaml");
		writeFileSync(filepath, `packages:\n  - "pkgs/*"\n`);
		// Make file readable but not writable
		chmodSync(filepath, 0o444);

		const result = await runEffect(formatWorkspaceYaml(tempDir).pipe(Effect.either));

		expect(result._tag).toBe("Left");
		// Restore perms for cleanup
		chmodSync(filepath, 0o644);
	});
});

describe("readWorkspaceYaml", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "read-yaml-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("reads and parses valid YAML", async () => {
		writeFileSync(
			join(tempDir, "pnpm-workspace.yaml"),
			`packages:\n  - "pkgs/*"\nconfigDependencies:\n  typescript: "5.4.0"\n`,
		);

		const result = await runEffect(readWorkspaceYaml(tempDir));

		expect(result).not.toBeNull();
		expect(result?.packages).toEqual(["pkgs/*"]);
		expect(result?.configDependencies).toEqual({ typescript: "5.4.0" });
	});

	it("returns null when file does not exist", async () => {
		const result = await runEffect(readWorkspaceYaml(tempDir));
		expect(result).toBeNull();
	});
});

describe("getConfigDependencyVersion", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "config-ver-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns version for existing config dependency", async () => {
		writeFileSync(join(tempDir, "pnpm-workspace.yaml"), `configDependencies:\n  typescript: "5.4.0+sha512-abc123"\n`);

		const result = await runEffect(getConfigDependencyVersion("typescript", tempDir));
		expect(result).toBe("5.4.0");
	});

	it("returns null for nonexistent dependency", async () => {
		writeFileSync(join(tempDir, "pnpm-workspace.yaml"), `configDependencies:\n  typescript: "5.4.0"\n`);

		const result = await runEffect(getConfigDependencyVersion("biome", tempDir));
		expect(result).toBeNull();
	});

	it("returns null when no configDependencies key", async () => {
		writeFileSync(join(tempDir, "pnpm-workspace.yaml"), `packages:\n  - "pkgs/*"\n`);

		const result = await runEffect(getConfigDependencyVersion("typescript", tempDir));
		expect(result).toBeNull();
	});

	it("returns null when file does not exist", async () => {
		const result = await runEffect(getConfigDependencyVersion("typescript", tempDir));
		expect(result).toBeNull();
	});
});
