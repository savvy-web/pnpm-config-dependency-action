/**
 * Lockfile service for capturing and comparing lockfile state.
 *
 * Package-manager agnostic: reads `pnpm-lock.yaml`, `bun.lock` or
 * `package-lock.json` and parses it through `@effected/lockfiles`'
 * `Lockfile.parse(content, { format })`, which normalizes all three into one
 * `Lockfile` model. `Lockfile.parse` is a pure parser (no memoized reader
 * service), so a "before" and an "after" snapshot can be parsed in the same
 * process.
 *
 * @module services/lockfile
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ImporterDependency, LockfileImporter } from "@effected/lockfiles";
import { Lockfile as LockfileModel } from "@effected/lockfiles";
import { WorkspaceDiscovery } from "@effected/workspaces";
import { Context, Effect, Layer } from "effect";
import { LockfileError } from "../errors/errors.js";
import type { LockfileChange } from "../schema/domain.js";
import type { SupportedPm } from "./package-manager.js";

// ══════════════════════════════════════════════════════════════════════════════
// Service Interface
// ══════════════════════════════════════════════════════════════════════════════

export class Lockfile extends Context.Service<
	Lockfile,
	{
		readonly capture: (pm: SupportedPm, workspaceRoot: string) => Effect.Effect<LockfileModel | null, LockfileError>;
		readonly compare: (
			before: LockfileModel | null,
			after: LockfileModel | null,
			workspaceRoot: string,
		) => Effect.Effect<ReadonlyArray<LockfileChange>, LockfileError, WorkspaceDiscovery>;
	}
>()("Lockfile") {
	/**
	 * Live layer.
	 *
	 * Declared IN the class body, which is load-bearing rather than stylistic: a
	 * member attached by post-class assignment is tree-shaken out of the bundled
	 * `dist`, and that fails only in production because vitest runs the source.
	 */
	static readonly layer = Layer.succeed(this, {
		capture: (pm, workspaceRoot) => captureLockfileStateImpl(pm, workspaceRoot),
		compare: (before, after, workspaceRoot) => compareLockfilesImpl(before, after, workspaceRoot),
	});
}

// ══════════════════════════════════════════════════════════════════════════════
// Standalone Function Exports
// ══════════════════════════════════════════════════════════════════════════════

/**
 * The lockfile each supported package manager writes.
 */
export const LOCKFILE_NAMES: Record<SupportedPm, string> = {
	pnpm: "pnpm-lock.yaml",
	bun: "bun.lock",
	npm: "package-lock.json",
};

/**
 * Capture current lockfile state for the detected package manager.
 *
 * Returns `null` when the package manager's lockfile does not exist — a repo
 * that has never installed still runs, it just has nothing to diff against.
 */
export const captureLockfileState = (
	pm: SupportedPm,
	workspaceRoot: string,
): Effect.Effect<LockfileModel | null, LockfileError> => captureLockfileStateImpl(pm, workspaceRoot);

/**
 * Compare two lockfile states to detect dependency changes.
 */
export const compareLockfiles = (
	before: LockfileModel | null,
	after: LockfileModel | null,
	workspaceRoot: string,
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
const captureLockfileStateImpl = (
	pm: SupportedPm,
	workspaceRoot: string,
): Effect.Effect<LockfileModel | null, LockfileError> =>
	Effect.gen(function* () {
		const lockfilePath = join(workspaceRoot, LOCKFILE_NAMES[pm]);

		const content = yield* Effect.try({
			try: () => (existsSync(lockfilePath) ? readFileSync(lockfilePath, "utf8") : null),
			catch: (e) => new LockfileError({ operation: "read", reason: String(e) }),
		});

		if (content === null) {
			yield* Effect.logDebug(`No lockfile found at ${lockfilePath}`);
			return null;
		}

		// A parse failure (malformed content, or content the upstream parser's
		// strict raw schema does not recognize) degrades to a warning and `null`,
		// same as the old `readWantedLockfile(root, { ignoreIncompatible: true })`
		// baseline — change detection still has `git status --porcelain` to fall
		// back on, so a lockfile the parser cannot handle must not abort the run.
		// This is deliberately narrower than the "read" failure above: a read/IO
		// error (e.g. EACCES, a directory where the lockfile should be) signals a
		// real environment problem unrelated to lockfile content and must still
		// fail the effect rather than being silently swallowed.
		return yield* LockfileModel.parse(content, { format: pm }).pipe(
			Effect.catch((e) =>
				Effect.logWarning(
					`Failed to parse ${lockfilePath}: ${e.message}. Lockfile-derived change detection is being skipped for this run (git status still drives change detection).`,
				).pipe(Effect.as(null)),
			),
		);
	});

/**
 * Map a lockfile dep section onto the LockfileChange type discriminator.
 */
const DEP_TYPE: Record<ImporterDependency["depType"], LockfileChange["type"]> = {
	dependencies: "dependency",
	devDependencies: "devDependency",
	optionalDependencies: "optionalDependency",
	peerDependencies: "peerDependency",
};

/**
 * A catalog entry normalized across package managers.
 *
 * `version` is `null` when the lockfile does not record a resolved version for
 * the catalog entry and it cannot be recovered unambiguously from the package
 * list (bun and npm record resolved versions on package tuples/entries, never
 * on the catalog itself).
 */
interface CatalogEntry {
	readonly specifier: string;
	readonly version: string | null;
}

/**
 * Narrow a raw catalog entry (typed `unknown` upstream, since
 * `BunExtension.catalog`/`.catalogs` are `Record<string, unknown>`) to the
 * `{ specifier, version? }` object shape pnpm records per catalog entry.
 *
 * A value that is neither a string (handled separately) nor this shape is
 * not a recognized catalog entry and must be skipped by the caller rather
 * than cast — an unchecked cast would report `specifier: undefined` while
 * the type claims `string`, feeding a lie into `LockfileChange.from`/`to`.
 */
const isCatalogEntryShape = (raw: unknown): raw is { specifier: string; version?: string | null } =>
	typeof raw === "object" &&
	raw !== null &&
	"specifier" in raw &&
	typeof (raw as { specifier: unknown }).specifier === "string";

/**
 * Index every non-workspace package by name to its resolved version.
 *
 * A name resolved to more than one version is recorded as `null` rather than
 * being guessed at — bun and npm do not record a per-importer version, so this
 * join is the only way to recover one, and an ambiguous join must not fabricate.
 */
const buildResolvedVersions = (data: LockfileModel): Map<string, string | null> => {
	const versions = new Map<string, string | null>();
	for (const pkg of data.packages) {
		if (pkg.isWorkspace) continue;
		if (!versions.has(pkg.name)) {
			versions.set(pkg.name, pkg.version);
			continue;
		}
		if (versions.get(pkg.name) !== pkg.version) {
			versions.set(pkg.name, null);
		}
	}
	return versions;
};

/**
 * Read the raw catalog definitions out of a lockfile's PM-specific extension.
 *
 * pnpm keys its default catalog as `"default"` already. bun splits the default
 * catalog (`catalog`) from the named ones (`catalogs`), so the default is folded
 * back under the `"default"` key here. npm has no `pmSpecific` and no catalog
 * protocol at all, so it yields nothing — which is correct, not a gap.
 */
const rawCatalogs = (data: LockfileModel): Record<string, Record<string, unknown>> => {
	const ext = data.extension;
	if (ext?._tag === "pnpm") {
		return ext.catalogs ?? {};
	}
	if (ext?._tag === "bun") {
		return {
			...(ext.catalog ? { default: ext.catalog } : {}),
			...(ext.catalogs ?? {}),
		};
	}
	return {};
};

/**
 * Normalize the catalogs of a lockfile into `catalog -> dep -> entry`.
 *
 * pnpm records `{ specifier, version }` per catalog entry; bun records the bare
 * specifier string, so the resolved version is joined in by name through the
 * lockfile's package list.
 */
const normalizeCatalogs = (data: LockfileModel): Map<string, Map<string, CatalogEntry>> => {
	const resolved = buildResolvedVersions(data);
	const out = new Map<string, Map<string, CatalogEntry>>();

	for (const [catalogName, entries] of Object.entries(rawCatalogs(data))) {
		const normalized = new Map<string, CatalogEntry>();
		for (const [dep, raw] of Object.entries(entries)) {
			if (typeof raw === "string") {
				normalized.set(dep, { specifier: raw, version: resolved.get(dep) ?? null });
				continue;
			}
			if (isCatalogEntryShape(raw)) {
				normalized.set(dep, { specifier: raw.specifier, version: raw.version ?? null });
			}
			// Else: neither a bare specifier string nor a { specifier } object.
			// Skipped rather than cast into a lie.
		}
		out.set(catalogName, normalized);
	}

	return out;
};

/**
 * Does an importer specifier reference this catalog?
 *
 * The default catalog is referenced as the bare `catalog:` (and, in bun, may
 * also be spelled `catalog:default`).
 */
const referencesCatalog = (specifier: string, catalogName: string): boolean =>
	catalogName === "default"
		? specifier === "catalog:" || specifier === "catalog:default"
		: specifier === `catalog:${catalogName}`;

/**
 * Build a map from importer path (relative to workspace root, "." for root)
 * to package name, via WorkspaceDiscovery.
 *
 * Importer "." resolves to the root's actual name rather than falling
 * through to the bare importer id.
 */
const buildImporterToPackageMap = (
	_workspaceRoot: string,
): Effect.Effect<Map<string, string>, LockfileError, WorkspaceDiscovery> =>
	Effect.gen(function* () {
		const discovery = yield* WorkspaceDiscovery;
		const importerMap = yield* discovery.importerMap().pipe(
			Effect.catch((e) =>
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
	before: LockfileModel | null,
	after: LockfileModel | null,
	workspaceRoot: string,
): Effect.Effect<ReadonlyArray<LockfileChange>, LockfileError, WorkspaceDiscovery> =>
	Effect.gen(function* () {
		if (!before || !after) {
			yield* Effect.logWarning("Cannot compare lockfiles: one or both are null");
			return [];
		}

		yield* Effect.logDebug(
			`Comparing ${after.format} lockfiles: ${before.importers.length} -> ${after.importers.length} importer(s)`,
		);

		// Needed by both the catalog and the importer comparison.
		const importerToPackage = yield* buildImporterToPackageMap(workspaceRoot);
		yield* Effect.logDebug(`Importer to package map: ${JSON.stringify(Object.fromEntries(importerToPackage))}`);

		const changes: LockfileChange[] = [];

		// Catalogs are shared version definitions (catalog:silk, etc). They are NOT
		// the same as pnpm's configDependencies.
		const catalogChanges = yield* compareCatalogs(before, after, importerToPackage);
		changes.push(...catalogChanges);

		// Non-catalog specifier changes, per importer.
		const packageChanges = yield* compareImporters(before, after, importerToPackage);
		changes.push(...packageChanges);

		yield* Effect.logInfo(`Detected ${changes.length} dependency change(s)`);

		return changes;
	});

/**
 * Find each (importer, dep section) pair that consumes a catalog entry.
 *
 * Returns one record per consumer per dep section, so callers can emit a
 * LockfileChange with the precise type field. Catalog refs in devDependencies
 * are returned with type "devDependency" — downstream Changesets gating treats
 * those as informational only.
 */
const findCatalogConsumers = (
	importers: ReadonlyArray<LockfileImporter>,
	catalogName: string,
	dependencyName: string,
	importerToPackage: Map<string, string>,
): ReadonlyArray<{ readonly packageName: string; readonly type: LockfileChange["type"] }> => {
	const consumers: Array<{ readonly packageName: string; readonly type: LockfileChange["type"] }> = [];

	for (const importer of importers) {
		for (const dep of importer.dependencies) {
			if (dep.name !== dependencyName) continue;
			if (!referencesCatalog(dep.specifier.raw, catalogName)) continue;
			consumers.push({
				packageName: importerToPackage.get(importer.path) ?? importer.path,
				type: DEP_TYPE[dep.depType],
			});
		}
	}

	return consumers;
};

/**
 * Compare catalog definitions to detect catalog version changes.
 *
 * Emits one LockfileChange per (catalog change, consuming importer, dep section)
 * triple. Each record carries the accurate type field (dependency, devDependency,
 * optionalDependency, peerDependency) so downstream consumers can use type alone
 * as the trigger signal.
 */
const compareCatalogs = (
	before: LockfileModel,
	after: LockfileModel,
	importerToPackage: Map<string, string>,
): Effect.Effect<ReadonlyArray<LockfileChange>, never> =>
	Effect.gen(function* () {
		const changes: LockfileChange[] = [];
		const beforeCatalogs = normalizeCatalogs(before);
		const afterCatalogs = normalizeCatalogs(after);

		for (const [catalogName, afterEntries] of afterCatalogs) {
			const beforeEntries = beforeCatalogs.get(catalogName);

			for (const [dep, afterEntry] of afterEntries) {
				const beforeEntry = beforeEntries?.get(dep);
				const beforeSpecifier = beforeEntry?.specifier ?? null;
				const beforeVersion = beforeEntry?.version ?? null;

				// A specifier change is reported as the specifier move; otherwise fall
				// back to resolved-version movement under an unchanged specifier.
				const specifierChanged = beforeSpecifier !== afterEntry.specifier;
				const versionChanged = beforeVersion !== afterEntry.version && afterEntry.version !== null;
				if (!specifierChanged && !versionChanged) continue;

				const from = specifierChanged ? beforeSpecifier : beforeVersion;
				const to = specifierChanged ? afterEntry.specifier : (afterEntry.version as string);

				const consumers = findCatalogConsumers(after.importers, catalogName, dep, importerToPackage);
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

		// Catalog entries that disappeared entirely.
		//
		// A removal is attributed exactly like a bump: one record per consuming
		// importer, carrying that consumer's dep-section type. The consumers are
		// read from the BEFORE importers — a removed catalog entry is, by
		// definition, no longer referenced in the after state, so looking there
		// would find nobody and silently drop every consumer from the change map.
		// Only when the entry had no consumer at all does the single unassigned
		// record stand in for it.
		for (const [catalogName, beforeEntries] of beforeCatalogs) {
			const afterEntries = afterCatalogs.get(catalogName);
			for (const [dep, beforeEntry] of beforeEntries) {
				if (afterEntries?.has(dep)) continue;

				const consumers = findCatalogConsumers(before.importers, catalogName, dep, importerToPackage);
				yield* Effect.logDebug(`Catalog removed: ${dep} (${catalogName}); ${consumers.length} consumer(s)`);

				if (consumers.length === 0) {
					changes.push({
						type: "dependency",
						dependency: dep,
						from: beforeEntry.specifier,
						to: "(removed)",
						affectedPackages: [],
					});
					continue;
				}

				for (const consumer of consumers) {
					changes.push({
						type: consumer.type,
						dependency: dep,
						from: beforeEntry.specifier,
						to: "(removed)",
						affectedPackages: [consumer.packageName],
					});
				}
			}
		}

		return changes;
	});

/**
 * Key an importer dependency by (name, section), so a dep declared in more than
 * one section of the same package is compared section by section.
 */
const depKey = (dep: ImporterDependency): string => `${dep.name}\0${dep.depType}`;

const keyDependencies = (importer: LockfileImporter): Map<string, ImporterDependency> => {
	const out = new Map<string, ImporterDependency>();
	for (const dep of importer.dependencies) {
		out.set(depKey(dep), dep);
	}
	return out;
};

/**
 * Compare importers to detect which packages have changed dependencies.
 *
 * Only non-catalog specifiers are compared here — a catalog specifier does not
 * itself change when the catalog is bumped, so compareCatalogs owns those.
 *
 * Specifiers, not resolved versions, are what is compared: `ImporterDependency.version`
 * is populated by pnpm only (bun and npm record the resolved version on their
 * package tuples/entries), and a specifier diff is the one signal every package
 * manager records per importer.
 */
const compareImporters = (
	before: LockfileModel,
	after: LockfileModel,
	importerToPackage: Map<string, string>,
): Effect.Effect<ReadonlyArray<LockfileChange>, never> =>
	Effect.sync(() => {
		const changes: LockfileChange[] = [];
		const beforeImporters = new Map(before.importers.map((importer) => [importer.path, importer]));

		for (const afterImporter of after.importers) {
			const beforeImporter = beforeImporters.get(afterImporter.path);
			if (!beforeImporter) continue;

			const packageName = importerToPackage.get(afterImporter.path) ?? afterImporter.path;
			const beforeDeps = keyDependencies(beforeImporter);
			const afterDeps = keyDependencies(afterImporter);

			for (const [key, dep] of afterDeps) {
				// Catalog refs are handled by compareCatalogs.
				if (dep.specifier.raw.startsWith("catalog:")) continue;

				const previous = beforeDeps.get(key);
				if (previous?.specifier.raw === dep.specifier.raw) continue;

				changes.push({
					type: DEP_TYPE[dep.depType],
					dependency: dep.name,
					from: previous?.specifier.raw ?? null,
					to: dep.specifier.raw,
					affectedPackages: [packageName],
				});
			}

			for (const [key, dep] of beforeDeps) {
				if (afterDeps.has(key)) continue;
				changes.push({
					type: DEP_TYPE[dep.depType],
					dependency: dep.name,
					from: dep.specifier.raw,
					to: "(removed)",
					affectedPackages: [packageName],
				});
			}
		}

		return changes;
	});
