/**
 * Regular dependency updates via direct npm queries.
 *
 * Instead of using `pnpm up --latest` (which can promote deps to catalogs
 * when `catalogMode: strict` is enabled), this module queries npm directly
 * for latest versions and updates package.json specifiers in place.
 *
 * @module pnpm/regular
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { Effect } from "effect";
import { getPackageInfosAsync } from "workspace-tools";

import type { DependencyUpdateResult } from "../../types/index.js";
import { FileSystemError } from "../errors/types.js";
import { PnpmExecutor } from "../services/index.js";
import { detectIndent } from "./upgrade.js";

// ══════════════════════════════════════════════════════════════════════════════
// Pure Helpers (exported for testing)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a dependency name matches a glob pattern.
 *
 * Uses Node's native `path.matchesGlob` for safe pattern matching
 * without regex metacharacter injection issues.
 *
 * - Exact match: `effect` matches `effect`
 * - Scoped wildcard: `@savvy-web/*` matches `@savvy-web/changesets`
 * - Bare wildcard: `*` matches anything
 */
export const matchesPattern = (depName: string, pattern: string): boolean => {
	return matchesGlob(depName, pattern);
};

/**
 * Parse a version specifier into prefix and version.
 *
 * Returns null for catalog: and workspace: specifiers (should be skipped).
 */
export const parseSpecifier = (specifier: string): { prefix: string; version: string } | null => {
	if (specifier.startsWith("catalog:")) return null;
	if (specifier.startsWith("workspace:")) return null;

	// Match optional prefix (^ or ~) followed by a semver-like version
	const match = specifier.match(/^(\^|~)?(\d+\.\d+\.\d+.*)$/);
	if (!match) return null;

	return {
		prefix: match[1] ?? "",
		version: match[2],
	};
};

// ══════════════════════════════════════════════════════════════════════════════
// Internal Helpers
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Query npm for the latest published version of a package.
 */
const queryLatestVersion = (packageName: string): Effect.Effect<string | null, never, PnpmExecutor> =>
	Effect.gen(function* () {
		const pnpm = yield* PnpmExecutor;

		const output = yield* pnpm
			.run(`npm view ${packageName} dist-tags.latest --json`)
			.pipe(Effect.catchAll(() => Effect.succeed(null)));

		if (output === null) return null;

		try {
			// npm view --json for dist-tags.latest returns a quoted string like "1.2.3"
			const parsed = JSON.parse(output);
			if (typeof parsed === "string") return parsed;
			return null;
		} catch {
			return null;
		}
	});

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
		const depFields = ["dependencies", "devDependencies", "optionalDependencies"] as const;

		for (const pkgPath of packageJsonPaths) {
			const raw = yield* Effect.try({
				try: () => readFileSync(pkgPath, "utf-8"),
				catch: (e) => new FileSystemError({ operation: "read", path: pkgPath, reason: String(e) }),
			});

			const pkg = yield* Effect.try({
				try: () => JSON.parse(raw) as PackageJsonDeps,
				catch: (e) => new FileSystemError({ operation: "read", path: pkgPath, reason: `Invalid JSON: ${e}` }),
			});

			for (const field of depFields) {
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

		const depFields = ["dependencies", "devDependencies", "optionalDependencies"] as const;
		let changed = false;

		for (const field of depFields) {
			const deps = pkg[field];
			if (!deps) continue;

			for (const [name, newSpecifier] of updates) {
				if (name in deps) {
					const current = deps[name];
					// Only update if the dep exists and is not a catalog/workspace specifier
					if (current && !current.startsWith("catalog:") && !current.startsWith("workspace:")) {
						if (current !== newSpecifier) {
							deps[name] = newSpecifier;
							changed = true;
						}
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
// Main Export
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Update regular dependencies by querying npm for latest versions and
 * updating package.json specifiers directly.
 *
 * This avoids `pnpm up --latest` which can promote deps to catalogs
 * when `catalogMode: strict` is enabled.
 */
export const updateRegularDeps = (
	patterns: ReadonlyArray<string>,
	workspaceRoot: string = process.cwd(),
): Effect.Effect<ReadonlyArray<DependencyUpdateResult>, never, PnpmExecutor> =>
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

		// Step 3: Query npm for latest versions and compute updates
		const results: DependencyUpdateResult[] = [];
		// Track updates per package.json path
		const fileUpdates = new Map<string, Map<string, string>>();

		for (const [depName, entries] of depMap) {
			const latest = yield* queryLatestVersion(depName);

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
				const pkgName =
					Object.entries(packageInfos).find(([, info]) => info.packageJsonPath === entry.path)?.[0] ??
					(entry.path === rootPkgJson ? "(root)" : entry.path);

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
