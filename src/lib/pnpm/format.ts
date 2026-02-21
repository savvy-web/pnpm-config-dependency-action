/**
 * pnpm-workspace.yaml formatting utility.
 *
 * Formats the workspace file consistently to match @savvy-web/lint-staged PnpmWorkspace handler,
 * avoiding lint-staged hook changes after our action commits.
 *
 * @module pnpm/format
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Effect } from "effect";
import { parse, stringify } from "yaml";

import { FileSystemError } from "../errors/types.js";

/**
 * Shape of pnpm-workspace.yaml content.
 */
export interface PnpmWorkspaceContent {
	packages?: string[];
	onlyBuiltDependencies?: string[];
	publicHoistPattern?: string[];
	configDependencies?: Record<string, string>;
	[key: string]: unknown;
}

/**
 * Keys whose array values should be sorted alphabetically.
 */
const SORTABLE_ARRAY_KEYS = new Set(["packages", "onlyBuiltDependencies", "publicHoistPattern"]);

/**
 * Keys whose object entries should be sorted alphabetically by key.
 */
const SORTABLE_MAP_KEYS = new Set(["configDependencies"]);

/**
 * Default YAML stringify options for consistent formatting.
 * Must match @savvy-web/lint-staged PnpmWorkspace handler.
 */
const STRINGIFY_OPTIONS = {
	indent: 2,
	lineWidth: 0, // Disable line wrapping
	singleQuote: false,
} as const;

/**
 * Sort pnpm-workspace.yaml content.
 *
 * Matches @savvy-web/lint-staged PnpmWorkspace.sortContent pattern, extended
 * with configDependencies key sorting since our action inserts entries via
 * `pnpm add --config` which may not preserve alphabetical order.
 *
 * Sorts:
 * - `packages` array alphabetically
 * - `onlyBuiltDependencies` array (if present)
 * - `publicHoistPattern` array (if present)
 * - `configDependencies` object keys alphabetically
 * - All top-level keys alphabetically, keeping `packages` first
 */
export const sortContent = (content: PnpmWorkspaceContent): PnpmWorkspaceContent => {
	const result: PnpmWorkspaceContent = {};

	// Get all keys and sort them, but keep 'packages' first
	const keys = Object.keys(content).sort((a, b) => {
		if (a === "packages") return -1;
		if (b === "packages") return 1;
		return a.localeCompare(b);
	});

	for (const key of keys) {
		const value = content[key];

		// Sort array values for known sortable keys
		if (SORTABLE_ARRAY_KEYS.has(key) && Array.isArray(value)) {
			result[key] = [...value].sort();
		} else if (SORTABLE_MAP_KEYS.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
			// Sort object keys alphabetically for known map keys
			const sorted: Record<string, unknown> = {};
			for (const k of Object.keys(value as Record<string, unknown>).sort()) {
				sorted[k] = (value as Record<string, unknown>)[k];
			}
			result[key] = sorted;
		} else {
			result[key] = value;
		}
	}

	return result;
};

/**
 * Format pnpm-workspace.yaml file.
 *
 * Reads, sorts, formats, and writes back the workspace file.
 * This ensures consistency with the lint-staged handler.
 */
export const formatWorkspaceYaml = (workspaceRoot: string = process.cwd()): Effect.Effect<void, FileSystemError> =>
	Effect.gen(function* () {
		const filepath = `${workspaceRoot}/pnpm-workspace.yaml`;

		// Check if file exists
		if (!existsSync(filepath)) {
			yield* Effect.logWarning(`pnpm-workspace.yaml not found at ${filepath}`);
			return;
		}

		// Read and parse
		const content = yield* Effect.try({
			try: () => readFileSync(filepath, "utf-8"),
			catch: (e) =>
				new FileSystemError({
					operation: "read",
					path: filepath,
					reason: String(e),
				}),
		});

		const parsed = yield* Effect.try({
			try: () => parse(content) as PnpmWorkspaceContent,
			catch: (e) =>
				new FileSystemError({
					operation: "read",
					path: filepath,
					reason: `Invalid YAML: ${e}`,
				}),
		});

		// Sort and format
		const sorted = sortContent(parsed);
		const formatted = stringify(sorted, STRINGIFY_OPTIONS);

		// Write back
		yield* Effect.try({
			try: () => writeFileSync(filepath, formatted, "utf-8"),
			catch: (e) =>
				new FileSystemError({
					operation: "write",
					path: filepath,
					reason: String(e),
				}),
		});

		yield* Effect.logInfo("Formatted pnpm-workspace.yaml");
	});

/**
 * Read pnpm-workspace.yaml content.
 */
export const readWorkspaceYaml = (
	workspaceRoot: string = process.cwd(),
): Effect.Effect<PnpmWorkspaceContent | null, FileSystemError> =>
	Effect.gen(function* () {
		const filepath = `${workspaceRoot}/pnpm-workspace.yaml`;

		if (!existsSync(filepath)) {
			return null;
		}

		const content = yield* Effect.try({
			try: () => readFileSync(filepath, "utf-8"),
			catch: (e) =>
				new FileSystemError({
					operation: "read",
					path: filepath,
					reason: String(e),
				}),
		});

		return yield* Effect.try({
			try: () => parse(content) as PnpmWorkspaceContent,
			catch: (e) =>
				new FileSystemError({
					operation: "read",
					path: filepath,
					reason: `Invalid YAML: ${e}`,
				}),
		});
	});

/**
 * Get config dependency version from pnpm-workspace.yaml.
 */
export const getConfigDependencyVersion = (
	dependency: string,
	workspaceRoot: string = process.cwd(),
): Effect.Effect<string | null, FileSystemError> =>
	Effect.gen(function* () {
		const content = yield* readWorkspaceYaml(workspaceRoot);

		if (!content?.configDependencies) {
			return null;
		}

		const entry = content.configDependencies[dependency];
		if (!entry) {
			return null;
		}

		// Extract version from entry (format: "version+sha512-...")
		const version = entry.split("+")[0];
		return version || null;
	});
