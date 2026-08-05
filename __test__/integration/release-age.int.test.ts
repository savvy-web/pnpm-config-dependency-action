/**
 * Tests for release-age gate discovery and publish-time helpers.
 *
 * `replayHookReleaseAge` runs a real `node` subprocess via the real platform
 * spawner against temp-dir fixtures, so the pnpmfile replay path is exercised
 * for real rather than mocked.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { DEFAULT_REGISTRY, NpmRegistry, PublishTime, RegistryReadError } from "@effected/npm";
import {
	LockfileReader,
	PackageManagerDetector,
	WorkspaceCatalogs,
	WorkspaceDiscovery,
	WorkspaceRoot,
} from "@effected/workspaces";
import { DateTime, Effect, Layer, References } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReleaseAge, ReleaseAgeLive, ReleaseAgeNoop, getPublishTimes } from "../../src/services/release-age.js";

/**
 * The **real** kit stack over a fixture root — `WorkspaceRoot.layerTest(root)`
 * binds the temp directory, everything else is live.
 *
 * `layerWithConfigDependenciesSubprocess`, not the in-process variant: that is
 * the one the action ships, because rspack miscompiles the in-process loader's
 * computed dynamic import. Testing the other one would prove nothing about the
 * bundle.
 */
const catalogsAt = (root: string): Layer.Layer<WorkspaceCatalogs> => {
	const platform = NodeServices.layer;
	const workspaceRoot = WorkspaceRoot.layerTest(root);
	const discovery = WorkspaceDiscovery.layer().pipe(Layer.provide(Layer.merge(workspaceRoot, platform)));
	const detector = PackageManagerDetector.layer.pipe(Layer.provide(platform));
	const lockfiles = LockfileReader.layer().pipe(
		Layer.provide(Layer.mergeAll(workspaceRoot, detector, discovery, platform)),
	);
	return WorkspaceCatalogs.layerWithConfigDependenciesSubprocess().pipe(
		Layer.provide(Layer.mergeAll(workspaceRoot, lockfiles, platform)),
	);
};

/** The effective gate the action would apply at `root`, through the kit. */
const gateAt = (root: string) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const catalogs = yield* WorkspaceCatalogs;
			return yield* catalogs.releaseAgeGate();
		}).pipe(Effect.provide(catalogsAt(root)), Effect.provideService(References.MinimumLogLevel, "None")),
	);

const runWith = <A, E, R>(effect: Effect.Effect<A, E, R>, layer: Layer.Layer<R>) =>
	Effect.runPromise(
		effect.pipe(Effect.provide(layer), Effect.provideService(References.MinimumLogLevel, "None")) as Effect.Effect<
			A,
			E,
			never
		>,
	);

describe("release-age", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "release-age-test-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const writeWorkspaceYaml = (content: string) => {
		writeFileSync(join(root, "pnpm-workspace.yaml"), content, "utf-8");
	};

	const writeConfigDepPnpmfile = (name: string, filename: string, source: string) => {
		const dir = join(root, "node_modules", ".pnpm-config", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, filename), source, "utf-8");
	};

	describe("gate discovery — inline pnpm-workspace.yaml keys", () => {
		it("reads minimumReleaseAge and minimumReleaseAgeExclude from pnpm-workspace.yaml", async () => {
			writeWorkspaceYaml(
				[
					"packages:",
					"  - .",
					"minimumReleaseAge: 1440",
					"minimumReleaseAgeExclude:",
					'  - "@effected/*"',
					"  - prettier",
					"",
				].join("\n"),
			);

			const gate = await gateAt(root);

			expect(gate.ageMinutes).toBe(1440);
			expect(gate.exclude).toEqual(["@effected/*", "prettier"]);
		});

		it("reads a gate with only minimumReleaseAge declared", async () => {
			writeWorkspaceYaml(["packages:", "  - .", "minimumReleaseAge: 720", ""].join("\n"));

			const gate = await gateAt(root);

			expect(gate.ageMinutes).toBe(720);
			expect(gate.exclude).toEqual([]);
		});

		it("yields the inert zero gate when neither release-age key is present", async () => {
			writeWorkspaceYaml(["packages:", "  - .", ""].join("\n"));

			const gate = await gateAt(root);

			expect(gate.ageMinutes).toBe(0);
		});

		it("yields the inert zero gate when pnpm-workspace.yaml is missing", async () => {
			const gate = await gateAt(root);

			expect(gate.ageMinutes).toBe(0);
		});
	});

	describe("gate discovery — replayed config-dependency hooks", () => {
		it("replays a config dependency updateConfig hook that injects release-age settings", async () => {
			writeWorkspaceYaml(
				["packages:", "  - .", "configDependencies:", '  fake-plugin: "1.0.0+sha512-abc"', ""].join("\n"),
			);
			writeConfigDepPnpmfile(
				"fake-plugin",
				"pnpmfile.cjs",
				[
					"module.exports = {",
					"  hooks: {",
					"    updateConfig(config) {",
					"      config.minimumReleaseAge = 1440;",
					'      config.minimumReleaseAgeExclude = ["@effected/*", "prettier"];',
					"      return config;",
					"    },",
					"  },",
					"};",
					"",
				].join("\n"),
			);

			const gate = await gateAt(root);

			expect(gate.ageMinutes).toBe(1440);
			expect(gate.exclude).toEqual(["@effected/*", "prettier"]);
		});

		it("survives a hook that writes to stdout — the silent gate-loss regression", async () => {
			// THE bug: the parent used to `JSON.parse` the child's ENTIRE stdout, so a
			// single `console.log` in a pnpmfile hook made the parse throw. The path
			// fails open by design, so the run then proceeded with NO release-age gate
			// at all, silently — and could propose a version pnpm rejects at install
			// with ERR_PNPM_NO_MATURE_MATCHING_VERSION. That is exactly the failure the
			// gate exists to prevent, produced by the gate's own error handling.
			//
			// Hooks are arbitrary user code and real ones do log, so this is the
			// ordinary case rather than an exotic one.
			writeWorkspaceYaml(
				["packages:", "  - .", "configDependencies:", '  chatty-plugin: "1.0.0+sha512-abc"', ""].join("\n"),
			);
			writeConfigDepPnpmfile(
				"chatty-plugin",
				"pnpmfile.cjs",
				[
					"module.exports = {",
					"  hooks: {",
					"    updateConfig(config) {",
					'      console.log("chatty-plugin: applying policy");',
					// Valid JSON logged mid-hook, i.e. BEFORE the payload — the ordinary
					// shape of a chatty plugin. See the known-gap test below for output
					// emitted AFTER the payload, which the kit does not survive.
					"      console.log(JSON.stringify({ minimumReleaseAge: 1 }));",
					"      config.minimumReleaseAge = 1440;",
					'      config.minimumReleaseAgeExclude = ["@effected/*"];',
					"      return config;",
					"    },",
					"  },",
					"};",
					"",
				].join("\n"),
			);

			const gate = await gateAt(root);

			// The hook's real contribution survives the noise, and the decoy JSON is
			// NOT mistaken for the payload.
			expect(gate.ageMinutes).toBe(1440);
			expect(gate.exclude).toEqual(["@effected/*"]);
		});

		it("replays an ESM-only pnpmfile.mjs", async () => {
			writeWorkspaceYaml(
				["packages:", "  - .", "configDependencies:", '  esm-plugin: "1.0.0+sha512-abc"', ""].join("\n"),
			);
			writeConfigDepPnpmfile(
				"esm-plugin",
				"pnpmfile.mjs",
				[
					"export const hooks = {",
					"  updateConfig(config) {",
					'    return { ...config, minimumReleaseAge: 720, minimumReleaseAgeExclude: ["@scope/*"] };',
					"  },",
					"};",
					"",
				].join("\n"),
			);

			const gate = await gateAt(root);

			expect(gate.ageMinutes).toBe(720);
			expect(gate.exclude).toEqual(["@scope/*"]);
		});

		it("yields the inert zero gate when the workspace declares no configDependencies", async () => {
			writeWorkspaceYaml(["packages:", "  - .", ""].join("\n"));

			const gate = await gateAt(root);

			expect(gate.ageMinutes).toBe(0);
		});

		it("yields the inert zero gate when config dependencies ship no pnpmfile", async () => {
			writeWorkspaceYaml(
				["packages:", "  - .", "configDependencies:", '  no-hooks-plugin: "1.0.0+sha512-abc"', ""].join("\n"),
			);
			mkdirSync(join(root, "node_modules", ".pnpm-config", "no-hooks-plugin"), { recursive: true });

			const gate = await gateAt(root);

			expect(gate.ageMinutes).toBe(0);
		});

		it("fails typed when a pnpmfile throws — and ReleaseAgeLive degrades it to no gate", async () => {
			// This is the division of responsibility the adoption created, and it is
			// worth pinning on both sides.
			//
			// The kit fails **typed** (`CatalogAssemblyError`) where the previous local
			// implementation degraded to "no contribution". That is the right contract
			// for a library. This action deliberately does not want it: pnpm re-enforces
			// the gate at install, so the worst case of missing data is exactly the
			// pre-gate behaviour, whereas aborting a dependency-update run over one
			// broken plugin would be strictly worse.
			//
			// So `ReleaseAgeLive` wraps it in `Effect.catch`. If that wrapper is ever
			// removed, the first assertion still passes and the second fails — which is
			// the point of asserting both rather than only the outcome.
			writeWorkspaceYaml(
				["packages:", "  - .", "configDependencies:", '  broken-plugin: "1.0.0+sha512-abc"', ""].join("\n"),
			);
			writeConfigDepPnpmfile(
				"broken-plugin",
				"pnpmfile.cjs",
				["module.exports = { hooks: { updateConfig() { throw new Error('boom'); } } };", ""].join("\n"),
			);

			// 1. The kit's own surface fails.
			const raw = await Effect.runPromise(
				Effect.gen(function* () {
					const catalogs = yield* WorkspaceCatalogs;
					return yield* catalogs.releaseAgeGate();
				}).pipe(
					Effect.provide(catalogsAt(root)),
					Effect.provideService(References.MinimumLogLevel, "None"),
					Effect.catch((error) => Effect.succeed({ failed: error._tag } as const)),
				),
			);
			expect(raw).toEqual({ failed: "CatalogAssemblyError" });

			// 2. The action's wrapper turns that into the inert gate, not an abort.
			const gate = await Effect.runPromise(
				Effect.gen(function* () {
					const service = yield* ReleaseAge;
					return yield* service.gate();
				}).pipe(
					Effect.provide(ReleaseAgeLive().pipe(Layer.provide(Layer.merge(catalogsAt(root), NpmRegistry.layerTest())))),
					Effect.provideService(References.MinimumLogLevel, "None"),
				),
			);
			expect(gate.ageMinutes).toBe(0);
		});
	});

	describe("getPublishTimes", () => {
		const registryWith = (entries: ReadonlyArray<{ version: string; publishedAt: string }>) =>
			NpmRegistry.layerTest({
				publishTimes: () =>
					Effect.succeed(
						entries.map((entry) =>
							PublishTime.make({
								version: entry.version,
								publishedAt: DateTime.fromDateUnsafe(new Date(entry.publishedAt)),
							}),
						),
					),
			});

		it("maps registry publish times into a version to timestamp record", async () => {
			// The registry's non-version `created` / `modified` keys are dropped by
			// NpmRegistry.publishTimes upstream, so they never reach this function.
			const times = await runWith(
				getPublishTimes("prettier"),
				registryWith([
					{ version: "3.9.5", publishedAt: "2026-06-01T00:00:00.000Z" },
					{ version: "3.9.6", publishedAt: "2026-07-21T05:51:53.987Z" },
				]),
			);

			expect(Object.keys(times).sort()).toEqual(["3.9.5", "3.9.6"]);
			expect(times["3.9.5"]).toContain("2026-06-01");
		});

		it("returns an empty record when the registry query fails", async () => {
			const failing = NpmRegistry.layerTest({
				publishTimes: (pkg: string) =>
					Effect.fail(new RegistryReadError({ kind: "transport", package: pkg, registry: DEFAULT_REGISTRY })),
			});

			const times = await runWith(getPublishTimes("prettier"), failing);

			expect(times).toEqual({});
		});
	});

	describe("ReleaseAge service", () => {
		const OLD = "2020-01-01T00:00:00.000Z";
		const young = () => new Date(Date.now() - 60_000).toISOString();

		/**
		 * A registry answering publish times from `times`, recording which packages
		 * were asked about so a test can assert no query happened at all.
		 */
		const timesRegistry = (calls: string[], times: Record<string, string>, fail = false) =>
			NpmRegistry.layerTest({
				publishTimes: (pkg: string) => {
					calls.push(pkg);
					if (fail) {
						return Effect.fail(new RegistryReadError({ kind: "transport", package: pkg, registry: DEFAULT_REGISTRY }));
					}
					return Effect.succeed(
						Object.entries(times).map(([version, at]) =>
							PublishTime.make({ version, publishedAt: DateTime.fromDateUnsafe(new Date(at)) }),
						),
					);
				},
			});

		/**
		 * `ReleaseAgeLive` now takes its discovery from `WorkspaceCatalogs` rather
		 * than reading the workspace itself, so the fixture root is bound by the
		 * catalogs layer instead of being passed as an argument.
		 */
		const runService = <A, E>(effect: Effect.Effect<A, E, ReleaseAge>, registry: Layer.Layer<NpmRegistry>) =>
			Effect.runPromise(
				effect.pipe(
					Effect.provide(ReleaseAgeLive().pipe(Layer.provide(Layer.merge(catalogsAt(root), registry)))),
					Effect.provideService(References.MinimumLogLevel, "None"),
				) as Effect.Effect<A, E, never>,
			);

		it("assembles the effective gate from inline and hook sources, strictest age winning", async () => {
			writeWorkspaceYaml(
				[
					"packages:",
					"  - .",
					"minimumReleaseAge: 720",
					"minimumReleaseAgeExclude:",
					'  - "@inline/*"',
					"configDependencies:",
					'  gate-plugin: "1.0.0+sha512-abc"',
					"",
				].join("\n"),
			);
			writeConfigDepPnpmfile(
				"gate-plugin",
				"pnpmfile.cjs",
				[
					"module.exports = {",
					"  hooks: {",
					"    updateConfig(config) {",
					"      config.minimumReleaseAge = 1440;",
					'      config.minimumReleaseAgeExclude = ["@hooks/*"];',
					"      return config;",
					"    },",
					"  },",
					"};",
					"",
				].join("\n"),
			);

			const gate = await runService(
				Effect.gen(function* () {
					const service = yield* ReleaseAge;
					return yield* service.gate();
				}),
				NpmRegistry.layerTest(),
			);

			expect(gate.ageMinutes).toBe(1440);
			expect([...gate.exclude].sort()).toEqual(["@hooks/*", "@inline/*"]);
		});

		it("drops versions younger than the cutoff", async () => {
			writeWorkspaceYaml(["packages:", "  - .", "minimumReleaseAge: 1440", ""].join("\n"));
			const calls: string[] = [];

			const eligible = await runService(
				Effect.gen(function* () {
					const service = yield* ReleaseAge;
					return yield* service.filterVersions("prettier", ["1.0.0", "1.1.0"]);
				}),
				timesRegistry(calls, { "1.0.0": OLD, "1.1.0": young() }),
			);

			expect(eligible).toEqual(["1.0.0"]);
		});

		it("leaves excluded packages unfiltered without fetching publish times", async () => {
			writeWorkspaceYaml(
				["packages:", "  - .", "minimumReleaseAge: 1440", "minimumReleaseAgeExclude:", '  - "@effected/*"', ""].join(
					"\n",
				),
			);
			const calls: string[] = [];

			const eligible = await runService(
				Effect.gen(function* () {
					const service = yield* ReleaseAge;
					return yield* service.filterVersions("@effected/npm", ["1.0.0", "1.1.0"]);
				}),
				timesRegistry(calls, {}),
			);

			expect(eligible).toEqual(["1.0.0", "1.1.0"]);
			expect(calls).toHaveLength(0);
		});

		it("is inert without release-age settings and never fetches publish times", async () => {
			writeWorkspaceYaml(["packages:", "  - .", ""].join("\n"));
			const calls: string[] = [];

			const eligible = await runService(
				Effect.gen(function* () {
					const service = yield* ReleaseAge;
					return yield* service.filterVersions("prettier", ["1.0.0", "1.1.0"]);
				}),
				timesRegistry(calls, {}),
			);

			expect(eligible).toEqual(["1.0.0", "1.1.0"]);
			expect(calls).toHaveLength(0);
		});

		it("fails open when publish times are unavailable", async () => {
			writeWorkspaceYaml(["packages:", "  - .", "minimumReleaseAge: 1440", ""].join("\n"));
			const calls: string[] = [];

			const eligible = await runService(
				Effect.gen(function* () {
					const service = yield* ReleaseAge;
					return yield* service.filterVersions("prettier", ["1.0.0", "1.1.0"]);
				}),
				timesRegistry(calls, {}, true),
			);

			expect(eligible).toEqual(["1.0.0", "1.1.0"]);
		});

		it("ReleaseAgeNoop passes versions through untouched", async () => {
			const eligible = await Effect.runPromise(
				Effect.gen(function* () {
					const service = yield* ReleaseAge;
					return yield* service.filterVersions("prettier", ["1.0.0"]);
				}).pipe(Effect.provide(ReleaseAgeNoop), Effect.provideService(References.MinimumLogLevel, "None")),
			);

			expect(eligible).toEqual(["1.0.0"]);
		});
	});
});
