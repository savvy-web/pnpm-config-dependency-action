/**
 * Lockfile service for capturing and comparing pnpm lockfile state.
 *
 * Uses @pnpm/lockfile.fs to read and compare lockfile snapshots.
 *
 * @module services/lockfile
 */

import { readWantedLockfile } from "@pnpm/lockfile.fs";
import type { CatalogSnapshots, LockfileObject, ResolvedCatalogEntry } from "@pnpm/lockfile.types";
import { Context, Effect, Layer } from "effect";
import { WorkspaceDiscovery } from "workspaces-effect";
import { LockfileError } from "../errors/errors.js";
import type { LockfileChange } from "../schemas/domain.js";

// ══════════════════════════════════════════════════════════════════════════════
// Service Interface
// ══════════════════════════════════════════════════════════════════════════════

export class Lockfile extends Context.Tag("Lockfile")<
	Lockfile,
	{
		readonly capture: (workspaceRoot?: string) => Effect.Effect<LockfileObject | null, LockfileError>;
		readonly compare: (
			before: LockfileObject | null,
			after: LockfileObject | null,
			workspaceRoot?: string,
		) => Effect.Effect<ReadonlyArray<LockfileChange>, LockfileError, WorkspaceDiscovery>;
	}
>() {}

export const LockfileLive = Layer.succeed(Lockfile, {
	capture: (workspaceRoot = process.cwd()) => captureLockfileStateImpl(workspaceRoot),
	compare: (before, after, workspaceRoot = process.cwd()) => compareLockfilesImpl(before, after, workspaceRoot),
});

// ══════════════════════════════════════════════════════════════════════════════
// Standalone Function Exports
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Capture current lockfile state.
 *
 * Standalone function exported for direct use by consumers that
 * haven't yet migrated to the Lockfile service.
 */
export const captureLockfileState = (
	workspaceRoot: string = process.cwd(),
): Effect.Effect<LockfileObject | null, LockfileError> => captureLockfileStateImpl(workspaceRoot);

/**
 * Compare two lockfile states to detect dependency changes.
 *
 * Standalone function exported for direct use by consumers that
 * haven't yet migrated to the Lockfile service.
 */
export const compareLockfiles = (
	before: LockfileObject | null,
	after: LockfileObject | null,
	workspaceRoot: string = process.cwd(),
): Effect.Effect<ReadonlyArray<LockfileChange>, LockfileError, WorkspaceDiscovery> =>
	compareLockfilesImpl(before, after, workspaceRoot);

/**
 * Group lockfile changes by affected package.
 */
export const groupChangesByPackage = (changes: ReadonlyArray<LockfileChange>): Map<string, LockfileChange[]> => {
	const grouped = new Map<string, LockfileChange[]>();

	for (const change of changes) {
		if (change.type === "config") {
			// Config changes go under a special "root" key
			const existing = grouped.get("(root)") ?? [];
			existing.push(change);
			grouped.set("(root)", existing);
		} else {
			for (const pkg of change.affectedPackages) {
				const existing = grouped.get(pkg) ?? [];
				existing.push(change);
				grouped.set(pkg, existing);
			}
		}
	}

	return grouped;
};

// ══════════════════════════════════════════════════════════════════════════════
// Implementation Functions
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Capture current lockfile state.
 */
const captureLockfileStateImpl = (workspaceRoot: string): Effect.Effect<LockfileObject | null, LockfileError> =>
	Effect.tryPromise({
		try: () => readWantedLockfile(workspaceRoot, { ignoreIncompatible: true }),
		catch: (e) =>
			new LockfileError({
				operation: "read",
				reason: String(e),
			}),
	});

/**
 * Dependency snapshot from an importer (package).
 */
interface DependencySnapshot {
	specifier: string;
	version: string;
}

/**
 * Build a map from importer path (relative to workspace root, "." for root)
 * to package name, via WorkspaceDiscovery.
 *
 * Importer "." resolves to the root's actual name rather than falling
 * through to the bare importer id.
 */
const buildImporterToPackageMap = (
	workspaceRoot: string,
): Effect.Effect<Map<string, string>, LockfileError, WorkspaceDiscovery> =>
	Effect.gen(function* () {
		const discovery = yield* WorkspaceDiscovery;
		const importerMap = yield* discovery.importerMap(workspaceRoot).pipe(
			Effect.catchAll((e) =>
				Effect.gen(function* () {
					yield* Effect.logWarning(`Failed to read workspace importer map: ${String(e)}`);
					return new Map();
				}),
			),
		);

		const out = new Map<string, string>();
		for (const [relativePath, pkg] of importerMap) {
			out.set(relativePath, pkg.name);
		}
		return out;
	});

/**
 * Compare two lockfile states to detect dependency changes.
 */
const compareLockfilesImpl = (
	before: LockfileObject | null,
	after: LockfileObject | null,
	workspaceRoot: string,
): Effect.Effect<ReadonlyArray<LockfileChange>, LockfileError, WorkspaceDiscovery> =>
	Effect.gen(function* () {
		if (!before || !after) {
			yield* Effect.logWarning("Cannot compare lockfiles: one or both are null");
			return [];
		}

		// Log lockfile structure for debugging
		yield* Effect.logDebug("=== Lockfile Structure (Before) ===");
		yield* Effect.logDebug(`Before catalogs: ${JSON.stringify(Object.keys(before.catalogs ?? {}))}`);
		yield* Effect.logDebug(`Before importers: ${JSON.stringify(Object.keys(before.importers ?? {}))}`);
		yield* Effect.logDebug(`Before lockfile keys: ${JSON.stringify(Object.keys(before))}`);

		yield* Effect.logDebug("=== Lockfile Structure (After) ===");
		yield* Effect.logDebug(`After catalogs: ${JSON.stringify(Object.keys(after.catalogs ?? {}))}`);
		yield* Effect.logDebug(`After importers: ${JSON.stringify(Object.keys(after.importers ?? {}))}`);

		// Build importer to package map first (needed for both catalog and importer comparison)
		const importerToPackage = yield* buildImporterToPackageMap(workspaceRoot);
		yield* Effect.logDebug(`Importer to package map: ${JSON.stringify(Object.fromEntries(importerToPackage))}`);

		const changes: LockfileChange[] = [];

		// Compare catalog snapshots
		// NOTE: Catalogs are shared version definitions (catalog:silk, etc.)
		// These are NOT the same as configDependencies from pnpm-workspace.yaml
		const catalogChanges = yield* compareCatalogs(
			before.catalogs ?? {},
			after.catalogs ?? {},
			after,
			importerToPackage,
		);
		if (catalogChanges.length > 0) {
			yield* Effect.logDebug(`Catalog changes detected: ${catalogChanges.length}`);
			for (const change of catalogChanges) {
				yield* Effect.logDebug(
					`  - ${change.dependency} in [${change.affectedPackages.join(", ")}]: ${change.from} -> ${change.to}`,
				);
			}
		}
		changes.push(...catalogChanges);

		// Compare package importers (regular dependencies - non-catalog specifier changes)
		const packageChanges = yield* compareImporters(before, after, importerToPackage);
		if (packageChanges.length > 0) {
			yield* Effect.logDebug(`Importer changes detected: ${packageChanges.length}`);
			for (const change of packageChanges) {
				yield* Effect.logDebug(
					`  - ${change.dependency} in ${change.affectedPackages.join(", ")}: ${change.from} -> ${change.to}`,
				);
			}
		}
		changes.push(...packageChanges);

		yield* Effect.logInfo(`Detected ${changes.length} dependency change(s)`);

		return changes;
	});

/**
 * Find each (importer, dep section) pair that consumes a catalog entry.
 *
 * Returns one record per consumer per dep section, so callers can emit a
 * LockfileChange with the precise type field. Catalog refs in
 * devDependencies are returned with type "devDependency" — downstream
 * Changesets gating treats those as informational only.
 */
const findCatalogConsumers = (
	importers: LockfileObject["importers"],
	catalogName: string,
	dependencyName: string,
	importerToPackage: Map<string, string>,
): ReadonlyArray<{ readonly packageName: string; readonly type: LockfileChange["type"] }> => {
	const consumers: Array<{ readonly packageName: string; readonly type: LockfileChange["type"] }> = [];
	const catalogSpecifier = catalogName === "default" ? "catalog:" : `catalog:${catalogName}`;
	const depSections = [
		{ field: "dependencies", type: "dependency" as const },
		{ field: "devDependencies", type: "devDependency" as const },
		{ field: "optionalDependencies", type: "optionalDependency" as const },
		{ field: "peerDependencies", type: "peerDependency" as const },
	];
	for (const [importerId, snapshot] of Object.entries(importers ?? {})) {
		// In pnpm lockfile v9, the specifier for a dep lives in `snapshot.specifiers`,
		// not inside the `dependencies` object entries (which only contain the resolved version).
		// Check specifiers first; fall back to scanning dependency object entries for
		// older lockfile shapes that embed { specifier, version } objects.
		type SpecifiersRecord = Record<string, string>;
		const specifiers = (snapshot.specifiers ?? {}) as SpecifiersRecord;
		const specifier = specifiers[dependencyName];

		if (specifier !== undefined) {
			// Fast path: specifier found in the top-level specifiers map
			if (specifier.startsWith(catalogSpecifier)) {
				// Emit one record per dep section the dep is declared in.
				// A dep in both dependencies and peerDependencies (unusual but
				// valid) gets two records, mirroring the fallback path below.
				for (const { field, type } of depSections) {
					const deps = snapshot[field as keyof typeof snapshot] as Record<string, unknown> | undefined;
					if (deps && dependencyName in deps) {
						const packageName = importerToPackage.get(importerId) ?? importerId;
						consumers.push({ packageName, type });
					}
				}
			}
		} else {
			// Fallback: older lockfile shapes may embed DependencySnapshot objects
			for (const { field, type } of depSections) {
				const deps = snapshot[field as keyof typeof snapshot] as Record<string, DependencySnapshot> | undefined;
				if (!deps) continue;
				const dep = deps[dependencyName];
				if (dep?.specifier?.startsWith(catalogSpecifier)) {
					const packageName = importerToPackage.get(importerId) ?? importerId;
					consumers.push({ packageName, type });
				}
			}
		}
	}
	return consumers;
};

/**
 * Compare catalog snapshots to detect catalog version changes.
 *
 * NOTE: Catalogs (catalog:silk, etc.) are shared version definitions.
 * These are different from configDependencies in pnpm-workspace.yaml.
 *
 * Emits one LockfileChange per (catalog change, consuming importer, dep section)
 * triple. Each record carries the accurate type field (dependency, devDependency,
 * optionalDependency, peerDependency) so downstream consumers can use type alone
 * as the trigger signal.
 */
const compareCatalogs = (
	before: CatalogSnapshots,
	after: CatalogSnapshots,
	afterLockfile: LockfileObject,
	importerToPackage: Map<string, string>,
): Effect.Effect<ReadonlyArray<LockfileChange>, never> =>
	Effect.gen(function* () {
		const changes: LockfileChange[] = [];

		yield* Effect.logDebug("=== Comparing Catalogs ===");

		for (const [catalogName, afterEntries] of Object.entries(after)) {
			const beforeEntries = before[catalogName] ?? {};

			for (const [dep, afterEntry] of Object.entries(afterEntries as Record<string, ResolvedCatalogEntry>)) {
				const beforeEntry = beforeEntries[dep] as ResolvedCatalogEntry | undefined;
				const afterSpecifier = afterEntry.specifier;
				const beforeSpecifier = beforeEntry?.specifier ?? null;
				const afterVersion = afterEntry.version;
				const beforeVersion = beforeEntry?.version ?? null;

				if (beforeSpecifier !== afterSpecifier || beforeVersion !== afterVersion) {
					const from = beforeSpecifier !== afterSpecifier ? beforeSpecifier : beforeVersion;
					const to = beforeSpecifier !== afterSpecifier ? afterSpecifier : afterVersion;

					const consumers = findCatalogConsumers(afterLockfile.importers, catalogName, dep, importerToPackage);

					yield* Effect.logDebug(
						`Catalog change: ${dep} (${catalogName}): ${from} -> ${to}; ${consumers.length} consumer(s)`,
					);

					for (const consumer of consumers) {
						changes.push({
							type: consumer.type,
							dependency: dep,
							from,
							to,
							affectedPackages: [consumer.packageName],
						});
					}
				}
			}
		}

		// Removed-catalog handling unchanged
		for (const [catalogName, beforeEntries] of Object.entries(before)) {
			const afterEntries = after[catalogName] ?? {};
			for (const dep of Object.keys(beforeEntries as Record<string, unknown>)) {
				if (!(dep in afterEntries)) {
					const beforeEntry = (beforeEntries as Record<string, ResolvedCatalogEntry>)[dep];
					yield* Effect.logDebug(`Catalog removed: ${dep} (${catalogName})`);
					changes.push({
						type: "dependency",
						dependency: dep,
						from: beforeEntry.specifier,
						to: "(removed)",
						affectedPackages: [],
					});
				}
			}
		}

		return changes;
	});

/**
 * Typed dependency sections to iterate when comparing importers.
 */
const DEP_SECTIONS = [
	{ field: "dependencies", type: "dependency" },
	{ field: "devDependencies", type: "devDependency" },
	{ field: "optionalDependencies", type: "optionalDependency" },
] as const;

/**
 * Compare package importers to detect which packages have changed dependencies.
 *
 * NOTE: This only detects changes to non-catalog specifiers. Catalog specifier
 * changes (e.g., catalog:silk) don't change the specifier itself, only the
 * resolved version - those are handled by compareCatalogs.
 */
const compareImporters = (
	before: LockfileObject,
	after: LockfileObject,
	importerToPackage: Map<string, string>,
): Effect.Effect<ReadonlyArray<LockfileChange>, never> =>
	Effect.sync(() => {
		const changes: LockfileChange[] = [];

		const afterImporters = after.importers ?? {};
		const beforeImporters = before.importers ?? {};

		for (const importerId of Object.keys(afterImporters)) {
			const afterSnapshot = afterImporters[importerId as keyof typeof afterImporters];
			const beforeSnapshot = beforeImporters[importerId as keyof typeof beforeImporters];
			if (!beforeSnapshot || !afterSnapshot) continue;

			const packageName = importerToPackage.get(importerId) ?? importerId;

			// Compare specifiers (version specifiers in package.json)
			type SpecifiersRecord = Record<string, string>;
			const beforeSpecifiers = (beforeSnapshot.specifiers ?? {}) as SpecifiersRecord;
			const afterSpecifiers = (afterSnapshot.specifiers ?? {}) as SpecifiersRecord;

			// Build dep-to-type map from typed sections to determine which field each dep is in
			const depTypeMap = new Map<string, LockfileChange["type"]>();
			for (const { field, type } of DEP_SECTIONS) {
				const deps = (afterSnapshot[field] ?? {}) as SpecifiersRecord;
				for (const dep of Object.keys(deps)) {
					depTypeMap.set(dep, type);
				}
			}

			for (const [dep, afterVersion] of Object.entries(afterSpecifiers)) {
				const beforeVersion = beforeSpecifiers[dep];

				// Skip catalog specifiers - those are handled by compareCatalogs
				if (afterVersion.startsWith("catalog:")) continue;

				if (beforeVersion !== afterVersion) {
					changes.push({
						type: depTypeMap.get(dep) ?? "dependency",
						dependency: dep,
						from: beforeVersion ?? null,
						to: afterVersion,
						affectedPackages: [packageName],
					});
				}
			}

			// Check for removed dependencies
			for (const dep of Object.keys(beforeSpecifiers)) {
				if (!(dep in afterSpecifiers)) {
					// Use before snapshot to determine type of removed dep
					let removedType: LockfileChange["type"] = "dependency";
					for (const { field, type } of DEP_SECTIONS) {
						const deps = (beforeSnapshot[field] ?? {}) as SpecifiersRecord;
						if (dep in deps) {
							removedType = type;
							break;
						}
					}
					changes.push({
						type: removedType,
						dependency: dep,
						from: beforeSpecifiers[dep],
						to: "(removed)",
						affectedPackages: [packageName],
					});
				}
			}
		}

		return changes;
	});
