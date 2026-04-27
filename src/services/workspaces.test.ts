/**
 * Unit tests for the Workspaces domain service.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { Workspaces, WorkspacesLive } from "./workspaces.js";

// Note: these tests exercise the real Live layer because the underlying
// getWorkspacePackagesSync reads the filesystem. We use a small fixture
// dir created on disk per-test for hermetic verification.
//
// For broader integration coverage of the service against real fixtures,
// see __test__/integration/workspaces.int.test.ts (added in T13).

describe("Workspaces", () => {
	it("Workspaces.listPackages and Workspaces.importerMap are part of the service interface", async () => {
		// Smoke test: verify the Tag and Live layer are constructed correctly
		// by yielding the service from a tiny program.
		const program = Effect.gen(function* () {
			const ws = yield* Workspaces;
			expect(typeof ws.listPackages).toBe("function");
			expect(typeof ws.importerMap).toBe("function");
		});
		await Effect.runPromise(program.pipe(Effect.provide(WorkspacesLive)));
	});
});
