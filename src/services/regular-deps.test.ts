import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReleaseAgeGate } from "@effected/npm";
import type { WorkspacePackage } from "@effected/workspaces";
import { WorkspaceDiscovery, WorkspaceDiscoveryError } from "@effected/workspaces";
import { Effect, Layer, References } from "effect";
import { describe, expect, it } from "vitest";
import { matchesPattern, parseSpecifier } from "../utils/deps.js";
import { seededRegistry } from "../utils/fixtures.test.js";
import { RegularDeps, RegularDepsLive } from "./regular-deps.js";
import { ReleaseAge, ReleaseAgeNoop } from "./release-age.js";

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

/**
 * Create a WorkspaceDiscovery layer that returns a fixed list of packages.
 * Use this to control which package.json files the RegularDeps service sees.
 */
const mockWorkspaces = (packages: ReadonlyArray<{ name: string; path: string }>): Layer.Layer<WorkspaceDiscovery> =>
	Layer.succeed(WorkspaceDiscovery, {
		listPackages: () => Effect.succeed(packages as unknown as ReadonlyArray<WorkspacePackage>),
		getPackage: () => Effect.die("getPackage not used in regular-deps tests"),
		importerMap: () => Effect.die("importerMap not used in regular-deps tests"),
		info: () => Effect.die("info not used in regular-deps tests"),
		resolveFile: () => Effect.die("resolveFile not used in regular-deps tests"),
		resolveFiles: () => Effect.die("resolveFiles not used in regular-deps tests"),
		refresh: () => Effect.void,
	});

/**
 * Create a WorkspaceDiscovery layer that fails with a WorkspaceDiscoveryError.
 * Used to test graceful degradation when workspace discovery fails.
 */
const failingWorkspaces = (): Layer.Layer<WorkspaceDiscovery> =>
	Layer.succeed(WorkspaceDiscovery, {
		listPackages: () =>
			Effect.fail(
				new WorkspaceDiscoveryError({
					root: "",
					path: "",
					kind: "read",
					cause: "workspace detection failed",
				}),
			),
		getPackage: () => Effect.die("getPackage not used in regular-deps tests"),
		importerMap: () => Effect.die("importerMap not used in regular-deps tests"),
		info: () => Effect.die("info not used in regular-deps tests"),
		resolveFile: () => Effect.die("resolveFile not used in regular-deps tests"),
		resolveFiles: () => Effect.die("resolveFiles not used in regular-deps tests"),
		refresh: () => Effect.void,
	});

const runWithService = <A, E>(
	fn: (service: Effect.Success<typeof RegularDeps>) => Effect.Effect<A, E>,
	packages?: Record<string, string | string[]>,
	workspacesLayer?: Layer.Layer<WorkspaceDiscovery>,
	releaseAge: Layer.Layer<ReleaseAge> = ReleaseAgeNoop,
) => {
	// These suites describe a package as a bare version or a version list; the
	// shared seeder takes the richer per-version shape.
	const registryLayer = packages
		? seededRegistry(
				Object.fromEntries(
					Object.entries(packages).map(([name, value]) =>
						typeof value === "string"
							? [name, { version: value }]
							: [name, { version: value[value.length - 1] ?? "0.0.0", versions: value }],
					),
				),
			)
		: seededRegistry({});
	const wsLayer = workspacesLayer ?? mockWorkspaces([]);
	const layer = RegularDepsLive.pipe(Layer.provide(Layer.mergeAll(registryLayer, wsLayer, releaseAge)));
	return Effect.runPromise(
		Effect.gen(function* () {
			const service = yield* RegularDeps;
			return yield* fn(service);
		}).pipe(Effect.provide(layer), Effect.provideService(References.MinimumLogLevel, "None")),
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

	it("holds back a resolution the release-age gate filters out", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "root",
			devDependencies: { effect: "^3.0.0" },
		});

		const holdBack = Layer.succeed(ReleaseAge, {
			gate: () => Effect.succeed(ReleaseAgeGate.combine({ ageMinutes: 1440 })),
			filterVersions: (_pkg: string, versions: ReadonlyArray<string>) =>
				Effect.succeed(versions.filter((v) => v !== "3.1.0")),
		});

		const result = await runWithService(
			(s) => s.updateRegularDeps(["effect"], dir),
			{ effect: ["3.0.0", "3.1.0"] },
			mockWorkspaces([{ name: "root", path: dir }]),
			holdBack,
		);

		expect(result).toHaveLength(0);
		const pkg = readPackageJson(dir);
		expect(pkg.devDependencies.effect).toBe("^3.0.0");
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

	it("bumps a config dependency's devDependency range when nothing is excluded", async () => {
		// The pnpm (and npm) case: config dependencies live in pnpm-workspace.yaml
		// and ConfigDeps never touches package.json, so no exclusion set is passed
		// and the devDependency range of a package that is *also* a config
		// dependency is RegularDeps' to bump. Excluding it there would freeze that
		// range forever.
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "root",
			devDependencies: { "@savvy-web/pnpm-plugin-silk": "^1.0.0" },
		});

		const result = await runWithService(
			(s) => s.updateRegularDeps(["@savvy-web/*"], dir),
			{ "@savvy-web/pnpm-plugin-silk": "1.5.0" },
			mockWorkspaces([{ name: "root", path: dir }]),
		);

		expect(result).toHaveLength(1);
		expect(result[0].dependency).toBe("@savvy-web/pnpm-plugin-silk");
		expect(readPackageJson(dir).devDependencies["@savvy-web/pnpm-plugin-silk"]).toBe("^1.5.0");
	});

	it("skips an excluded name even when a pattern matches it", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "root",
			devDependencies: {
				// bun's config-dependency path owns this one: it bumps the range in
				// package.json and merges the plugin's catalogs, so RegularDeps must not
				// bump it too.
				"@savvy-web/pnpm-plugin-silk": "^1.0.0",
				"@savvy-web/core": "^1.0.0",
			},
		});

		const result = await runWithService(
			(s) => s.updateRegularDeps(["@savvy-web/*"], dir, new Set(["@savvy-web/pnpm-plugin-silk"])),
			{ "@savvy-web/pnpm-plugin-silk": "1.5.0", "@savvy-web/core": "1.1.0" },
			mockWorkspaces([{ name: "root", path: dir }]),
		);

		expect(result).toHaveLength(1);
		expect(result[0].dependency).toBe("@savvy-web/core");
		expect(readPackageJson(dir).devDependencies["@savvy-web/pnpm-plugin-silk"]).toBe("^1.0.0");
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
			// 0.60.5 is the highest in-range version for ^0.60.0 (widened to >=0.60.0 <2.0.0)
			{ "@effect/schema": ["0.60.0", "0.60.5"] },
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

		// Only provide "good-pkg" in registry; "bad-pkg" will fail automatically.
		// 1.5.0 stays within good-pkg's ^1.0.0 range.
		const result = await runWithService(
			(s) => s.updateRegularDeps(["bad-pkg", "good-pkg"], dir),
			{ "good-pkg": ["1.0.0", "1.5.0"] },
			mockWorkspaces([{ name: "root", path: dir }]),
		);

		// Should still update good-pkg even though bad-pkg query failed
		expect(result).toHaveLength(1);
		expect(result[0].dependency).toBe("good-pkg");
	});

	it("preserves tilde prefix and stays within the tilde range", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "root",
			devDependencies: { effect: "~3.0.0" },
		});

		// ~3.0.0 allows >=3.0.0 <3.1.0 — 3.1.0 is outside the range and must
		// not be selected; the highest in-range version is 3.0.5.
		const result = await runWithService(
			(s) => s.updateRegularDeps(["effect"], dir),
			{ effect: ["3.0.0", "3.0.5", "3.1.0"] },
			mockWorkspaces([{ name: "root", path: dir }]),
		);

		expect(result).toHaveLength(1);
		expect(result[0].to).toBe("~3.0.5");

		const pkg = readPackageJson(dir);
		expect(pkg.devDependencies.effect).toBe("~3.0.5");
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

	it("updates deps in dependencies", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "root",
			dependencies: { effect: "^3.0.0" },
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
			type: "dependency",
		});

		const pkg = readPackageJson(dir);
		expect(pkg.dependencies.effect).toBe("^3.1.0");
	});

	it("updates deps in optionalDependencies", async () => {
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

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			dependency: "effect",
			from: "^3.0.0",
			to: "^3.1.0",
			type: "optionalDependency",
		});

		const pkg = readPackageJson(dir);
		expect(pkg.optionalDependencies.effect).toBe("^3.1.0");
	});

	it("skips deps in peerDependencies (peer ranges are managed by syncPeers)", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "root",
			peerDependencies: { effect: "^3.0.0" },
		});

		const result = await runWithService(
			(s) => s.updateRegularDeps(["effect"], dir),
			{ effect: "3.1.0" },
			mockWorkspaces([{ name: "root", path: dir }]),
		);

		expect(result).toHaveLength(0);

		const pkg = readPackageJson(dir);
		expect(pkg.peerDependencies.effect).toBe("^3.0.0");
	});

	it("emits one record per section when dep appears in both dependencies and devDependencies", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "root",
			dependencies: { effect: "^3.0.0" },
			devDependencies: { effect: "^3.0.0" },
		});

		const result = await runWithService(
			(s) => s.updateRegularDeps(["effect"], dir),
			{ effect: "3.1.0" },
			mockWorkspaces([{ name: "root", path: dir }]),
		);

		expect(result).toHaveLength(2);
		const types = result.map((r) => r.type).sort();
		expect(types).toEqual(["dependency", "devDependency"]);

		const pkg = readPackageJson(dir);
		expect(pkg.dependencies.effect).toBe("^3.1.0");
		expect(pkg.devDependencies.effect).toBe("^3.1.0");
	});

	it("never bumps an exact pin (an exact version is a one-version range)", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "root",
			devDependencies: { effect: "3.0.0" },
		});

		// An exact pin "3.0.0" only satisfies 3.0.0, so newer versions must be
		// left untouched — respecting the range the user pinned.
		const result = await runWithService(
			(s) => s.updateRegularDeps(["effect"], dir),
			{ effect: ["3.0.0", "3.1.0", "4.0.0"] },
			mockWorkspaces([{ name: "root", path: dir }]),
		);

		expect(result).toHaveLength(0);

		const pkg = readPackageJson(dir);
		expect(pkg.devDependencies.effect).toBe("3.0.0");
	});

	it("respects a caret range and does not cross the major boundary", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "root",
			dependencies: { "@sigstore/bundle": "^4.0.0" },
		});

		// Latest is 5.2.0 but ^4.0.0 caps at the 4.x line — the highest
		// satisfying version is 4.5.0.
		const result = await runWithService(
			(s) => s.updateRegularDeps(["@sigstore/bundle"], dir),
			{ "@sigstore/bundle": ["4.0.0", "4.5.0", "5.0.0", "5.2.0"] },
			mockWorkspaces([{ name: "root", path: dir }]),
		);

		expect(result).toHaveLength(1);
		expect(result[0].to).toBe("^4.5.0");

		const pkg = readPackageJson(dir);
		expect(pkg.dependencies["@sigstore/bundle"]).toBe("^4.5.0");
	});

	it("follows a >= range across a major boundary", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "root",
			dependencies: { "some-lib": ">=4.0.0" },
		});

		// >=4.0.0 admits any newer version, so it should advance to 5.0.1.
		const result = await runWithService(
			(s) => s.updateRegularDeps(["some-lib"], dir),
			{ "some-lib": ["4.0.0", "4.5.0", "5.0.1"] },
			mockWorkspaces([{ name: "root", path: dir }]),
		);

		expect(result).toHaveLength(1);
		expect(result[0].to).toBe(">=5.0.1");

		const pkg = readPackageJson(dir);
		expect(pkg.dependencies["some-lib"]).toBe(">=5.0.1");
	});

	it("ignores prereleases when resolving within a range", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "root",
			dependencies: { effect: "^3.0.0" },
		});

		// 3.3.0-beta.1 is the highest in-range version but is a prerelease, so
		// the stable 3.2.0 should be selected.
		const result = await runWithService(
			(s) => s.updateRegularDeps(["effect"], dir),
			{ effect: ["3.0.0", "3.2.0", "3.3.0-beta.1"] },
			mockWorkspaces([{ name: "root", path: dir }]),
		);

		expect(result).toHaveLength(1);
		expect(result[0].to).toBe("^3.2.0");
	});

	it("rolls a caret-on-zero dep forward to the first stable major", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "root",
			dependencies: { "pre-stable": "^0.5.0" },
		});

		// ^0.5.0 would normally lock to 0.5.x; with config-parity roll-forward it
		// resolves within >=0.5.0 <2.0.0 and adopts the highest 1.x.
		const result = await runWithService(
			(s) => s.updateRegularDeps(["pre-stable"], dir),
			{ "pre-stable": ["0.5.0", "0.9.4", "1.3.0"] },
			mockWorkspaces([{ name: "root", path: dir }]),
		);

		expect(result).toHaveLength(1);
		expect(result[0].to).toBe("^1.3.0");

		const pkg = readPackageJson(dir);
		expect(pkg.dependencies["pre-stable"]).toBe("^1.3.0");
	});

	it("rolls a caret-on-zero dep across 0.x when no stable major exists", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "root",
			dependencies: { "pre-stable": "^0.5.0" },
		});

		// No 1.x published, so it advances to the highest 0.x (0.9.4), which plain
		// caret semantics would not allow (they would cap at 0.5.x).
		const result = await runWithService(
			(s) => s.updateRegularDeps(["pre-stable"], dir),
			{ "pre-stable": ["0.5.0", "0.9.4"] },
			mockWorkspaces([{ name: "root", path: dir }]),
		);

		expect(result).toHaveLength(1);
		expect(result[0].to).toBe("^0.9.4");
	});

	it("rolls a caret-on-0.0.x dep forward across 0.0.x", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "root",
			dependencies: { "pre-stable": "^0.0.3" },
		});

		const result = await runWithService(
			(s) => s.updateRegularDeps(["pre-stable"], dir),
			{ "pre-stable": ["0.0.3", "0.0.9"] },
			mockWorkspaces([{ name: "root", path: dir }]),
		);

		expect(result).toHaveLength(1);
		expect(result[0].to).toBe("^0.0.9");
	});

	it("keeps a tilde-on-zero dep within its minor (no roll-forward)", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "root",
			dependencies: { "pre-stable": "~0.5.0" },
		});

		// ~0.5.0 allows >=0.5.0 <0.6.0 — it stays in 0.5.x and never reaches 0.9.4.
		const result = await runWithService(
			(s) => s.updateRegularDeps(["pre-stable"], dir),
			{ "pre-stable": ["0.5.0", "0.5.5", "0.9.4"] },
			mockWorkspaces([{ name: "root", path: dir }]),
		);

		expect(result).toHaveLength(1);
		expect(result[0].to).toBe("~0.5.5");
	});

	it("never bumps an exact-on-zero pin", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			name: "root",
			dependencies: { "pre-stable": "0.5.0" },
		});

		const result = await runWithService(
			(s) => s.updateRegularDeps(["pre-stable"], dir),
			{ "pre-stable": ["0.5.0", "0.9.4", "1.3.0"] },
			mockWorkspaces([{ name: "root", path: dir }]),
		);

		expect(result).toHaveLength(0);

		const pkg = readPackageJson(dir);
		expect(pkg.dependencies["pre-stable"]).toBe("0.5.0");
	});
});
