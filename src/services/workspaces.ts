/**
 * Workspaces domain service.
 *
 * Thin wrapper over workspaces-effect's getWorkspacePackagesSync that
 * exposes Effect-native methods accepting an explicit workspaceRoot per
 * call. Provides a stable, testable seam for workspace lookups across the
 * codebase. Includes the root workspace package, unlike workspace-tools'
 * package-pattern-only discovery.
 *
 * With workspaces-effect v0.5.0, getWorkspacePackagesSync returns the
 * library's full WorkspacePackage Schema.Class (including relativePath,
 * packageJsonPath, version, etc.) so no local WorkspacePackageInfo shim
 * is needed.
 *
 * @module services/workspaces
 */

import { Context, Effect, Layer } from "effect";
import type { WorkspacePackage } from "workspaces-effect";
import { getWorkspacePackagesSync } from "workspaces-effect";

import { FileSystemError } from "../errors/errors.js";

// ══════════════════════════════════════════════════════════════════════════════
// Service Interface
// ══════════════════════════════════════════════════════════════════════════════

export class Workspaces extends Context.Tag("Workspaces")<
	Workspaces,
	{
		readonly listPackages: (workspaceRoot: string) => Effect.Effect<ReadonlyArray<WorkspacePackage>, FileSystemError>;
		readonly importerMap: (
			workspaceRoot: string,
		) => Effect.Effect<ReadonlyMap<string, WorkspacePackage>, FileSystemError>;
	}
>() {}

// ══════════════════════════════════════════════════════════════════════════════
// Live Layer
// ══════════════════════════════════════════════════════════════════════════════

const scanPackages = (workspaceRoot: string): Effect.Effect<ReadonlyArray<WorkspacePackage>, FileSystemError> =>
	Effect.try({
		try: () => getWorkspacePackagesSync(workspaceRoot),
		catch: (e) =>
			new FileSystemError({
				operation: "read",
				path: workspaceRoot,
				reason: `Failed to list workspace packages: ${String(e)}`,
			}),
	});

export const WorkspacesLive = Layer.succeed(Workspaces, {
	listPackages: (workspaceRoot) => scanPackages(workspaceRoot),
	importerMap: (workspaceRoot) =>
		Effect.gen(function* () {
			const packages = yield* scanPackages(workspaceRoot);
			const map = new Map<string, WorkspacePackage>();
			for (const pkg of packages) {
				map.set(pkg.relativePath, pkg);
			}
			return map;
		}),
});
