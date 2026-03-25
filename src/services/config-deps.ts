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
import { NpmRegistry } from "@savvy-web/github-action-effects";
import { Context, Effect, Layer } from "effect";
import { stringify } from "yaml";

import { FileSystemError } from "../errors/errors.js";
import type { DependencyUpdateResult } from "../schemas/domain.js";
import { parseConfigEntry } from "../utils/deps.js";
import { STRINGIFY_OPTIONS, readWorkspaceYaml, sortContent } from "./workspace-yaml.js";

type NpmRegistryShape = Context.Tag.Service<typeof NpmRegistry>;

// ══════════════════════════════════════════════════════════════════════════════
// Service Interface
// ══════════════════════════════════════════════════════════════════════════════

export class ConfigDeps extends Context.Tag("ConfigDeps")<
	ConfigDeps,
	{
		readonly updateConfigDeps: (
			deps: ReadonlyArray<string>,
			workspaceRoot?: string,
		) => Effect.Effect<ReadonlyArray<DependencyUpdateResult>>;
	}
>() {}

export const ConfigDepsLive = Layer.effect(
	ConfigDeps,
	Effect.gen(function* () {
		const registry = yield* NpmRegistry;
		return {
			updateConfigDeps: (deps, workspaceRoot = process.cwd()) => updateConfigDepsImpl(deps, registry, workspaceRoot),
		};
	}),
);

// ══════════════════════════════════════════════════════════════════════════════
// Internal Helpers
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Query npm for the latest version and integrity hash of a package.
 *
 * Returns `{ version, integrity }` or `null` on failure.
 */
const queryConfigVersion = (
	packageName: string,
	registry: NpmRegistryShape,
): Effect.Effect<{ version: string; integrity: string } | null> =>
	Effect.gen(function* () {
		yield* Effect.logDebug(`queryConfigVersion: fetching package info for ${packageName}`);
		const info = yield* registry.getPackageInfo(packageName).pipe(
			Effect.catchAll((error) =>
				Effect.gen(function* () {
					yield* Effect.logWarning(
						`queryConfigVersion: npm registry query failed for ${packageName}: ${JSON.stringify({ pkg: error.pkg, operation: error.operation, reason: error.reason })}`,
					);
					return null;
				}),
			),
		);
		if (!info) {
			yield* Effect.logDebug(`queryConfigVersion: no package info returned for ${packageName}`);
			return null;
		}
		if (!info.integrity) {
			yield* Effect.logWarning(
				`queryConfigVersion: package info missing integrity for ${packageName} (version: ${info.version})`,
			);
			return null;
		}
		yield* Effect.logDebug(
			`queryConfigVersion: found ${packageName}@${info.version} (integrity: ${info.integrity.slice(0, 20)}...)`,
		);
		return { version: info.version, integrity: info.integrity };
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
			Effect.catchAll((error) =>
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

			// Query npm for latest version + integrity
			yield* Effect.logInfo(`Querying npm for latest version of ${dep}`);
			const latest = yield* queryConfigVersion(dep, registry);

			if (!latest) {
				yield* Effect.logWarning(`Could not query latest version for ${dep}`);
				continue;
			}

			// Compare versions
			if (parsed.version === latest.version) {
				yield* Effect.logInfo(`${dep} is already up-to-date at ${parsed.version}`);
				continue;
			}

			// Construct new entry: version+integrity
			const newEntry = `${latest.version}+${latest.integrity}`;
			content.configDependencies[dep] = newEntry;
			changed = true;

			results.push({
				dependency: dep,
				from: parsed.version,
				to: latest.version,
				type: "config",
				package: null,
			});

			yield* Effect.logInfo(`Updated ${dep}: ${parsed.version} -> ${latest.version}`);
		}

		// Write back if changed
		if (changed) {
			const sorted = sortContent(content);
			const formatted = stringify(sorted, STRINGIFY_OPTIONS);

			yield* Effect.try({
				try: () => writeFileSync(filepath, formatted, "utf-8"),
				catch: (e) =>
					new FileSystemError({
						operation: "write",
						path: filepath,
						reason: String(e),
					}),
			}).pipe(Effect.catchAll((error) => Effect.logWarning(`Failed to write pnpm-workspace.yaml: ${error.reason}`)));
		}

		return results;
	});
