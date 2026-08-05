import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const layer = RuntimeUpgrade.layer.pipe(Layer.provide(offlineResolvers));

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
});
