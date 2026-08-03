/**
 * Integration tests for the lockfile capture/compare pair against real
 * before/after lockfiles, parsed through workspaces-effect.
 *
 * The pnpm case proves that root-importer changes resolve to the root package's
 * actual name (not the literal "."). The bun case proves the diff is genuinely
 * package-manager agnostic: a bun repo has no pnpm-lock.yaml at all, so the
 * previous @pnpm/lockfile.fs-based reader captured nothing and reported an empty
 * diff.
 */

import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { WorkspaceDiscovery, WorkspaceRoot } from "@effected/workspaces";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { captureLockfileState, compareLockfiles } from "../../src/services/lockfile.js";
import type { SupportedPm } from "../../src/services/package-manager.js";
import { silentLogger } from "../utils/fixtures.js";
import { loadFixture } from "./utils/load-fixture.js";

/** Run an effect with the default logger silenced. See `silentLogger`. */
const runSilent = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
	Effect.runPromise(effect.pipe(Effect.provide(silentLogger)));

const platform = NodeServices.layer;

// @effected/workspaces binds the discovery root at layer-build time, so the
// discovery layer must be built against the fixture dir (not process.cwd()).
const discoveryLayerFor = (cwd: string) =>
	WorkspaceDiscovery.layer({ cwd }).pipe(
		Layer.provide(Layer.merge(WorkspaceRoot.layer.pipe(Layer.provide(platform)), platform)),
	);

/**
 * Stage the `<lockfile>.before` / `<lockfile>.after` pair over the real lockfile
 * name in turn, capturing each, then compare the two snapshots.
 */
const captureAndCompare = async (fixturePath: string, pm: SupportedPm, lockfileName: string) => {
	copyFileSync(join(fixturePath, `${lockfileName}.before`), join(fixturePath, lockfileName));
	const before = await runSilent(captureLockfileState(pm, fixturePath));

	copyFileSync(join(fixturePath, `${lockfileName}.after`), join(fixturePath, lockfileName));
	const after = await runSilent(captureLockfileState(pm, fixturePath));

	return runSilent(compareLockfiles(before, after, fixturePath).pipe(Effect.provide(discoveryLayerFor(fixturePath))));
};

describe("Lockfile.compare integration - pnpm", () => {
	it("attributes a root devDep change to the root package's real name", async () => {
		const fixture = loadFixture("single-package-private-root");

		// The pnpm fixture predates the shared naming, so stage it by hand.
		copyFileSync(join(fixture.path, "pnpm-lock.before.yaml"), join(fixture.path, "pnpm-lock.yaml"));
		const before = await runSilent(captureLockfileState("pnpm", fixture.path));

		copyFileSync(join(fixture.path, "pnpm-lock.after.yaml"), join(fixture.path, "pnpm-lock.yaml"));
		const after = await runSilent(captureLockfileState("pnpm", fixture.path));

		const changes = await runSilent(
			compareLockfiles(before, after, fixture.path).pipe(Effect.provide(discoveryLayerFor(fixture.path))),
		);

		const lodashChange = changes.find((c) => c.dependency === "lodash");
		expect(lodashChange, "expected a lodash change to be detected").toBeDefined();
		expect(lodashChange?.affectedPackages, "root importer should resolve to its real name").toContain("test-root");
		expect(lodashChange?.affectedPackages, "should NOT contain the bare importer id").not.toContain(".");
	});
});

describe("Lockfile.compare integration - bun", () => {
	it("surfaces a bun catalog bump with its consuming importer and section", async () => {
		const fixture = loadFixture("bun-catalog-bump");

		const changes = await captureAndCompare(fixture.path, "bun", "bun.lock");

		const effectChange = changes.find((c) => c.dependency === "effect");
		expect(effectChange, "expected the catalog:silk bump to be detected").toBeDefined();
		expect(effectChange?.from).toBe("^3.0.0");
		expect(effectChange?.to).toBe("^3.1.0");
		// The catalog is defined at the root but consumed by the workspace package,
		// so the change must be attributed to the consumer, by its real name.
		expect(effectChange?.affectedPackages).toEqual(["@fixture/core"]);
		expect(effectChange?.type).toBe("dependency");
	});

	it("surfaces a bun importer specifier change with its section type", async () => {
		const fixture = loadFixture("bun-catalog-bump");

		const changes = await captureAndCompare(fixture.path, "bun", "bun.lock");

		// bun records no per-importer resolved version, so this is a specifier diff.
		const tsChange = changes.find((c) => c.dependency === "typescript");
		expect(tsChange).toBeDefined();
		expect(tsChange?.type).toBe("devDependency");
		expect(tsChange?.from).toBe("^5.6.0");
		expect(tsChange?.to).toBe("^5.7.0");
		expect(tsChange?.affectedPackages).toEqual(["@fixture/core"]);
	});

	it("surfaces a bun DEFAULT-catalog bump (bun.lock's top-level catalog key) end-to-end", async () => {
		const fixture = loadFixture("bun-catalog-bump");

		const changes = await captureAndCompare(fixture.path, "bun", "bun.lock");

		// bun's default catalog lives at the lockfile's top-level "catalog" key
		// (as opposed to named catalogs under "catalogs"), and must be folded
		// under the "default" key by the comparison. This is the one exercised
		// through the REAL parser: a bug here would make every default-catalog
		// change invisible while a hand-constructed unit test kept passing.
		const zodChange = changes.find((c) => c.dependency === "zod");
		expect(zodChange, "expected the bare `catalog:` (default catalog) bump to be detected").toBeDefined();
		expect(zodChange?.from).toBe("^3.22.0");
		expect(zodChange?.to).toBe("^3.23.0");
		expect(zodChange?.affectedPackages).toEqual(["@fixture/core"]);
		expect(zodChange?.type).toBe("dependency");
	});
});
