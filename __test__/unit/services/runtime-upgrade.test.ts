import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunResolver, DenoResolver, NoMatchingVersionError, NodeResolver } from "@effected/runtimes";
import { Effect, Layer, Logger, References } from "effect";
import { describe, expect, it } from "vitest";
import type { RuntimeUpgradeConfig } from "../../../src/services/runtime-upgrade.js";
import { RuntimeUpgrade } from "../../../src/services/runtime-upgrade.js";

const makeTempDir = () => mkdtempSync(join(tmpdir(), "runtime-test-"));
const writePackageJson = (dir: string, content: Record<string, unknown>) =>
	writeFileSync(join(dir, "package.json"), `${JSON.stringify(content, null, "\t")}\n`, "utf-8");
const readPackageJson = (dir: string) => JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));

// Mock resolver whose .latest is fixed per runtime; fails when range matches nothing.
const makeResolver = (latest: string | null) => ({
	resolve: (_options?: { range?: string }) =>
		latest === null
			? Effect.fail(new NoMatchingVersionError({ runtime: "node", constraint: "mock" }))
			: Effect.succeed({ source: "cache" as const, versions: [latest], latest }),
});

const FALSE_CFG: RuntimeUpgradeConfig = { node: "false", deno: "false", bun: "false" };

/** Collect log lines so warnings are asserted, not assumed. */
const capturingLogger = (sink: string[]) => {
	const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
		sink.push(`${logLevel} ${String(message)}`);
	});
	return Layer.succeed(References.CurrentLoggers, new Set([logger]));
};

const runWithLogs = (
	dir: string,
	config: RuntimeUpgradeConfig,
	latest: { node?: string | null; deno?: string | null; bun?: string | null } = {},
) => {
	const logs: string[] = [];
	const resolvers = Layer.mergeAll(
		Layer.succeed(NodeResolver, makeResolver(latest.node !== undefined ? latest.node : "24.16.0") as never),
		Layer.succeed(DenoResolver, makeResolver(latest.deno !== undefined ? latest.deno : "2.1.0") as never),
		Layer.succeed(BunResolver, makeResolver(latest.bun !== undefined ? latest.bun : "1.2.0") as never),
	);
	const layer = RuntimeUpgrade.layer.pipe(Layer.provide(resolvers));
	return Effect.runPromise(
		Effect.gen(function* () {
			const service = yield* RuntimeUpgrade;
			const results = yield* service.upgrade(config, dir);
			return { results, logs };
		}).pipe(Effect.provide(layer), Effect.provide(capturingLogger(logs))),
	);
};

const run = async (
	dir: string,
	config: RuntimeUpgradeConfig,
	latest: { node?: string | null; deno?: string | null; bun?: string | null } = {},
) => (await runWithLogs(dir, config, latest)).results;

const warnedAbout = (logs: ReadonlyArray<string>, runtime: string) =>
	logs.some(
		(l) =>
			l.startsWith("Warn") && l.includes(`upgrade-runtime-${runtime}`) && l.includes("no devEngines.runtime entry"),
	);

describe("RuntimeUpgrade service", () => {
	it("auto + caret range: resolves within the range and writes an exact version", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, { devEngines: { runtime: [{ name: "node", version: "^24.0.0", onFail: "ignore" }] } });

		const results = await run(dir, { ...FALSE_CFG, node: "auto" }, { node: "24.16.0" });

		// The caret ranges the RESOLUTION, but the written value is exact: downstream
		// consumers of devEngines.runtime do not support range operators.
		expect(results).toEqual([{ runtime: "node", from: "^24.0.0", to: "24.16.0" }]);
		expect(readPackageJson(dir).devEngines.runtime).toEqual([{ name: "node", version: "24.16.0", onFail: "ignore" }]);
	});

	it("auto + static pin: no-op", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, { devEngines: { runtime: [{ name: "node", version: "24.11.0" }] } });

		const results = await run(dir, { ...FALSE_CFG, node: "auto" }, { node: "24.16.0" });

		expect(results).toEqual([]);
		expect(readPackageJson(dir).devEngines.runtime[0].version).toBe("24.11.0");
	});

	it("auto + missing entry: no-op, adds nothing, and warns", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, { devEngines: { runtime: [{ name: "node", version: "^24.0.0" }] } });

		const { results, logs } = await runWithLogs(dir, { ...FALSE_CFG, deno: "auto" });

		expect(results).toEqual([]);
		expect(readPackageJson(dir).devEngines.runtime).toEqual([{ name: "node", version: "^24.0.0" }]);
		expect(warnedAbout(logs, "deno")).toBe(true);
	});

	it("explicit range + missing entry: adds nothing and warns (bun-only repo, upgrade-runtime-node set)", async () => {
		// The live dogfood failure: a bun-only manifest given upgrade-runtime-node
		// "^26.0.0" must be left completely untouched — no node entry is introduced.
		const dir = makeTempDir();
		const manifest = {
			devEngines: {
				runtime: [{ name: "bun", version: "1.3.14", onFail: "ignore" }],
				packageManager: { name: "bun", version: "1.3.14", onFail: "ignore" },
			},
		};
		writePackageJson(dir, manifest);

		const { results, logs } = await runWithLogs(dir, { ...FALSE_CFG, node: "^26.0.0" }, { node: "26.5.0" });

		expect(results).toEqual([]);
		expect(readPackageJson(dir)).toEqual(manifest);
		expect(warnedAbout(logs, "node")).toBe(true);
	});

	it("explicit range + absent devEngines: never creates the field", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, { name: "x" });

		const { results, logs } = await runWithLogs(dir, { ...FALSE_CFG, bun: "^1" }, { bun: "1.2.0" });

		expect(results).toEqual([]);
		expect(readPackageJson(dir)).toEqual({ name: "x" });
		expect(warnedAbout(logs, "bun")).toBe(true);
	});

	it("explicit range on a caret entry: resolves within the input range and writes exact", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, { devEngines: { runtime: [{ name: "node", version: "^24.0.0" }] } });

		// Input ~22.5 selects the line to resolve; the write carries no operator.
		const results = await run(dir, { ...FALSE_CFG, node: "~22.5" }, { node: "22.5.9" });

		expect(results).toEqual([{ runtime: "node", from: "^24.0.0", to: "22.5.9" }]);
		expect(readPackageJson(dir).devEngines.runtime[0].version).toBe("22.5.9");
	});

	it("explicit range on an exact pin: resolves and stays exact", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, { devEngines: { runtime: [{ name: "node", version: "24.11.0", onFail: "ignore" }] } });

		const results = await run(dir, { ...FALSE_CFG, node: "^26.0.0" }, { node: "26.2.0" });

		expect(results).toEqual([{ runtime: "node", from: "24.11.0", to: "26.2.0" }]);
		expect(readPackageJson(dir).devEngines.runtime[0].version).toBe("26.2.0");
	});

	it("single-object shape: updated in place, shape preserved", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, { devEngines: { runtime: { name: "node", version: "^24.0.0", onFail: "warn" } } });

		const results = await run(dir, { ...FALSE_CFG, node: "auto" }, { node: "24.16.0" });

		expect(results).toEqual([{ runtime: "node", from: "^24.0.0", to: "24.16.0" }]);
		expect(readPackageJson(dir).devEngines.runtime).toEqual({ name: "node", version: "24.16.0", onFail: "warn" });
	});

	it("already current: no-op", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, { devEngines: { runtime: [{ name: "node", version: "24.16.0" }] } });

		const results = await run(dir, { ...FALSE_CFG, node: "^24.0.0" }, { node: "24.16.0" });

		expect(results).toEqual([]);
	});

	it("false: skips all", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, { devEngines: { runtime: [{ name: "node", version: "^24.0.0" }] } });

		const results = await run(dir, FALSE_CFG);

		expect(results).toEqual([]);
	});

	it("multi-runtime in one call", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			devEngines: {
				runtime: [
					{ name: "node", version: "^24.0.0" },
					{ name: "bun", version: "^1.0.0" },
				],
			},
		});

		const results = await run(dir, { node: "auto", deno: "false", bun: "auto" }, { node: "24.16.0", bun: "1.2.0" });

		expect(results).toEqual([
			{ runtime: "node", from: "^24.0.0", to: "24.16.0" },
			{ runtime: "bun", from: "^1.0.0", to: "1.2.0" },
		]);
	});

	it("resolver VersionNotFoundError: per-runtime skip, others still processed", async () => {
		const dir = makeTempDir();
		writePackageJson(dir, {
			devEngines: {
				runtime: [
					{ name: "node", version: "^24.0.0" },
					{ name: "deno", version: "^2.0.0" },
				],
			},
		});

		const results = await run(dir, { node: "auto", deno: "auto", bun: "false" }, { node: null, deno: "2.1.0" });

		expect(results).toEqual([{ runtime: "deno", from: "^2.0.0", to: "2.1.0" }]);
	});

	it("preserves tab indentation", async () => {
		const dir = makeTempDir();
		writeFileSync(
			join(dir, "package.json"),
			`${JSON.stringify({ devEngines: { runtime: [{ name: "node", version: "^24.0.0" }] } }, null, "\t")}\n`,
		);

		await run(dir, { ...FALSE_CFG, node: "auto" }, { node: "24.16.0" });

		expect(readFileSync(join(dir, "package.json"), "utf-8")).toMatch(/^\t"/m);
	});
});
