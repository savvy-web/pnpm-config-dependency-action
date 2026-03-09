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
import type { NpmRegistry as NpmRegistryService } from "@savvy-web/github-action-effects";
import { NpmRegistry } from "@savvy-web/github-action-effects";
import { Context, Effect, Layer } from "effect";
import { getPackageInfosAsync } from "workspace-tools";

import { FileSystemError } from "../errors/errors.js";
import type { DependencyUpdateResult } from "../schemas/domain.js";
import { matchesPattern, parseSpecifier } from "../utils/deps.js";
import { detectIndent } from "../utils/pnpm.js";

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
		return {
			updateRegularDeps: (patterns, workspaceRoot = process.cwd()) =>
				updateRegularDepsImpl(patterns, registry, workspaceRoot),
		};
	}),
);

// ══════════════════════════════════════════════════════════════════════════════
// Internal Helpers
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Query npm for the latest published version of a package.
 */
const queryLatestVersion = (packageName: string, registry: NpmRegistryService): Effect.Effect<string | null> =>
	Effect.gen(function* () {
		const version = yield* registry
			.getLatestVersion(packageName)
			.pipe(Effect.catchAll(() => Effect.succeed(null as string | null)));
		return version;
	});

const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

interface PackageJsonDeps {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	[key: string]: unknown;
}

/**
 * Collect all dependencies matching patterns across all workspace package.json files.
 */
const collectMatchingDeps = (
	packageJsonPaths: ReadonlyArray<string>,
	patterns: ReadonlyArray<string>,
): Effect.Effect<Map<string, Array<{ path: string; currentSpecifier: string }>>, FileSystemError> =>
	Effect.gen(function* () {
		const depMap = new Map<string, Array<{ path: string; currentSpecifier: string }>>();

		for (const pkgPath of packageJsonPaths) {
			const raw = yield* Effect.try({
				try: () => readFileSync(pkgPath, "utf-8"),
				catch: (e) => new FileSystemError({ operation: "read", path: pkgPath, reason: String(e) }),
			});

			const pkg = yield* Effect.try({
				try: () => JSON.parse(raw) as PackageJsonDeps,
				catch: (e) => new FileSystemError({ operation: "read", path: pkgPath, reason: `Invalid JSON: ${e}` }),
			});

			for (const field of DEP_FIELDS) {
				const deps = pkg[field];
				if (!deps) continue;

				for (const [name, specifier] of Object.entries(deps)) {
					// Check if name matches any pattern
					const matches = patterns.some((p) => matchesPattern(name, p));
					if (!matches) continue;

					// Skip catalog: and workspace: specifiers
					const parsed = parseSpecifier(specifier);
					if (!parsed) continue;

					// Deduplicate: skip if this path+dep already tracked
					// (same dep can appear in dependencies AND devDependencies)
					const entries = depMap.get(name) ?? [];
					if (entries.some((e) => e.path === pkgPath)) continue;
					entries.push({ path: pkgPath, currentSpecifier: specifier });
					depMap.set(name, entries);
				}
			}
		}

		return depMap;
	});

/**
 * Update a single package.json file with new version specifiers.
 */
const updatePackageJson = (pkgPath: string, updates: Map<string, string>): Effect.Effect<void, FileSystemError> =>
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

		for (const field of DEP_FIELDS) {
			const deps = pkg[field];
			if (!deps) continue;

			for (const [name, newSpecifier] of updates) {
				if (name in deps) {
					const current = deps[name];
					// Only update if the dep exists and is a parseable specifier (not catalog:/workspace:)
					if (current && parseSpecifier(current) && current !== newSpecifier) {
						deps[name] = newSpecifier;
						changed = true;
					}
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
	registry: NpmRegistryService,
	workspaceRoot: string,
): Effect.Effect<ReadonlyArray<DependencyUpdateResult>> =>
	Effect.gen(function* () {
		if (patterns.length === 0) return [];

		// Step 1: Find all workspace package.json paths
		const packageInfos = yield* Effect.tryPromise({
			try: () => getPackageInfosAsync(workspaceRoot),
			catch: (e) =>
				new FileSystemError({
					operation: "read",
					path: workspaceRoot,
					reason: `Failed to get workspace info: ${e}`,
				}),
		}).pipe(
			Effect.catchAll((error) =>
				Effect.gen(function* () {
					yield* Effect.logWarning(`Failed to get workspace info: ${error.reason}`);
					return {};
				}),
			),
		);

		// Collect all package.json paths (workspace packages + root)
		const rootPkgJson = join(workspaceRoot, "package.json");
		const packageJsonPaths = [rootPkgJson, ...Object.values(packageInfos).map((info) => info.packageJsonPath)];

		// Step 2: Find all deps matching patterns across all package.json files
		const depMap = yield* collectMatchingDeps(packageJsonPaths, patterns).pipe(
			Effect.catchAll((error) =>
				Effect.gen(function* () {
					yield* Effect.logWarning(`Failed to collect matching deps: ${error.reason}`);
					return new Map<string, Array<{ path: string; currentSpecifier: string }>>();
				}),
			),
		);

		if (depMap.size === 0) {
			yield* Effect.logInfo("No matching dependencies found");
			return [];
		}

		yield* Effect.logInfo(`Found ${depMap.size} unique dependencies matching patterns`);

		// Build inverse map for O(1) path-to-name lookup
		const pathToPackageName = new Map<string, string>(
			Object.entries(packageInfos).map(([name, info]) => [info.packageJsonPath, name]),
		);
		pathToPackageName.set(rootPkgJson, "(root)");

		// Step 3: Query npm for latest versions and compute updates
		const results: DependencyUpdateResult[] = [];
		// Track updates per package.json path
		const fileUpdates = new Map<string, Map<string, string>>();

		for (const [depName, entries] of depMap) {
			const latest = yield* queryLatestVersion(depName, registry);

			if (!latest) {
				yield* Effect.logWarning(`Could not query latest version for ${depName}`);
				continue;
			}

			// Group by unique specifier to avoid redundant comparisons
			for (const entry of entries) {
				const parsed = parseSpecifier(entry.currentSpecifier);
				if (!parsed) continue;

				// Compare current version with latest
				if (parsed.version === latest) continue;

				const newSpecifier = `${parsed.prefix}${latest}`;

				// Track file update
				const updates = fileUpdates.get(entry.path) ?? new Map<string, string>();
				updates.set(depName, newSpecifier);
				fileUpdates.set(entry.path, updates);

				// Derive package name from path
				const pkgName = pathToPackageName.get(entry.path) ?? entry.path;

				results.push({
					dependency: depName,
					from: entry.currentSpecifier,
					to: newSpecifier,
					type: "regular",
					package: pkgName,
				});
			}
		}

		// Step 4: Apply updates to package.json files
		for (const [pkgPath, updates] of fileUpdates) {
			yield* updatePackageJson(pkgPath, updates).pipe(
				Effect.tap(() => Effect.logInfo(`Updated ${updates.size} dependencies in ${pkgPath}`)),
				Effect.catchAll((error) => Effect.logWarning(`Failed to update ${pkgPath}: ${error.reason}`)),
			);
		}

		return results;
	});
