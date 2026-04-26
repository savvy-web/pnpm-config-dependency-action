/**
 * Unit tests for the Workspaces domain service.
 */

import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import type { WorkspacePackage } from "workspaces-effect";
import { WorkspaceDiscovery } from "workspaces-effect";
import { Workspaces, WorkspacesLive } from "./workspaces.js";

const fakePackage = (name: string, isRoot: boolean): WorkspacePackage =>
	({
		name,
		path: isRoot ? "/tmp/root" : `/tmp/root/packages/${name.replace(/^@.*\//, "")}`,
		isRootWorkspace: isRoot,
	}) as unknown as WorkspacePackage;

describe("Workspaces", () => {
	it("listPackages forwards the underlying WorkspaceDiscovery result, including root", () =>
		Effect.gen(function* () {
			const ws = yield* Workspaces;
			const packages = yield* ws.listPackages();
			expect(packages.map((p) => p.name)).toEqual(["test-root", "@scope/leaf"]);
			expect(packages[0].isRootWorkspace).toBe(true);
		}).pipe(
			Effect.provide(
				WorkspacesLive.pipe(
					Layer.provide(
						Layer.succeed(WorkspaceDiscovery, {
							listPackages: () => Effect.succeed([fakePackage("test-root", true), fakePackage("@scope/leaf", false)]),
							getPackage: () => Effect.die("not used"),
							importerMap: () => Effect.die("not used in this test"),
						}),
					),
				),
			),
			Effect.runPromise,
		));

	it("importerMap returns a map keyed by relative path, including '.' for root", () =>
		Effect.gen(function* () {
			const ws = yield* Workspaces;
			const map = yield* ws.importerMap();
			expect([...map.keys()].sort()).toEqual([".", "packages/leaf"].sort());
			expect(map.get(".")?.name).toBe("test-root");
		}).pipe(
			Effect.provide(
				WorkspacesLive.pipe(
					Layer.provide(
						Layer.succeed(WorkspaceDiscovery, {
							listPackages: () => Effect.die("not used"),
							getPackage: () => Effect.die("not used"),
							importerMap: () =>
								Effect.succeed(
									new Map<string, WorkspacePackage>([
										[".", fakePackage("test-root", true)],
										["packages/leaf", fakePackage("@scope/leaf", false)],
									]),
								),
						}),
					),
				),
			),
			Effect.runPromise,
		));
});
