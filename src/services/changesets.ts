/**
 * Changesets service for creating changeset files after dependency updates.
 *
 * Creates changeset files for dependency updates when the repository uses changesets.
 *
 * @module services/changesets
 */

import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { Context, Effect, Layer } from "effect";
import type { ChangesetError } from "../errors/errors.js";
import { FileSystemError } from "../errors/errors.js";
import type { ChangedPackage, ChangesetFile, LockfileChange } from "../schemas/domain.js";
import { groupChangesByPackage } from "./lockfile.js";

// ══════════════════════════════════════════════════════════════════════════════
// Service Interface
// ══════════════════════════════════════════════════════════════════════════════

export class Changesets extends Context.Tag("Changesets")<
	Changesets,
	{
		readonly create: (
			changes: ReadonlyArray<LockfileChange>,
			workspaceRoot?: string,
		) => Effect.Effect<ReadonlyArray<ChangesetFile>, ChangesetError | FileSystemError>;
	}
>() {}

export const ChangesetsLive = Layer.succeed(Changesets, {
	create: (changes, workspaceRoot = process.cwd()) => createChangesetsImpl(changes, workspaceRoot),
});

// ══════════════════════════════════════════════════════════════════════════════
// Standalone Function Exports
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Create changeset files for dependency updates.
 *
 * Standalone function exported for direct use by consumers that
 * haven't yet migrated to the Changesets service.
 */
export const createChangesets = (
	changes: ReadonlyArray<LockfileChange>,
	workspaceRoot: string = process.cwd(),
): Effect.Effect<ReadonlyArray<ChangesetFile>, ChangesetError | FileSystemError> =>
	createChangesetsImpl(changes, workspaceRoot);

// ══════════════════════════════════════════════════════════════════════════════
// Module-Level Exports
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Check if the repository uses changesets.
 */
export const hasChangesets = (workspaceRoot: string = process.cwd()): boolean => {
	return existsSync(`${workspaceRoot}/.changeset`);
};

/**
 * Format changeset summary from dependency changes.
 *
 * Uses the section-aware format from @savvy-web/changesets with a structured
 * GFM dependency table under the `## Dependencies` heading:
 *
 * | Dependency | Type | Action | From | To |
 * | :--- | :--- | :--- | :--- | :--- |
 * | lodash | dependency | updated | ^4.17.20 | ^4.17.21 |
 *
 * @see https://github.com/savvy-web/changesets/blob/main/docs/changeset-format.md
 */
export const formatChangesetSummary = (changes: ReadonlyArray<LockfileChange>): string => {
	const lines: string[] = [
		"## Dependencies",
		"",
		"| Dependency | Type | Action | From | To |",
		"| :--- | :--- | :--- | :--- | :--- |",
	];

	for (const change of changes) {
		lines.push(formatDependencyRow(change));
	}

	return lines.join("\n");
};

/**
 * Analyze which packages were affected by dependency changes.
 */
export const analyzeAffectedPackages = (changes: ReadonlyArray<LockfileChange>): ReadonlyArray<ChangedPackage> => {
	const grouped = groupChangesByPackage(changes);
	const packages: ChangedPackage[] = [];

	for (const [packageName, pkgChanges] of grouped) {
		if (packageName === "(root)") continue;

		packages.push({
			name: packageName,
			path: "", // Would need workspace info to determine path
			version: "", // Would need to read package.json
			changes: pkgChanges.map((c) => ({
				dependency: c.dependency,
				from: c.from,
				to: c.to,
			})),
		});
	}

	return packages;
};

// ══════════════════════════════════════════════════════════════════════════════
// Internal Helpers
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Generate a unique changeset ID.
 */
const generateChangesetId = (): string => {
	// Generate a random ID similar to what changesets uses
	const adjectives = ["brave", "calm", "eager", "fair", "giant", "happy", "jolly", "kind", "lucky", "merry"];
	const nouns = ["apple", "beach", "cloud", "dream", "eagle", "flame", "grape", "heart", "island", "jewel"];

	const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
	const noun = nouns[Math.floor(Math.random() * nouns.length)];
	const suffix = randomBytes(4).toString("hex");

	return `${adj}-${noun}-${suffix}`;
};

/**
 * Em dash used for missing from/to values in the dependency table.
 */
const EM_DASH = "\u2014";

/**
 * Map LockfileChange type to the dependency table Type column.
 */
const mapDependencyType = (type: LockfileChange["type"]): string => (type === "config" ? "config" : "dependency");

/**
 * Format a single dependency change as a GFM table row.
 */
const formatDependencyRow = (change: LockfileChange): string => {
	const type = mapDependencyType(change.type);
	const action = change.from === null ? "added" : "updated";
	const from = change.from ?? EM_DASH;
	const to = change.to;
	return `| ${change.dependency} | ${type} | ${action} | ${from} | ${to} |`;
};

// ══════════════════════════════════════════════════════════════════════════════
// Implementation Functions
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Create changeset files for dependency updates.
 *
 * Config dependency changes (type="config") always create empty changesets
 * because they are workspace-level tooling, not package dependencies.
 *
 * Regular dependency changes detected in the lockfile create package
 * changesets for the affected packages.
 */
const createChangesetsImpl = (
	changes: ReadonlyArray<LockfileChange>,
	workspaceRoot: string,
): Effect.Effect<ReadonlyArray<ChangesetFile>, ChangesetError | FileSystemError> =>
	Effect.gen(function* () {
		// Check if changesets is enabled
		if (!hasChangesets(workspaceRoot)) {
			yield* Effect.logInfo("Repository does not use changesets, skipping changeset creation");
			return [];
		}

		const changesetDir = `${workspaceRoot}/.changeset`;

		// Group changes by package
		const grouped = groupChangesByPackage(changes);

		if (grouped.size === 0) {
			yield* Effect.logInfo("No changes to create changesets for");
			return [];
		}

		const changesets: ChangesetFile[] = [];

		// Create changesets for each affected package (regular dependency changes)
		for (const [packageName, pkgChanges] of grouped) {
			if (packageName === "(root)") continue; // Config deps handled separately

			const changeset = yield* createPackageChangeset(packageName, pkgChanges, changesetDir);
			changesets.push(changeset);
		}

		// Config dependency changes always get an empty changeset (root workspace)
		// They are workspace-level tooling, not package dependencies
		if (grouped.has("(root)")) {
			const rootChanges = grouped.get("(root)") ?? [];
			const changeset = yield* createEmptyChangeset(rootChanges, changesetDir);
			changesets.push(changeset);
		}

		yield* Effect.logInfo(`Created ${changesets.length} changeset(s)`);

		return changesets;
	});

/**
 * Create a changeset for a specific package.
 */
const createPackageChangeset = (
	packageName: string,
	changes: ReadonlyArray<LockfileChange>,
	changesetDir: string,
): Effect.Effect<ChangesetFile, FileSystemError> =>
	Effect.gen(function* () {
		const id = generateChangesetId();
		const summary = formatChangesetSummary(changes);

		const content = `---
"${packageName}": patch
---

${summary}
`;

		const filepath = `${changesetDir}/${id}.md`;

		yield* Effect.try({
			try: () => writeFileSync(filepath, content, "utf-8"),
			catch: (e) =>
				new FileSystemError({
					operation: "write",
					path: filepath,
					reason: String(e),
				}),
		});

		yield* Effect.logDebug(`Created changeset ${id} for ${packageName}`);

		return {
			id,
			packages: [packageName],
			type: "patch",
			summary,
		};
	});

/**
 * Create an empty changeset for root/config dependency changes.
 */
const createEmptyChangeset = (
	changes: ReadonlyArray<LockfileChange>,
	changesetDir: string,
): Effect.Effect<ChangesetFile, FileSystemError> =>
	Effect.gen(function* () {
		const id = generateChangesetId();
		const summary = formatChangesetSummary(changes);

		// Empty changeset (no packages affected)
		const content = `---
---

${summary}
`;

		const filepath = `${changesetDir}/${id}.md`;

		yield* Effect.try({
			try: () => writeFileSync(filepath, content, "utf-8"),
			catch: (e) =>
				new FileSystemError({
					operation: "write",
					path: filepath,
					reason: String(e),
				}),
		});

		yield* Effect.logDebug(`Created empty changeset ${id} for config dependencies`);

		return {
			id,
			packages: [],
			type: "patch",
			summary,
		};
	});
