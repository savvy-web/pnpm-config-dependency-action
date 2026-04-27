/**
 * Workspaces domain service.
 *
 * Thin wrapper over workspaces-effect's getWorkspacePackagesSync that
 * exposes Effect-native methods accepting an explicit workspaceRoot per
 * call. Provides a stable, testable seam for workspace lookups across the
 * codebase. Includes the root workspace package, unlike workspace-tools'
 * package-pattern-only discovery.
 *
 * @module services/workspaces
 */

import { Context, Effect, Layer } from "effect";
import { getWorkspacePackagesSync } from "workspaces-effect";

import { FileSystemError } from "../errors/errors.js";

// ══════════════════════════════════════════════════════════════════════════════
// Service Interface
// ══════════════════════════════════════════════════════════════════════════════

export interface WorkspacePackageInfo {
	readonly name: string;
	readonly path: string;
}

export class Workspaces extends Context.Tag("Workspaces")<
	Workspaces,
	{
		readonly listPackages: (
			workspaceRoot: string,
		) => Effect.Effect<ReadonlyArray<WorkspacePackageInfo>, FileSystemError>;
		readonly importerMap: (
			workspaceRoot: string,
		) => Effect.Effect<ReadonlyMap<string, WorkspacePackageInfo>, FileSystemError>;
	}
>() {}

// ══════════════════════════════════════════════════════════════════════════════
// Live Layer
// ══════════════════════════════════════════════════════════════════════════════

const scanPackages = (workspaceRoot: string): Effect.Effect<ReadonlyArray<WorkspacePackageInfo>, FileSystemError> =>
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
			const map = new Map<string, WorkspacePackageInfo>();
			const normalizedRoot = workspaceRoot.replace(/\/$/, "");
			for (const pkg of packages) {
				const normalizedPkgPath = pkg.path.replace(/\/$/, "");
				const relativePath =
					normalizedPkgPath === normalizedRoot ? "." : normalizedPkgPath.replace(`${normalizedRoot}/`, "");
				map.set(relativePath, pkg);
			}
			return map;
		}),
});
