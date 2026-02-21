/**
 * Config dependency updates via direct YAML editing.
 *
 * Instead of using `pnpm add --config` (which promotes all workspace
 * dependencies to the default catalog when `catalogMode: strict` is enabled),
 * this module queries npm directly for latest versions and edits
 * `pnpm-workspace.yaml` in place.
 *
 * @module pnpm/config
 */

import { existsSync, writeFileSync } from "node:fs";
import { Effect } from "effect";
import { stringify } from "yaml";
import type { DependencyUpdateResult } from "../../types/index.js";
import { FileSystemError } from "../errors/types.js";
import { PnpmExecutor } from "../services/index.js";
import { readWorkspaceYaml, sortContent } from "./format.js";

// ══════════════════════════════════════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════════════════════════════════════

/**
 * YAML stringify options matching format.ts for consistent output.
 */
const STRINGIFY_OPTIONS = {
	indent: 2,
	lineWidth: 0,
	singleQuote: false,
} as const;

// ══════════════════════════════════════════════════════════════════════════════
// Pure Helpers (exported for testing)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Parse a config dependency entry from pnpm-workspace.yaml.
 *
 * Config dependency entries have the format `version+sha512-base64hash`
 * or just `version` (no hash). Cannot split on `+` naively because
 * the base64 hash itself contains `+` characters.
 *
 * @example
 * parseConfigEntry("0.6.3+sha512-abc==") // { version: "0.6.3", hash: "sha512-abc==" }
 * parseConfigEntry("0.6.3")              // { version: "0.6.3", hash: null }
 */
export const parseConfigEntry = (entry: string): { version: string; hash: string | null } | null => {
	if (!entry || entry.trim().length === 0) return null;

	// Find the first occurrence of "+sha" which marks the boundary
	// between version and integrity hash
	const shaIndex = entry.indexOf("+sha");
	if (shaIndex === -1) {
		// No hash suffix — entry is just a version
		return { version: entry, hash: null };
	}

	return {
		version: entry.substring(0, shaIndex),
		hash: entry.substring(shaIndex + 1), // skip the "+"
	};
};

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
): Effect.Effect<{ version: string; integrity: string } | null, never, PnpmExecutor> =>
	Effect.gen(function* () {
		const pnpm = yield* PnpmExecutor;

		const output = yield* pnpm
			.run(`npm view ${packageName}@latest version dist.integrity --json`)
			.pipe(Effect.catchAll(() => Effect.succeed(null)));

		if (output === null) return null;

		try {
			const parsed = JSON.parse(output);
			if (
				parsed &&
				typeof parsed === "object" &&
				typeof parsed.version === "string" &&
				typeof parsed["dist.integrity"] === "string"
			) {
				return {
					version: parsed.version,
					integrity: parsed["dist.integrity"],
				};
			}
			return null;
		} catch {
			return null;
		}
	});

// ══════════════════════════════════════════════════════════════════════════════
// Main Export
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Update config dependencies by querying npm for latest versions and
 * editing pnpm-workspace.yaml directly.
 *
 * This avoids `pnpm add --config` which promotes all workspace
 * dependencies to the default catalog when `catalogMode: strict` is enabled.
 */
export const updateConfigDeps = (
	deps: ReadonlyArray<string>,
	workspaceRoot: string = process.cwd(),
): Effect.Effect<ReadonlyArray<DependencyUpdateResult>, never, PnpmExecutor> =>
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

		for (const dep of deps) {
			const currentEntry = content.configDependencies[dep];
			if (currentEntry === undefined) {
				yield* Effect.logWarning(`Config dependency ${dep} not found in pnpm-workspace.yaml, skipping`);
				continue;
			}

			// Parse current entry to extract version
			const parsed = parseConfigEntry(String(currentEntry));
			if (!parsed) {
				yield* Effect.logWarning(`Could not parse config dependency entry for ${dep}: ${currentEntry}`);
				continue;
			}

			// Query npm for latest version + integrity
			yield* Effect.logInfo(`Querying npm for latest version of ${dep}`);
			const latest = yield* queryConfigVersion(dep);

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
