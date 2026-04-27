import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NpmRegistryTest } from "@savvy-web/github-action-effects";
import type { Context } from "effect";
import { Effect, Layer, LogLevel, Logger } from "effect";
import { describe, expect, it } from "vitest";
import { FileSystemError } from "../errors/errors.js";
import { matchesPattern, parseSpecifier } from "../utils/deps.js";
import { RegularDeps, RegularDepsLive } from "./regular-deps.js";
import type { WorkspacePackageInfo } from "./workspaces.js";
import { Workspaces } from "./workspaces.js";

// ══════════════════════════════════════════════════════════════════════════════
// Test Helpers
// ══════════════════════════════════════════════════════════════════════════════

const makeTempDir = () => mkdtempSync(join(tmpdir(), "regular-test-"));

const writePackageJson = (dir: string, content: Record<string, unknown>) => {
	writeFileSync(join(dir, "package.json"), `${JSON.stringify(content, null, "\t")}\n`, "utf-8");
};

const readPackageJson = (dir: string) => {
	return JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
};

const makeRegistryState = (
	packages: Record<string, string>,
): Map<
	string,
	{
		versions: string[];
		latest: string;
		distTags: Record<string, string>;
	}
> => {
	const map = new Map<
		string,
		{
			versions: string[];
			latest: string;
			distTags: Record<string, string>;
		}
	>();
	for (const [name, version] of Object.entries(packages)) {
		map.set(name, {
			versions: [version],
			latest: version,
			distTags: { latest: version },
		});
	}
	return map;
};

/**
 * Create a Workspaces layer that returns a fixed list of packages.
 * Use this to control which package.json files the RegularDeps service sees.
 */
const mockWorkspaces = (packages: ReadonlyArray<WorkspacePackageInfo>): Layer.Layer<Workspaces> =>
	Layer.succeed(Workspaces, {
		listPackages: () => Effect.succeed(packages),
		importerMap: () => Effect.die("importerMap not used in regular-deps tests"),
	});

/**
 * Create a Workspaces layer that fails with a FileSystemError.
 * Used to test graceful degradation when workspace discovery fails.
 */
const failingWorkspaces = (): Layer.Layer<Workspaces> =>
	Layer.succeed(Workspaces, {
		listPackages: (root) =>
			Effect.fail(
				new FileSystemError({
					operation: "read",
					path: root,
					reason: "workspace detection failed",
				}),
			),
		importerMap: () => Effect.die("importerMap not used in regular-deps tests"),
	});

const runWithService = <A, E>(
	fn: (service: Context.Tag.Service<typeof RegularDeps>) => Effect.Effect<A, E>,
	packages?: Record<string, string>,
	workspacesLayer?: Layer.Layer<Workspaces>,
) => {
	const registryLayer = packages
		? NpmRegistryTest.layer({ packages: makeRegistryState(packages) })
		: NpmRegistryTest.empty();
	const wsLayer = workspacesLayer ?? mockWorkspaces([]);
	const layer = RegularDepsLive.pipe(Layer.provide(Layer.merge(registryLayer, wsLayer)));
	return Effect.runPromise(
		Effect.gen(function* () {
			const service = yield* RegularDeps;
			return yield* fn(service);
		}).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
	);
};

// ══════════════════════════════════════════════════════════════════════════════
// matchesPattern
// ══════════════════════════════════════════════════════════════════════════════

describe("matchesPattern", () => {
	it("matches exact name", () => {
		expect(matchesPattern("effect", "effect")).toBe(true);
	});

	it("does not match different exact name", () => {
		expect(matchesPattern("@effect/schema", "effect")).toBe(false);
	});

	it("matches scoped wildcard", () => {
		expect(matchesPattern("@savvy-web/changesets", "@savvy-web/*")).toBe(true);
	});

	it("does not match wrong scope with wildcard", () => {
		expect(matchesPattern("@other/pkg", "@savvy-web/*")).toBe(false);
	});

	it("matches bare wildcard", () => {
		expect(matchesPattern("anything", "*")).toBe(true);
	});

	it("handles dots in package names safely", () => {
		expect(matchesPattern("jquery.form", "jquery.form")).toBe(true);
		// Dot should NOT act as regex wildcard
		expect(matchesPattern("jqueryXform", "jquery.form")).toBe(false);
	});
});

// ══════════════════════════════════════════════════════════════════════════════
// parseSpecifier
// ══════════════════════════════════════════════════════════════════════════════

describe("parseSpecifier", () => {
	it("parses caret specifier", () => {
		expect(parseSpecifier("^0.1.2")).toEqual({ prefix: "^", version: "0.1.2" });
	});

	it("parses tilde specifier", () => {
		expect(parseSpecifier("~1.2.3")).toEqual({ prefix: "~", version: "1.2.3" });
	});

	it("parses exact specifier", () => {
		expect(parseSpecifier("1.2.3")).toEqual({ prefix: "", version: "1.2.3" });
	});

	it("returns null for catalog: specifier", () => {
		expect(parseSpecifier("catalog:")).toBeNull();
	});

	it("returns null for named catalog specifier", () => {
		expect(parseSpecifier("catalog:silk")).toBeNull();
	});

	it("returns null for workspace: specifier", () => {
		expect(parseSpecifier("workspace:*")).toBeNull();
	});

	it("returns null for non-semver specifier (latest)", () => {
		expect(parseSpecifier("latest")).toBeNull();
	});

	it("returns null for URL specifier", () => {
		expect(parseSpecifier("https://github.com/foo/bar")).toBeNull();
	});

	it("returns null for star specifier", () => {
		expect(parseSpecifier("*")).toBeNull();
	});

	it("should parse >= prefix", () => {
		expect(parseSpecifier(">=3.6.0")).toEqual({ prefix: ">=", version: "3.6.0" });
	});

	it("should parse > prefix", () => {
		expect(parseSpecifier(">3.6.0")).toEqual({ prefix: ">", version: "3.6.0" });
	});

	it("should parse <= prefix", () => {
		expect(parseSpecifier("<=3.6.0")).toEqual({ prefix: "<=", version: "3.6.0" });
	});

	it("should parse < prefix", () => {
		expect(parseSpecifier("<3.6.0")).toEqual({ prefix: "<", version: "3.6.0" });
	});
});

// ══════════════════════════════════════════════════════════════════════════════
// RegularDeps service (Effect integration tests)
// ══════════════════════════════════════════════════════════════════════════════

describe("RegularDeps.updateRegularDeps", () => {
	it("returns empty array when no patterns provided", async () => {
		const result = await runWithService((s) => s.updateRegularDeps([]));
		expect(result).toEqual([]);
	});

	it("updates a single dependency when newer version available", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "root",
			devDependencies: { effect: "^3.0.0" },
		});

		const result = await runWithService(
			(s) => s.updateRegularDeps(["effect"], dir),
			{ effect: "3.1.0" },
			mockWorkspaces([{ name: "root", path: dir }]),
		);

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			dependency: "effect",
			from: "^3.0.0",
			to: "^3.1.0",
			type: "devDependency",
		});

		// Verify package.json was updated
		const pkg = readPackageJson(dir);
		expect(pkg.devDependencies.effect).toBe("^3.1.0");
	});

	it("skips dependency when already on latest", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "root",
			devDependencies: { effect: "^3.1.0" },
		});

		const result = await runWithService(
			(s) => s.updateRegularDeps(["effect"], dir),
			{ effect: "3.1.0" },
			mockWorkspaces([{ name: "root", path: dir }]),
		);

		expect(result).toHaveLength(0);
	});

	it("matches multiple deps with wildcard pattern", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "root",
			devDependencies: {
				"@savvy-web/core": "^1.0.0",
				"@savvy-web/utils": "^1.0.0",
			},
		});

		const result = await runWithService(
			(s) => s.updateRegularDeps(["@savvy-web/*"], dir),
			{ "@savvy-web/core": "1.1.0", "@savvy-web/utils": "1.2.0" },
			mockWorkspaces([{ name: "root", path: dir }]),
		);

		expect(result).toHaveLength(2);
		expect(result.find((r) => r.dependency === "@savvy-web/core")?.to).toBe("^1.1.0");
		expect(result.find((r) => r.dependency === "@savvy-web/utils")?.to).toBe("^1.2.0");
	});

	it("skips deps with catalog: specifier", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "root",
			devDependencies: {
				effect: "catalog:",
				"@effect/schema": "^0.60.0",
			},
		});

		const result = await runWithService(
			(s) => s.updateRegularDeps(["effect", "@effect/*"], dir),
			{ "@effect/schema": "0.61.0" },
			mockWorkspaces([{ name: "root", path: dir }]),
		);

		// Only @effect/schema should be updated, effect with catalog: should be skipped
		expect(result).toHaveLength(1);
		expect(result[0].dependency).toBe("@effect/schema");
	});

	it("updates deps across multiple package.json files", async () => {
		const dir = makeTempDir();
		const pkgDir = join(dir, "pkgs", "core");
		mkdirSync(pkgDir, { recursive: true });

		// Root package.json
		writePackageJson(dir, {
			name: "root",
			devDependencies: { effect: "^3.0.0" },
		});

		// Workspace package package.json
		writePackageJson(pkgDir, {
			name: "@savvy-web/core",
			devDependencies: { effect: "^3.0.0" },
		});

		const result = await runWithService(
			(s) => s.updateRegularDeps(["effect"], dir),
			{ effect: "3.1.0" },
			mockWorkspaces([
				{ name: "root", path: dir },
				{ name: "@savvy-web/core", path: pkgDir },
			]),
		);

		// Should have updates for both root and workspace package
		expect(result).toHaveLength(2);

		// Verify both package.json files were updated
		const rootPkg = readPackageJson(dir);
		expect(rootPkg.devDependencies.effect).toBe("^3.1.0");

		const corePkg = readPackageJson(pkgDir);
		expect(corePkg.devDependencies.effect).toBe("^3.1.0");
	});

	it("continues when npm query fails for one dep", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "root",
			devDependencies: {
				"bad-pkg": "^1.0.0",
				"good-pkg": "^1.0.0",
			},
		});

		// Only provide "good-pkg" in registry; "bad-pkg" will fail automatically
		const result = await runWithService(
			(s) => s.updateRegularDeps(["bad-pkg", "good-pkg"], dir),
			{ "good-pkg": "2.0.0" },
			mockWorkspaces([{ name: "root", path: dir }]),
		);

		// Should still update good-pkg even though bad-pkg query failed
		expect(result).toHaveLength(1);
		expect(result[0].dependency).toBe("good-pkg");
	});

	it("preserves tilde prefix", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "root",
			devDependencies: { effect: "~3.0.0" },
		});

		const result = await runWithService(
			(s) => s.updateRegularDeps(["effect"], dir),
			{ effect: "3.1.0" },
			mockWorkspaces([{ name: "root", path: dir }]),
		);

		expect(result).toHaveLength(1);
		expect(result[0].to).toBe("~3.1.0");

		const pkg = readPackageJson(dir);
		expect(pkg.devDependencies.effect).toBe("~3.1.0");
	});

	it("finds dep in devDependencies field", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "root",
			devDependencies: { effect: "^3.0.0" },
		});

		const result = await runWithService(
			(s) => s.updateRegularDeps(["effect"], dir),
			{ effect: "3.1.0" },
			mockWorkspaces([{ name: "root", path: dir }]),
		);

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			dependency: "effect",
			from: "^3.0.0",
			to: "^3.1.0",
		});
	});

	it("returns empty array when no matching deps found in package.json", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "root",
			devDependencies: { lodash: "^4.0.0" },
		});

		const result = await runWithService(
			(s) => s.updateRegularDeps(["effect"], dir),
			undefined,
			mockWorkspaces([{ name: "root", path: dir }]),
		);

		// No deps match the pattern, so empty result
		expect(result).toHaveLength(0);
	});

	it("continues when workspace info query fails", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "root",
			devDependencies: { effect: "^3.0.0" },
		});

		// Workspaces service fails — impl should gracefully degrade to empty package list
		const result = await runWithService(
			(s) => s.updateRegularDeps(["effect"], dir),
			{ effect: "3.1.0" },
			failingWorkspaces(),
		);

		// Graceful degradation: no packages found, so no updates
		expect(result).toHaveLength(0);
	});

	it("returns empty when package not found in registry", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "root",
			devDependencies: { effect: "^3.0.0" },
		});

		// Empty registry — no packages registered, so query will fail
		const result = await runWithService(
			(s) => s.updateRegularDeps(["effect"], dir),
			undefined,
			mockWorkspaces([{ name: "root", path: dir }]),
		);

		// queryLatestVersion returns null when registry query fails
		expect(result).toHaveLength(0);
	});

	it("skips deps in optionalDependencies", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "root",
			optionalDependencies: { effect: "^3.0.0" },
		});

		const result = await runWithService(
			(s) => s.updateRegularDeps(["effect"], dir),
			{ effect: "3.1.0" },
			mockWorkspaces([{ name: "root", path: dir }]),
		);

		expect(result).toHaveLength(0);

		// Verify optionalDependencies was NOT changed
		const pkg = readPackageJson(dir);
		expect(pkg.optionalDependencies.effect).toBe("^3.0.0");
	});

	it("preserves exact version (no prefix)", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "root",
			devDependencies: { effect: "3.0.0" },
		});

		const result = await runWithService(
			(s) => s.updateRegularDeps(["effect"], dir),
			{ effect: "3.1.0" },
			mockWorkspaces([{ name: "root", path: dir }]),
		);

		expect(result).toHaveLength(1);
		expect(result[0].to).toBe("3.1.0");

		const pkg = readPackageJson(dir);
		expect(pkg.devDependencies.effect).toBe("3.1.0");
	});
});
