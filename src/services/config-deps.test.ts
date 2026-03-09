import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NpmRegistryTest } from "@savvy-web/github-action-effects";
import { Effect, Layer, LogLevel, Logger } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseConfigEntry } from "../utils/deps.js";
import { ConfigDeps, ConfigDepsLive } from "./config-deps.js";

// ══════════════════════════════════════════════════════════════════════════════
// Test Helpers
// ══════════════════════════════════════════════════════════════════════════════

const makeRegistryState = (
	packages: Record<string, { version: string; integrity?: string }>,
): Map<
	string,
	{
		versions: string[];
		latest: string;
		distTags: Record<string, string>;
		integrity?: string;
		tarball?: string;
	}
> => {
	const map = new Map<
		string,
		{
			versions: string[];
			latest: string;
			distTags: Record<string, string>;
			integrity?: string;
			tarball?: string;
		}
	>();
	for (const [name, info] of Object.entries(packages)) {
		map.set(name, {
			versions: [info.version],
			latest: info.version,
			distTags: { latest: info.version },
			integrity: info.integrity,
		});
	}
	return map;
};

const runWithService = <A, E>(
	fn: (service: ConfigDeps) => Effect.Effect<A, E>,
	packages?: Record<string, { version: string; integrity?: string }>,
) => {
	const registryLayer = packages
		? NpmRegistryTest.layer({ packages: makeRegistryState(packages) })
		: NpmRegistryTest.empty();
	const layer = ConfigDepsLive.pipe(Layer.provide(registryLayer));
	return Effect.runPromise(
		Effect.gen(function* () {
			const service = yield* ConfigDeps;
			return yield* fn(service);
		}).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
	);
};

// ══════════════════════════════════════════════════════════════════════════════
// parseConfigEntry
// ══════════════════════════════════════════════════════════════════════════════

describe("parseConfigEntry", () => {
	it("parses version with hash", () => {
		const result = parseConfigEntry("0.6.3+sha512-abc==");
		expect(result).toEqual({ version: "0.6.3", hash: "sha512-abc==" });
	});

	it("parses version without hash", () => {
		const result = parseConfigEntry("0.6.3");
		expect(result).toEqual({ version: "0.6.3", hash: null });
	});

	it("handles hash containing + chars (base64)", () => {
		const result = parseConfigEntry("0.6.3+sha512-ab+cd/ef==");
		expect(result).toEqual({ version: "0.6.3", hash: "sha512-ab+cd/ef==" });
	});

	it("returns null for empty string", () => {
		expect(parseConfigEntry("")).toBeNull();
	});

	it("returns null for whitespace-only string", () => {
		expect(parseConfigEntry("   ")).toBeNull();
	});
});

// ══════════════════════════════════════════════════════════════════════════════
// ConfigDeps service (Effect integration tests)
// ══════════════════════════════════════════════════════════════════════════════

describe("ConfigDeps.updateConfigDeps", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "config-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	const writeWorkspaceYaml = (content: string) => {
		writeFileSync(join(tempDir, "pnpm-workspace.yaml"), content, "utf-8");
	};

	const readWorkspaceYaml = () => {
		return parse(readFileSync(join(tempDir, "pnpm-workspace.yaml"), "utf-8"));
	};

	it("returns empty array when no deps provided", async () => {
		const result = await runWithService((s) => s.updateConfigDeps([]));
		expect(result).toEqual([]);
	});

	it("returns empty array when no workspace yaml exists", async () => {
		const result = await runWithService((s) => s.updateConfigDeps(["typescript"], tempDir));
		expect(result).toEqual([]);
	});

	it("returns empty array when no configDependencies section", async () => {
		writeWorkspaceYaml(`packages:\n  - "pkgs/*"\n`);

		const result = await runWithService((s) => s.updateConfigDeps(["typescript"], tempDir));
		expect(result).toEqual([]);
	});

	it("skips dep not in configDependencies", async () => {
		writeWorkspaceYaml(`configDependencies:\n  typescript: "5.3.3"\n`);

		const result = await runWithService((s) => s.updateConfigDeps(["nonexistent"], tempDir));
		expect(result).toEqual([]);
	});

	it("updates single dep when newer version available", async () => {
		writeWorkspaceYaml(`configDependencies:\n  "@savvy-web/silk": "0.6.3+sha512-oldHash=="\n`);

		const result = await runWithService((s) => s.updateConfigDeps(["@savvy-web/silk"], tempDir), {
			"@savvy-web/silk": { version: "0.7.0", integrity: "sha512-newHash==" },
		});

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			dependency: "@savvy-web/silk",
			from: "0.6.3",
			to: "0.7.0",
			type: "config",
			package: null,
		});

		// Verify YAML was updated
		const yaml = readWorkspaceYaml();
		expect(yaml.configDependencies["@savvy-web/silk"]).toBe("0.7.0+sha512-newHash==");
	});

	it("skips dep when already on latest version", async () => {
		writeWorkspaceYaml(`configDependencies:\n  typescript: "5.4.0+sha512-existingHash=="\n`);

		const result = await runWithService((s) => s.updateConfigDeps(["typescript"], tempDir), {
			typescript: { version: "5.4.0", integrity: "sha512-existingHash==" },
		});

		expect(result).toHaveLength(0);
	});

	it("updates multiple deps", async () => {
		writeWorkspaceYaml(`configDependencies:\n  typescript: "5.3.3"\n  "@biomejs/biome": "1.5.0+sha512-oldHash=="\n`);

		const result = await runWithService((s) => s.updateConfigDeps(["typescript", "@biomejs/biome"], tempDir), {
			typescript: { version: "5.4.0", integrity: "sha512-tsHash==" },
			"@biomejs/biome": { version: "1.6.1", integrity: "sha512-biomeHash==" },
		});

		expect(result).toHaveLength(2);
		expect(result.find((r) => r.dependency === "typescript")?.to).toBe("5.4.0");
		expect(result.find((r) => r.dependency === "@biomejs/biome")?.to).toBe("1.6.1");
	});

	it("continues when npm query fails for one dep", async () => {
		writeWorkspaceYaml(`configDependencies:\n  "bad-pkg": "1.0.0"\n  "good-pkg": "1.0.0"\n`);

		// Only provide "good-pkg" in registry; "bad-pkg" will fail automatically
		const result = await runWithService((s) => s.updateConfigDeps(["bad-pkg", "good-pkg"], tempDir), {
			"good-pkg": { version: "2.0.0", integrity: "sha512-goodHash==" },
		});

		expect(result).toHaveLength(1);
		expect(result[0].dependency).toBe("good-pkg");
	});

	it("preserves other yaml keys", async () => {
		writeWorkspaceYaml(
			[
				`packages:`,
				`  - "pkgs/*"`,
				`  - "apps/*"`,
				`onlyBuiltDependencies:`,
				`  - sharp`,
				`configDependencies:`,
				`  typescript: "5.3.3"`,
				``,
			].join("\n"),
		);

		await runWithService((s) => s.updateConfigDeps(["typescript"], tempDir), {
			typescript: { version: "5.4.0", integrity: "sha512-tsHash==" },
		});

		const yaml = readWorkspaceYaml();
		expect(yaml.packages).toBeDefined();
		expect(yaml.onlyBuiltDependencies).toBeDefined();
		expect(yaml.configDependencies.typescript).toBe("5.4.0+sha512-tsHash==");
	});

	it("reports clean versions in from/to (strips hash)", async () => {
		writeWorkspaceYaml(`configDependencies:\n  "@savvy-web/silk": "0.6.3+sha512-P2oTH3CRDxvEqVtavf5adiX2B4=="\n`);

		const result = await runWithService((s) => s.updateConfigDeps(["@savvy-web/silk"], tempDir), {
			"@savvy-web/silk": { version: "0.7.0", integrity: "sha512-newHashValue==" },
		});

		expect(result).toHaveLength(1);
		// from should be clean version (no hash)
		expect(result[0].from).toBe("0.6.3");
		// to should be clean version (no hash)
		expect(result[0].to).toBe("0.7.0");
	});

	it("returns empty array when registry returns no integrity", async () => {
		writeWorkspaceYaml(`configDependencies:\n  typescript: "5.3.3"\n`);

		const result = await runWithService((s) => s.updateConfigDeps(["typescript"], tempDir), {
			typescript: { version: "5.4.0" }, // no integrity
		});

		// queryConfigVersion returns null when integrity is missing
		expect(result).toHaveLength(0);
	});

	it("skips dep when parseConfigEntry returns null (empty value)", async () => {
		writeWorkspaceYaml(`configDependencies:\n  typescript: ""\n`);

		const result = await runWithService((s) => s.updateConfigDeps(["typescript"], tempDir));
		expect(result).toHaveLength(0);
	});

	it("handles config dep without hash suffix", async () => {
		writeWorkspaceYaml(`configDependencies:\n  typescript: "5.3.3"\n`);

		const result = await runWithService((s) => s.updateConfigDeps(["typescript"], tempDir), {
			typescript: { version: "5.4.0", integrity: "sha512-tsHash==" },
		});

		expect(result).toHaveLength(1);
		expect(result[0].from).toBe("5.3.3");
		expect(result[0].to).toBe("5.4.0");

		// YAML entry should have the full integrity hash
		const yaml = readWorkspaceYaml();
		expect(yaml.configDependencies.typescript).toBe("5.4.0+sha512-tsHash==");
	});
});
