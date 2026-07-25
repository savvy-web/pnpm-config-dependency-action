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
import { DateTime, Effect, Layer, References } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	ReleaseAge,
	ReleaseAgeLive,
	ReleaseAgeNoop,
	getPublishTimes,
	readInlineReleaseAge,
	replayHookReleaseAge,
} from "./release-age.js";

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

	describe("readInlineReleaseAge", () => {
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

			const gate = await Effect.runPromise(readInlineReleaseAge(root));

			expect(gate).toEqual({ ageMinutes: 1440, exclude: ["@effected/*", "prettier"] });
		});

		it("reads a gate with only minimumReleaseAge declared", async () => {
			writeWorkspaceYaml(["packages:", "  - .", "minimumReleaseAge: 720", ""].join("\n"));

			const gate = await Effect.runPromise(readInlineReleaseAge(root));

			expect(gate).toEqual({ ageMinutes: 720 });
		});

		it("returns null when neither release-age key is present", async () => {
			writeWorkspaceYaml(["packages:", "  - .", ""].join("\n"));

			const gate = await Effect.runPromise(readInlineReleaseAge(root));

			expect(gate).toBeNull();
		});

		it("returns null when pnpm-workspace.yaml is missing", async () => {
			const gate = await Effect.runPromise(readInlineReleaseAge(root));

			expect(gate).toBeNull();
		});
	});

	describe("replayHookReleaseAge", () => {
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

			const gate = await runWith(replayHookReleaseAge(root), NodeServices.layer);

			expect(gate).toEqual({ ageMinutes: 1440, exclude: ["@effected/*", "prettier"] });
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

			const gate = await runWith(replayHookReleaseAge(root), NodeServices.layer);

			expect(gate).toEqual({ ageMinutes: 720, exclude: ["@scope/*"] });
		});

		it("returns null when the workspace declares no configDependencies", async () => {
			writeWorkspaceYaml(["packages:", "  - .", ""].join("\n"));

			const gate = await runWith(replayHookReleaseAge(root), NodeServices.layer);

			expect(gate).toBeNull();
		});

		it("returns null when config dependencies ship no pnpmfile", async () => {
			writeWorkspaceYaml(
				["packages:", "  - .", "configDependencies:", '  no-hooks-plugin: "1.0.0+sha512-abc"', ""].join("\n"),
			);
			mkdirSync(join(root, "node_modules", ".pnpm-config", "no-hooks-plugin"), { recursive: true });

			const gate = await runWith(replayHookReleaseAge(root), NodeServices.layer);

			expect(gate).toBeNull();
		});

		it("returns null (not a failure) when a pnpmfile throws", async () => {
			writeWorkspaceYaml(
				["packages:", "  - .", "configDependencies:", '  broken-plugin: "1.0.0+sha512-abc"', ""].join("\n"),
			);
			writeConfigDepPnpmfile("broken-plugin", "pnpmfile.cjs", 'throw new Error("boom");\n');

			const gate = await runWith(replayHookReleaseAge(root), NodeServices.layer);

			expect(gate).toBeNull();
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

		/** ReleaseAgeLive needs a real spawner (the hook replay) plus a registry. */
		const runService = <A, E>(effect: Effect.Effect<A, E, ReleaseAge>, registry: Layer.Layer<NpmRegistry>) =>
			runWith(
				effect.pipe(Effect.provide(ReleaseAgeLive(root))) as Effect.Effect<
					A,
					E,
					ChildProcessSpawner.ChildProcessSpawner | NpmRegistry
				>,
				Layer.merge(NodeServices.layer, registry),
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
