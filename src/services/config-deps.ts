/**
 * ConfigDeps service for updating pnpm config dependencies.
 *
 * Instead of using `pnpm add --config` (which promotes all workspace
 * dependencies to the default catalog when `catalogMode: strict` is enabled),
 * this service queries npm directly for latest versions and edits
 * `pnpm-workspace.yaml` in place.
 *
 * @module services/config-deps
 */

import { existsSync, writeFileSync } from "node:fs";
import type { NpmRegistryShape, PublishedVersion } from "@effected/npm";
import { NpmRegistry } from "@effected/npm";
import { Yaml } from "@effected/yaml";
import { Context, Effect, Layer, Option } from "effect";

import { FileSystemError } from "../errors/errors.js";
import type { DependencyUpdateResult } from "../schema/domain.js";
import { parseConfigEntry } from "../utils/deps.js";
import { configDepUpgradeRange, resolveLatestSatisfying } from "../utils/semver.js";
import { ReleaseAge } from "./release-age.js";
import { STRINGIFY_OPTIONS, readWorkspaceYaml, sortContent } from "./workspace-yaml.js";

// ══════════════════════════════════════════════════════════════════════════════
// Service Interface
// ══════════════════════════════════════════════════════════════════════════════

export class ConfigDeps extends Context.Service<
	ConfigDeps,
	{
		readonly updateConfigDeps: (
			deps: ReadonlyArray<string>,
			workspaceRoot?: string,
		) => Effect.Effect<ReadonlyArray<DependencyUpdateResult>>;
	}
>()("ConfigDeps") {
	/**
	 * Live layer.
	 *
	 * Declared IN the class body, which is load-bearing rather than stylistic: a
	 * member attached by post-class assignment is tree-shaken out of the bundled
	 * `dist`, and that fails only in production because vitest runs the source.
	 */
	static readonly layer = Layer.effect(
		this,
		Effect.gen(function* () {
			const registry = yield* NpmRegistry;
			const releaseAge = yield* ReleaseAge;
			return {
				updateConfigDeps: (deps, workspaceRoot = process.cwd()) =>
					updateConfigDepsImpl(deps, registry, releaseAge, workspaceRoot),
			};
		}),
	);
}

// ══════════════════════════════════════════════════════════════════════════════
// Internal Helpers
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Query npm for every published version of a package. Returns an empty array
 * (rather than failing) when the registry query errors.
 */
const queryVersions = (packageName: string, registry: NpmRegistryShape): Effect.Effect<ReadonlyArray<string>> =>
	registry.versions(packageName).pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)));

/**
 * Query npm for the integrity hash of a specific package version.
 *
 * Returns the `sha512-...` integrity string, or `null` when the registry query
 * fails, the version is unpublished, or it has no published integrity.
 */
const queryIntegrity = (
	packageName: string,
	version: string,
	registry: NpmRegistryShape,
): Effect.Effect<string | null> =>
	Effect.gen(function* () {
		const info = yield* registry.version(packageName, version).pipe(
			Effect.catch((error) =>
				Effect.gen(function* () {
					yield* Effect.logWarning(
						`queryIntegrity: npm registry query failed for ${packageName}@${version}: ${JSON.stringify({ pkg: error.package, kind: error.kind, registry: error.registry })}`,
					);
					return Option.none<PublishedVersion>();
				}),
			),
		);
		if (Option.isNone(info) || info.value.integrity === undefined) {
			yield* Effect.logWarning(`queryIntegrity: no integrity for ${packageName}@${version}`);
			return null;
		}
		return info.value.integrity;
	});

// ══════════════════════════════════════════════════════════════════════════════
// Implementation
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Update config dependencies by querying npm for latest versions and
 * editing pnpm-workspace.yaml directly.
 */
const updateConfigDepsImpl = (
	deps: ReadonlyArray<string>,
	registry: NpmRegistryShape,
	releaseAge: Effect.Success<typeof ReleaseAge>,
	workspaceRoot: string,
): Effect.Effect<ReadonlyArray<DependencyUpdateResult>> =>
	Effect.gen(function* () {
		if (deps.length === 0) return [];

		const filepath = `${workspaceRoot}/pnpm-workspace.yaml`;

		// Read workspace yaml
		if (!existsSync(filepath)) {
			yield* Effect.logWarning(`pnpm-workspace.yaml not found at ${filepath}`);
			return [];
		}

		const content = yield* readWorkspaceYaml(workspaceRoot).pipe(
			Effect.catch((error) =>
				Effect.gen(function* () {
					yield* Effect.logWarning(`Failed to read pnpm-workspace.yaml: ${error.reason}`);
					return null;
				}),
			),
		);

		if (!content?.configDependencies) {
			yield* Effect.logInfo("No configDependencies section in pnpm-workspace.yaml");
			return [];
		}

		const results: DependencyUpdateResult[] = [];
		let changed = false;

		yield* Effect.logDebug(`configDependencies keys: ${JSON.stringify(Object.keys(content.configDependencies))}`);

		for (const dep of deps) {
			const currentEntry = content.configDependencies[dep];
			if (currentEntry === undefined) {
				yield* Effect.logWarning(`Config dependency ${dep} not found in pnpm-workspace.yaml, skipping`);
				continue;
			}

			// Parse current entry to extract version
			yield* Effect.logDebug(`Parsing config entry for ${dep}: ${String(currentEntry).slice(0, 80)}`);
			const parsed = parseConfigEntry(String(currentEntry));
			if (!parsed) {
				yield* Effect.logWarning(`Could not parse config dependency entry for ${dep}: ${currentEntry}`);
				continue;
			}
			yield* Effect.logDebug(`Parsed ${dep}: version=${parsed.version}, hasHash=${!!parsed.hash}`);

			// Derive a conservative upgrade range from the current version's
			// major: stay within the major for >=1.0.0, allow advancing across
			// 0.x and into the first stable major (never two majors) for <1.0.0.
			const range = configDepUpgradeRange(parsed.version);
			if (!range) {
				yield* Effect.logWarning(`Could not derive an upgrade range for ${dep} from version ${parsed.version}`);
				continue;
			}

			// Query npm for all versions and resolve the highest one in range.
			yield* Effect.logInfo(`Querying npm versions for ${dep} (range ${range})`);
			const versions = yield* queryVersions(dep, registry);
			if (versions.length === 0) {
				yield* Effect.logWarning(`Could not query versions for ${dep}`);
				continue;
			}

			// Mirror pnpm's minimumReleaseAge gate at resolution time so we never
			// write a version pnpm would refuse to install.
			const eligible = yield* releaseAge.filterVersions(dep, versions);

			const resolved = yield* resolveLatestSatisfying(eligible, range);
			if (!resolved) {
				yield* Effect.logInfo(`No version of ${dep} satisfies ${range}`);
				continue;
			}

			// Compare versions
			if (parsed.version === resolved) {
				yield* Effect.logInfo(`${dep} is already up-to-date at ${parsed.version}`);
				continue;
			}

			// Fetch the integrity hash for the resolved version specifically.
			const integrity = yield* queryIntegrity(dep, resolved, registry);
			if (!integrity) {
				yield* Effect.logWarning(`Could not resolve integrity for ${dep}@${resolved}, skipping`);
				continue;
			}

			// Construct new entry: version+integrity
			const newEntry = `${resolved}+${integrity}`;
			content.configDependencies[dep] = newEntry;
			changed = true;

			results.push({
				dependency: dep,
				from: parsed.version,
				to: resolved,
				type: "config",
				package: null,
			});

			yield* Effect.logInfo(`Updated ${dep}: ${parsed.version} -> ${resolved}`);
		}

		// Write back if changed
		if (changed) {
			const sorted = sortContent(content);
			const formatted = yield* Yaml.stringify(sorted, STRINGIFY_OPTIONS).pipe(
				Effect.catch((e) => Effect.as(Effect.logWarning(`Failed to stringify pnpm-workspace.yaml: ${e}`), null)),
			);

			if (formatted !== null) {
				yield* Effect.try({
					try: () => writeFileSync(filepath, formatted, "utf-8"),
					catch: (e) =>
						new FileSystemError({
							operation: "write",
							path: filepath,
							reason: String(e),
						}),
				}).pipe(Effect.catch((error) => Effect.logWarning(`Failed to write pnpm-workspace.yaml: ${error.reason}`)));
			}
		}

		return results;
	});
