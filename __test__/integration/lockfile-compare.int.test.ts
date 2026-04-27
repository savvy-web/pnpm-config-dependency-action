/**
 * Integration test for Lockfile.compare against real before/after lockfiles.
 *
 * Proves that root-importer changes resolve to the root package's actual
 * name (not the literal "."). Fails on workspace-tools-based code path.
 */

import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { captureLockfileState, compareLockfiles } from "../../src/services/lockfile.js";
import { WorkspacesLive } from "../../src/services/workspaces.js";
import { loadFixture } from "./utils/load-fixture.js";

describe("Lockfile.compare integration", () => {
	it("attributes a root devDep change to the root package's real name", async () => {
		const fixture = loadFixture("single-package-private-root");

		// Stage 1: capture the "before" lockfile
		copyFileSync(join(fixture.path, "pnpm-lock.before.yaml"), join(fixture.path, "pnpm-lock.yaml"));

		const before = await Effect.runPromise(captureLockfileState(fixture.path));

		// Stage 2: capture the "after" lockfile
		copyFileSync(join(fixture.path, "pnpm-lock.after.yaml"), join(fixture.path, "pnpm-lock.yaml"));

		const after = await Effect.runPromise(captureLockfileState(fixture.path));

		// Stage 3: compare and inspect
		const changes = await Effect.runPromise(
			compareLockfiles(before, after, fixture.path).pipe(Effect.provide(WorkspacesLive)),
		);

		const lodashChange = changes.find((c) => c.dependency === "lodash");
		expect(lodashChange, "expected a lodash change to be detected").toBeDefined();
		expect(lodashChange?.affectedPackages, "root importer should resolve to its real name").toContain("test-root");
		expect(lodashChange?.affectedPackages, "should NOT contain the bare importer id").not.toContain(".");
	});
});
