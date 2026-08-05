/**
 * `pnpm-workspace.yaml` formatting and reading.
 *
 * Formats the workspace file consistently to match @savvy-web/lint-staged's
 * PnpmWorkspace handler, avoiding lint-staged hook changes after our action
 * commits.
 *
 * **Standalone functions, not a service.** There was a `WorkspaceYaml` tag and
 * a `WorkspaceYamlLive` layer here; both were deleted because nothing in `src/`
 * ever wired them — the only code that resolved the tag was this module's own
 * test suite, so the tests passed precisely because they were the sole callers.
 * That is the same reasoning that removed four unconstructed error classes from
 * `errors/errors.ts` on this branch: a construct whose only consumer is its own
 * test is indistinguishable from dead code, and renaming it to the kit's layer
 * convention would only have made it tidier dead code.
 *
 * The suite now drives {@link formatWorkspaceYaml} / {@link readWorkspaceYaml}
 * directly, which is what `program.ts`, `ConfigDeps` and the config-dependency
 * step actually call — so it exercises the production path rather than a
 * parallel one.
 *
 * @module services/workspace-yaml
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Yaml } from "@effected/yaml";
import { Effect } from "effect";

import { FileSystemError } from "../errors/errors.js";

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
export const STRINGIFY_OPTIONS = {
	indent: 2,
	lineWidth: 0, // Disable line wrapping
	// Indent block sequences one level under their mapping key, matching the
	// legacy `yaml` npm package's default output (byte-parity with prior runs).
	indentSequences: true,
	// Fall back to double quotes (not @effected/yaml's single-quoted default) when
	// a scalar requires quoting, so scoped keys like `"@parcel/watcher"` are not
	// rewritten to single quotes on every run — matching the v3 `yaml` package's
	// `singleQuote: false` posture and the @savvy-web/silk-effects PnpmWorkspace
	// handler. Requires @effected/yaml >= 0.5.0 (quoteStyle).
	quoteStyle: "double",
} as const;

/**
 * Sort pnpm-workspace.yaml content.
 *
 * Matches @savvy-web/lint-staged PnpmWorkspace.sortContent pattern, extended
 * with configDependencies key sorting since updated entries may not preserve
 * alphabetical order.
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

// ══════════════════════════════════════════════════════════════════════════════
// Implementation Functions
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Format pnpm-workspace.yaml file.
 *
 * Reads, sorts, formats, and writes back the workspace file.
 * This ensures consistency with the lint-staged handler.
 */
export const formatWorkspaceYaml = (workspaceRoot: string = process.cwd()): Effect.Effect<void, FileSystemError> =>
	formatWorkspaceYamlImpl(workspaceRoot);

/**
 * Read pnpm-workspace.yaml content.
 */
export const readWorkspaceYaml = (
	workspaceRoot: string = process.cwd(),
): Effect.Effect<PnpmWorkspaceContent | null, FileSystemError> => readWorkspaceYamlImpl(workspaceRoot);

const formatWorkspaceYamlImpl = (workspaceRoot: string): Effect.Effect<void, FileSystemError> =>
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

		const parsed = (yield* Yaml.parse(content).pipe(
			Effect.mapError(
				(e) =>
					new FileSystemError({
						operation: "read",
						path: filepath,
						reason: `Invalid YAML: ${e}`,
					}),
			),
		)) as PnpmWorkspaceContent;

		// Sort and format
		const sorted = sortContent(parsed);
		const formatted = yield* Yaml.stringify(sorted, STRINGIFY_OPTIONS).pipe(
			Effect.mapError(
				(e) =>
					new FileSystemError({
						operation: "write",
						path: filepath,
						reason: `Failed to stringify YAML: ${e}`,
					}),
			),
		);

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
const readWorkspaceYamlImpl = (workspaceRoot: string): Effect.Effect<PnpmWorkspaceContent | null, FileSystemError> =>
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

		return (yield* Yaml.parse(content).pipe(
			Effect.mapError(
				(e) =>
					new FileSystemError({
						operation: "read",
						path: filepath,
						reason: `Invalid YAML: ${e}`,
					}),
			),
		)) as PnpmWorkspaceContent;
	});
