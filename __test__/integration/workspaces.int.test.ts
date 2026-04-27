/**
 * Integration tests for the Workspaces domain service against real fixtures.
 *
 * Verifies that the service (which wraps workspaces-effect's
 * getWorkspacePackagesSync) correctly returns the root and all workspace
 * leaf packages for both single-leaf and multi-leaf fixtures.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { Workspaces, WorkspacesLive } from "../../src/services/workspaces.js";
import { loadFixture } from "./utils/load-fixture.js";

const runWith = <A, E>(eff: Effect.Effect<A, E, Workspaces>): Promise<A> =>
	Effect.runPromise(Effect.provide(eff, WorkspacesLive));

describe("Workspaces integration", () => {
	it("listPackages returns the root and leaf for a single-leaf private root fixture", async () => {
		const fixture = loadFixture("single-package-private-root");

		const packages = await runWith(
			Effect.gen(function* () {
				const ws = yield* Workspaces;
				return yield* ws.listPackages(fixture.path);
			}),
		);

		const names = packages.map((p) => p.name).sort();
		expect(names).toEqual(["@scope/test-leaf", "test-root"]);
	});

	it("importerMap keys '.' to the root package for the single-leaf fixture", async () => {
		const fixture = loadFixture("single-package-private-root");

		const map = await runWith(
			Effect.gen(function* () {
				const ws = yield* Workspaces;
				return yield* ws.importerMap(fixture.path);
			}),
		);

		expect(map.get(".")?.name).toBe("test-root");
		expect(map.get("package")?.name).toBe("@scope/test-leaf");
	});

	it("listPackages returns root + 2 leaves for a multi-leaf public root fixture", async () => {
		const fixture = loadFixture("multi-package-public-root");

		const packages = await runWith(
			Effect.gen(function* () {
				const ws = yield* Workspaces;
				return yield* ws.listPackages(fixture.path);
			}),
		);

		const names = packages.map((p) => p.name).sort();
		expect(names).toEqual(["@scope/a", "@scope/b", "test-root-multi"]);
	});
});
