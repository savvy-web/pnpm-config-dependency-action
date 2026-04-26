/**
 * Workspaces domain service.
 *
 * Thin wrapper over workspaces-effect's WorkspaceDiscovery so the rest of
 * the codebase has a single, stable seam for workspace lookups. Unlike the
 * previous workspace-tools-based code path, the underlying discovery
 * always includes the root package as a WorkspacePackage with
 * isRootWorkspace: true.
 *
 * @module services/workspaces
 */

import { Context, Effect, Layer } from "effect";
import type { WorkspaceDiscoveryError, WorkspacePackage } from "workspaces-effect";
import { WorkspaceDiscovery } from "workspaces-effect";

// ══════════════════════════════════════════════════════════════════════════════
// Service Interface
// ══════════════════════════════════════════════════════════════════════════════

export class Workspaces extends Context.Tag("Workspaces")<
	Workspaces,
	{
		readonly listPackages: () => Effect.Effect<ReadonlyArray<WorkspacePackage>, WorkspaceDiscoveryError>;
		readonly importerMap: () => Effect.Effect<ReadonlyMap<string, WorkspacePackage>, WorkspaceDiscoveryError>;
	}
>() {}

// ══════════════════════════════════════════════════════════════════════════════
// Live Layer
// ══════════════════════════════════════════════════════════════════════════════

export const WorkspacesLive = Layer.effect(
	Workspaces,
	Effect.gen(function* () {
		const discovery = yield* WorkspaceDiscovery;
		return {
			listPackages: () => discovery.listPackages(),
			importerMap: () => discovery.importerMap(),
		};
	}),
);
