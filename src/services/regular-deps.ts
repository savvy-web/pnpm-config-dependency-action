/**
 * RegularDeps service for updating regular (non-config) dependencies.
 *
 * Instead of using `pnpm up --latest` (which can promote deps to catalogs
 * when `catalogMode: strict` is enabled), this service queries npm directly
 * for latest versions and updates package.json specifiers in place.
 *
 * @module services/regular-deps
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NpmRegistry } from "@savvy-web/github-action-effects";
import { Context, Effect, Layer } from "effect";
import { WorkspaceDiscovery } from "workspaces-effect";

import { FileSystemError } from "../errors/errors.js";
import type { DependencyUpdateResult } from "../schemas/domain.js";
import { matchesPattern, parseSpecifier } from "../utils/deps.js";
import { detectIndent } from "../utils/pnpm.js";

type NpmRegistryShape = Context.Tag.Service<typeof NpmRegistry>;
type WorkspaceDiscoveryShape = Context.Tag.Service<typeof WorkspaceDiscovery>;

// ══════════════════════════════════════════════════════════════════════════════
// Service Interface
// ══════════════════════════════════════════════════════════════════════════════

export class RegularDeps extends Context.Tag("RegularDeps")<
	RegularDeps,
	{
		readonly updateRegularDeps: (
			patterns: ReadonlyArray<string>,
			workspaceRoot?: string,
		) => Effect.Effect<ReadonlyArray<DependencyUpdateResult>>;
	}
>() {}

export const RegularDepsLive = Layer.effect(
	RegularDeps,
	Effect.gen(function* () {
		const registry = yield* NpmRegistry;
		const discovery = yield* WorkspaceDiscovery;
		return {
			updateRegularDeps: (patterns, workspaceRoot = process.cwd()) =>
				updateRegularDepsImpl(patterns, registry, discovery, workspaceRoot),
		};
	}),
);

// ══════════════════════════════════════════════════════════════════════════════
// Internal Helpers
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Query npm for the latest published version of a package.
 */
const queryLatestVersion = (packageName: string, registry: NpmRegistryShape): Effect.Effect<string | null> =>
	Effect.gen(function* () {
		const version = yield* registry
			.getLatestVersion(packageName)
			.pipe(Effect.catchAll(() => Effect.succeed(null as string | null)));
		return version;
	});

/**
 * Writable dependency sections, in priority order. peerDependencies are
 * intentionally excluded — peer ranges are managed by syncPeers, not by
 * direct version bumps.
 */
const DEP_SECTIONS = [
	{ field: "dependencies", type: "dependency" },
	{ field: "devDependencies", type: "devDependency" },
	{ field: "optionalDependencies", type: "optionalDependency" },
] as const;

type DepSectionField = (typeof DEP_SECTIONS)[number]["field"];
type DepSectionType = (typeof DEP_SECTIONS)[number]["type"];

interface PackageJsonDeps {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	[key: string]: unknown;
}

interface MatchedDep {
	readonly path: string;
	readonly field: DepSectionField;
	readonly type: DepSectionType;
	readonly currentSpecifier: string;
}

/**
 * Collect all dependencies matching patterns across all workspace package.json
 * files. Emits one record per (path, dep, section) — a dep that appears in
 * both `dependencies` and `devDependencies` of the same package yields two
 * records so each section can be updated and reported with its real type.
 */
const collectMatchingDeps = (
	packageJsonPaths: ReadonlyArray<string>,
	patterns: ReadonlyArray<string>,
): Effect.Effect<Map<string, MatchedDep[]>, FileSystemError> =>
	Effect.gen(function* () {
		const depMap = new Map<string, MatchedDep[]>();

		for (const pkgPath of packageJsonPaths) {
			const raw = yield* Effect.try({
				try: () => readFileSync(pkgPath, "utf-8"),
				catch: (e) => new FileSystemError({ operation: "read", path: pkgPath, reason: String(e) }),
			});

			const pkg = yield* Effect.try({
				try: () => JSON.parse(raw) as PackageJsonDeps,
				catch: (e) => new FileSystemError({ operation: "read", path: pkgPath, reason: `Invalid JSON: ${e}` }),
			});

			for (const { field, type } of DEP_SECTIONS) {
				const deps = pkg[field];
				if (!deps) continue;

				for (const [name, specifier] of Object.entries(deps)) {
					if (!patterns.some((p) => matchesPattern(name, p))) continue;

					// Skip catalog: and workspace: specifiers
					if (!parseSpecifier(specifier)) continue;

					const entries = depMap.get(name) ?? [];
					// Deduplicate by (path, field) — a dep should never appear twice in
					// the same section, but guard against pathological package.json.
					if (entries.some((e) => e.path === pkgPath && e.field === field)) continue;
					entries.push({ path: pkgPath, field, type, currentSpecifier: specifier });
					depMap.set(name, entries);
				}
			}
		}

		return depMap;
	});

/**
 * Update a single package.json file. `updates` is keyed by (field, depName)
 * so a dep present in both `dependencies` and `devDependencies` updates
 * each independently if both are tracked.
 */
const updatePackageJson = (
	pkgPath: string,
	updates: Map<DepSectionField, Map<string, string>>,
): Effect.Effect<void, FileSystemError> =>
	Effect.gen(function* () {
		const raw = yield* Effect.try({
			try: () => readFileSync(pkgPath, "utf-8"),
			catch: (e) => new FileSystemError({ operation: "read", path: pkgPath, reason: String(e) }),
		});

		const indent = detectIndent(raw);
		const pkg = yield* Effect.try({
			try: () => JSON.parse(raw) as PackageJsonDeps,
			catch: (e) => new FileSystemError({ operation: "read", path: pkgPath, reason: `Invalid JSON: ${e}` }),
		});

		let changed = false;

		for (const { field } of DEP_SECTIONS) {
			const deps = pkg[field];
			const fieldUpdates = updates.get(field);
			if (!deps || !fieldUpdates) continue;

			for (const [name, newSpecifier] of fieldUpdates) {
				const current = deps[name];
				if (current && parseSpecifier(current) && current !== newSpecifier) {
					deps[name] = newSpecifier;
					changed = true;
				}
			}
		}

		if (changed) {
			yield* Effect.try({
				try: () => writeFileSync(pkgPath, `${JSON.stringify(pkg, null, indent)}\n`, "utf-8"),
				catch: (e) => new FileSystemError({ operation: "write", path: pkgPath, reason: String(e) }),
			});
		}
	});

// ══════════════════════════════════════════════════════════════════════════════
// Implementation
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Update regular dependencies by querying npm for latest versions and
 * updating package.json specifiers directly.
 */
const updateRegularDepsImpl = (
	patterns: ReadonlyArray<string>,
	registry: NpmRegistryShape,
	discovery: WorkspaceDiscoveryShape,
	workspaceRoot: string,
): Effect.Effect<ReadonlyArray<DependencyUpdateResult>> =>
	Effect.gen(function* () {
		if (patterns.length === 0) return [];

		// Step 1: Find all workspace package.json paths via WorkspaceDiscovery
		const packages = yield* discovery.listPackages(workspaceRoot).pipe(
			Effect.catchAll((error) =>
				Effect.gen(function* () {
					yield* Effect.logWarning(`Failed to list workspace packages: ${String(error)}`);
					return [] as ReadonlyArray<{ readonly name: string; readonly path: string }>;
				}),
			),
		);

		const packageJsonPaths = packages.map((pkg) => join(pkg.path, "package.json"));

		const pathToPackageName = new Map<string, string>(
			packages.map((pkg) => [join(pkg.path, "package.json"), pkg.name]),
		);

		// Step 2: Find all deps matching patterns across all package.json files
		const depMap = yield* collectMatchingDeps(packageJsonPaths, patterns).pipe(
			Effect.catchAll((error) =>
				Effect.gen(function* () {
					yield* Effect.logWarning(`Failed to collect matching deps: ${error.reason}`);
					return new Map<string, MatchedDep[]>();
				}),
			),
		);

		if (depMap.size === 0) {
			yield* Effect.logInfo("No matching dependencies found");
			return [];
		}

		yield* Effect.logInfo(`Found ${depMap.size} unique dependencies matching patterns`);

		// Step 3: Query npm for latest versions and compute updates.
		const results: DependencyUpdateResult[] = [];
		// Track updates per (package.json path, dep section). A dep present in
		// both dependencies and devDependencies of the same package needs
		// independent tracking so the writer updates the right field.
		const fileUpdates = new Map<string, Map<DepSectionField, Map<string, string>>>();

		for (const [depName, entries] of depMap) {
			const latest = yield* queryLatestVersion(depName, registry);

			if (!latest) {
				yield* Effect.logWarning(`Could not query latest version for ${depName}`);
				continue;
			}

			for (const entry of entries) {
				const parsed = parseSpecifier(entry.currentSpecifier);
				if (!parsed) continue;

				if (parsed.version === latest) continue;

				const newSpecifier = `${parsed.prefix}${latest}`;

				const sections = fileUpdates.get(entry.path) ?? new Map<DepSectionField, Map<string, string>>();
				const fieldUpdates = sections.get(entry.field) ?? new Map<string, string>();
				fieldUpdates.set(depName, newSpecifier);
				sections.set(entry.field, fieldUpdates);
				fileUpdates.set(entry.path, sections);

				const pkgName = pathToPackageName.get(entry.path) ?? entry.path;

				results.push({
					dependency: depName,
					from: entry.currentSpecifier,
					to: newSpecifier,
					type: entry.type,
					package: pkgName,
				});
			}
		}

		// Step 4: Apply updates to package.json files.
		for (const [pkgPath, sections] of fileUpdates) {
			const total = [...sections.values()].reduce((sum, m) => sum + m.size, 0);
			yield* updatePackageJson(pkgPath, sections).pipe(
				Effect.tap(() => Effect.logInfo(`Updated ${total} dependencies in ${pkgPath}`)),
				Effect.catchAll((error) => Effect.logWarning(`Failed to update ${pkgPath}: ${error.reason}`)),
			);
		}

		return results;
	});
