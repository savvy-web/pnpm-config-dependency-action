import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { PackageJsonFile } from "@effected/package-json";
import { BunResolver, DenoResolver, NodeResolver } from "@effected/runtimes";
import { Range, SemVer } from "@effected/semver";
import { Effect, Layer, References } from "effect";
import { describe, expect, it } from "vitest";
import { RuntimeUpgrade } from "../../src/services/runtime-upgrade.js";

// NOTE: The plan originally used Node 20 here, but the bundled offline cache in
// runtime-resolver only contains active-LTS/current entries (24.x and 26.x).
// Node 20 reached EOL and left the cache. We use ^24.0.0 (lowest major present)
// as the drift-canary fixture instead.

const offlineResolvers = Layer.mergeAll(NodeResolver.layerOffline, DenoResolver.layerOffline, BunResolver.layerOffline);
const layer = RuntimeUpgrade.layer.pipe(
	Layer.provide(Layer.merge(offlineResolvers, PackageJsonFile.layer.pipe(Layer.provide(NodeServices.layer)))),
);

describe("RuntimeUpgrade integration (offline cache)", () => {
	it("auto resolves a real Node 24.x from the bundled cache and writes it EXACT", async () => {
		const dir = mkdtempSync(join(tmpdir(), "runtime-int-"));
		writeFileSync(
			join(dir, "package.json"),
			`${JSON.stringify({ devEngines: { runtime: [{ name: "node", version: "^24.0.0", onFail: "ignore" }] } }, null, "\t")}\n`,
		);

		const results = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* RuntimeUpgrade;
				return yield* service.upgrade({ node: "auto", deno: "false", bun: "false" }, dir);
			}).pipe(Effect.provide(layer), Effect.provideService(References.MinimumLogLevel, "None")),
		);

		expect(results).toHaveLength(1);
		const update = results[0];
		expect(update.runtime).toBe("node");
		expect(update.from).toBe("^24.0.0");
		// A REAL version was resolved from the bundled cache — and it is written bare,
		// with no range operator carried over from the "^24.0.0" entry.
		expect(update.to).toMatch(/^24\.\d+\.\d+$/);

		// The resolved version actually satisfies the original range.
		const ok = await Effect.runPromise(
			Effect.gen(function* () {
				const range = yield* Range.parse("^24.0.0");
				const version = yield* SemVer.parse(update.to);
				return range.test(version);
			}),
		);
		expect(ok).toBe(true);

		// And it was written to disk, exactly, with the entry's other keys intact.
		const written = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
		expect(written.devEngines.runtime).toEqual([{ name: "node", version: update.to, onFail: "ignore" }]);
	});
	it("preserves key order, indentation and every unrelated byte in an UNSORTED manifest", async () => {
		// THE probe #245 was declined over, and it only means anything against a
		// deliberately unsorted fixture. This repo's own package.json is sorted by
		// lint-staged, so a reorder is a no-op here — testing against it would show
		// nothing at all and read as a pass. Hence a hand-built manifest whose keys
		// are in a deliberately non-canonical order.
		//
		// What this catches: a writer that re-serializes the parsed object (the old
		// behaviour) or sorts keys canonically (the behaviour that made
		// @effected/package-json unusable here) rewrites regions the action never
		// intended to touch — in a file it then commits to someone else's
		// repository, where an unreviewable diff is the actual harm.
		const dir = mkdtempSync(join(tmpdir(), "runtime-order-"));
		const original = [
			"{",
			'\t"dependencies": {',
			'\t\t"zod": "^3.0.0"',
			"\t},",
			'\t"name": "unsorted-fixture",',
			'\t"devEngines": {',
			'\t\t"runtime": [',
			"\t\t\t{",
			'\t\t\t\t"name": "node",',
			'\t\t\t\t"version": "^24.0.0",',
			'\t\t\t\t"onFail": "ignore"',
			"\t\t\t}",
			"\t\t]",
			"\t},",
			'\t"version": "0.0.0",',
			'\t"scripts": {',
			'\t\t"build": "tsc"',
			"\t}",
			"}",
			"",
		].join("\n");
		writeFileSync(join(dir, "package.json"), original);

		const results = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* RuntimeUpgrade;
				return yield* service.upgrade({ node: "auto", deno: "false", bun: "false" }, dir);
			}).pipe(Effect.provide(layer), Effect.provideService(References.MinimumLogLevel, "None")),
		);
		expect(results).toHaveLength(1);
		const resolved = results[0].to;

		const after = readFileSync(join(dir, "package.json"), "utf-8");

		// 1. Key order survives — the specific failure that got the kit's writer
		//    declined. Asserted on the raw text, since a JSON.parse comparison is
		//    order-blind and would pass against a canonically sorted rewrite.
		expect(Object.keys(JSON.parse(after))).toEqual(["dependencies", "name", "devEngines", "version", "scripts"]);

		// 2. Nothing outside the edited span moved: the whole file is byte-identical
		//    to the original once the one version string is substituted back.
		expect(after.replace(resolved, "^24.0.0")).toBe(original);

		// 3. Tabs and the trailing newline survive.
		expect(after).toContain('\t"dependencies": {');
		expect(after.endsWith("}\n")).toBe(true);
	});
});
