/**
 * Lockfile comparison utilities for detecting dependency changes.
 *
 * Uses @pnpm/lockfile.fs to read and compare lockfile snapshots.
 *
 * @module lockfile/compare
 */

import { normalize } from "node:path";
import { readWantedLockfile } from "@pnpm/lockfile.fs";
import type { CatalogSnapshots, LockfileObject } from "@pnpm/lockfile.types";
import { Effect } from "effect";
import { getPackageInfosAsync } from "workspace-tools";

import type { LockfileChange } from "../../types/index.js";
import { LockfileError } from "../errors/types.js";
import { logDebug, logDebugState } from "../logging.js";

/**
 * Capture current lockfile state.
 */
export const captureLockfileState = (
	workspaceRoot: string = process.cwd(),
): Effect.Effect<LockfileObject | null, LockfileError> =>
	Effect.tryPromise({
		try: () => readWantedLockfile(workspaceRoot, { ignoreIncompatible: true }),
		catch: (e) =>
			new LockfileError({
				operation: "read",
				reason: String(e),
			}),
	});

/**
 * Build a map from importer path to package name.
 */
const buildImporterToPackageMap = (workspaceRoot: string): Effect.Effect<Map<string, string>, LockfileError> =>
	Effect.gen(function* () {
		const packageInfos = yield* Effect.tryPromise({
			try: () => getPackageInfosAsync(workspaceRoot),
			catch: (e) =>
				new LockfileError({
					operation: "read",
					reason: `Failed to get package info: ${e}`,
				}),
		}).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

		const importerToPackage = new Map<string, string>();
		const normalizedRoot = normalize(workspaceRoot);

		if (packageInfos) {
			for (const [name, info] of Object.entries(packageInfos)) {
				// Derive package directory from packageJsonPath
				const pkgDir = normalize(info.packageJsonPath.replace(/\/package\.json$/, ""));
				// Get relative path from workspace root
				const relativePath = pkgDir === normalizedRoot ? "." : pkgDir.replace(`${normalizedRoot}/`, "");
				importerToPackage.set(relativePath, name);
			}
		}

		return importerToPackage;
	});

/**
 * Compare two lockfile states to detect dependency changes.
 */
export const compareLockfiles = (
	before: LockfileObject | null,
	after: LockfileObject | null,
	workspaceRoot: string = process.cwd(),
): Effect.Effect<ReadonlyArray<LockfileChange>, LockfileError> =>
	Effect.gen(function* () {
		if (!before || !after) {
			yield* Effect.logWarning("Cannot compare lockfiles: one or both are null");
			return [];
		}

		// Log lockfile structure for debugging
		yield* logDebug("=== Lockfile Structure (Before) ===");
		yield* logDebugState("Before catalogs", Object.keys(before.catalogs ?? {}));
		yield* logDebugState("Before importers", Object.keys(before.importers ?? {}));
		yield* logDebugState("Before lockfile keys", Object.keys(before));

		yield* logDebug("=== Lockfile Structure (After) ===");
		yield* logDebugState("After catalogs", Object.keys(after.catalogs ?? {}));
		yield* logDebugState("After importers", Object.keys(after.importers ?? {}));

		// Build importer to package map first (needed for both catalog and importer comparison)
		const importerToPackage = yield* buildImporterToPackageMap(workspaceRoot);
		yield* logDebugState("Importer to package map", Object.fromEntries(importerToPackage));

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
			yield* logDebug(`Catalog changes detected: ${catalogChanges.length}`);
			for (const change of catalogChanges) {
				yield* logDebug(
					`  - ${change.dependency} in [${change.affectedPackages.join(", ")}]: ${change.from} -> ${change.to}`,
				);
			}
		}
		changes.push(...catalogChanges);

		// Compare package importers (regular dependencies - non-catalog specifier changes)
		const packageChanges = yield* compareImporters(before, after, importerToPackage);
		if (packageChanges.length > 0) {
			yield* logDebug(`Importer changes detected: ${packageChanges.length}`);
			for (const change of packageChanges) {
				yield* logDebug(
					`  - ${change.dependency} in ${change.affectedPackages.join(", ")}: ${change.from} -> ${change.to}`,
				);
			}
		}
		changes.push(...packageChanges);

		yield* Effect.logInfo(`Detected ${changes.length} dependency change(s)`);

		return changes;
	});

/**
 * Dependency snapshot from an importer (package).
 */
interface DependencySnapshot {
	specifier: string;
	version: string;
}

/**
 * Find packages that use a specific catalog entry.
 *
 * Scans all importers to find dependencies with `catalog:<catalogName>` specifier.
 */
const findPackagesUsingCatalog = (
	importers: LockfileObject["importers"],
	catalogName: string,
	dependencyName: string,
	importerToPackage: Map<string, string>,
): string[] => {
	const affectedPackages: string[] = [];
	const catalogSpecifier = catalogName === "default" ? "catalog:" : `catalog:${catalogName}`;

	for (const [importerId, snapshot] of Object.entries(importers ?? {})) {
		// Check all dependency types
		const depTypes = ["dependencies", "devDependencies", "optionalDependencies"] as const;

		for (const depType of depTypes) {
			const deps = snapshot[depType] as Record<string, DependencySnapshot> | undefined;
			if (!deps) continue;

			const dep = deps[dependencyName];
			if (dep?.specifier?.startsWith(catalogSpecifier)) {
				const packageName = importerToPackage.get(importerId) ?? importerId;
				if (!affectedPackages.includes(packageName)) {
					affectedPackages.push(packageName);
				}
			}
		}
	}

	return affectedPackages;
};

/**
 * Compare catalog snapshots to detect catalog version changes.
 *
 * NOTE: Catalogs (catalog:silk, etc.) are shared version definitions.
 * These are different from configDependencies in pnpm-workspace.yaml.
 *
 * Catalog changes affect packages that use those catalog references,
 * so they are treated as regular dependency changes with the affected
 * packages populated from the importers that use the catalog specifier.
 */
const compareCatalogs = (
	before: CatalogSnapshots,
	after: CatalogSnapshots,
	afterLockfile: LockfileObject,
	importerToPackage: Map<string, string>,
): Effect.Effect<ReadonlyArray<LockfileChange>, never> =>
	Effect.gen(function* () {
		const changes: LockfileChange[] = [];

		yield* logDebug("=== Comparing Catalogs ===");
		yield* logDebugState("Before catalogs", before);
		yield* logDebugState("After catalogs", after);

		// Check all catalogs in 'after' for changes/additions
		for (const [catalogName, afterEntries] of Object.entries(after)) {
			const beforeEntries = before[catalogName] ?? {};

			for (const [dep, afterEntry] of Object.entries(afterEntries as Record<string, { specifier: string }>)) {
				const beforeEntry = beforeEntries[dep] as { specifier: string } | undefined;
				const afterVersion = afterEntry.specifier;
				const beforeVersion = beforeEntry?.specifier ?? null;

				if (beforeVersion !== afterVersion) {
					const depName = catalogName === "default" ? dep : `${dep} (catalog:${catalogName})`;

					// Find which packages actually use this catalog entry
					const affectedPackages = findPackagesUsingCatalog(
						afterLockfile.importers,
						catalogName,
						dep,
						importerToPackage,
					);

					yield* logDebug(`Catalog change: ${depName}: ${beforeVersion} -> ${afterVersion}`);
					yield* logDebugState(`Affected packages for ${depName}`, affectedPackages);

					// Catalog changes are "regular" type - they affect the packages using them
					changes.push({
						type: "regular",
						dependency: dep, // Use raw dep name, not with catalog suffix
						from: beforeVersion,
						to: afterVersion,
						affectedPackages,
					});
				}
			}
		}

		// Check for removed catalogs/dependencies
		for (const [catalogName, beforeEntries] of Object.entries(before)) {
			const afterEntries = after[catalogName] ?? {};

			for (const dep of Object.keys(beforeEntries as Record<string, unknown>)) {
				if (!(dep in afterEntries)) {
					const beforeEntry = (beforeEntries as Record<string, { specifier: string }>)[dep];
					const depName = catalogName === "default" ? dep : `${dep} (catalog:${catalogName})`;

					// For removed entries, check the 'before' lockfile importers
					// But we only have 'after' - so these packages no longer use this catalog
					// Mark as affecting no packages (the catalog was removed)
					yield* logDebug(`Catalog removed: ${depName}`);

					changes.push({
						type: "regular",
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

		// Compare importers
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

			for (const [dep, afterVersion] of Object.entries(afterSpecifiers)) {
				const beforeVersion = beforeSpecifiers[dep];

				// Skip catalog specifiers - those are handled by compareCatalogs
				if (afterVersion.startsWith("catalog:")) continue;

				if (beforeVersion !== afterVersion) {
					changes.push({
						type: "regular",
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
					changes.push({
						type: "regular",
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
