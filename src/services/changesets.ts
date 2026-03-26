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
import type { ChangedPackage, ChangesetFile, DependencyUpdateResult, LockfileChange } from "../schemas/domain.js";
import { groupChangesByPackage } from "./lockfile.js";

// ══════════════════════════════════════════════════════════════════════════════
// Service Interface
// ══════════════════════════════════════════════════════════════════════════════

export class Changesets extends Context.Tag("Changesets")<
	Changesets,
	{
		readonly create: (
			lockfileChanges: ReadonlyArray<LockfileChange>,
			devUpdates?: ReadonlyArray<DependencyUpdateResult>,
			peerUpdates?: ReadonlyArray<DependencyUpdateResult>,
			workspaceRoot?: string,
		) => Effect.Effect<ReadonlyArray<ChangesetFile>, ChangesetError | FileSystemError>;
	}
>() {}

export const ChangesetsLive = Layer.succeed(Changesets, {
	create: (lockfileChanges, devUpdates = [], peerUpdates = [], workspaceRoot = process.cwd()) =>
		createChangesetsImpl(lockfileChanges, devUpdates, peerUpdates, workspaceRoot),
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
	lockfileChanges: ReadonlyArray<LockfileChange>,
	devUpdates: ReadonlyArray<DependencyUpdateResult> = [],
	peerUpdates: ReadonlyArray<DependencyUpdateResult> = [],
	workspaceRoot: string = process.cwd(),
): Effect.Effect<ReadonlyArray<ChangesetFile>, ChangesetError | FileSystemError> =>
	createChangesetsImpl(lockfileChanges, devUpdates, peerUpdates, workspaceRoot);

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
 * Format a single dependency change as a GFM table row.
 */
const formatDependencyRow = (change: LockfileChange): string => {
	const action = change.from === null ? "added" : "updated";
	const from = change.from ?? EM_DASH;
	const to = change.to;
	return `| ${change.dependency} | ${change.type} | ${action} | ${from} | ${to} |`;
};

// ══════════════════════════════════════════════════════════════════════════════
// Changeset Table Row Types
// ══════════════════════════════════════════════════════════════════════════════

interface ChangesetTableRow {
	dependency: string;
	type: string;
	action: string;
	from: string | null;
	to: string;
}

const formatRowsAsTable = (rows: ReadonlyArray<ChangesetTableRow>): string => {
	const lines: string[] = [
		"## Dependencies",
		"",
		"| Dependency | Type | Action | From | To |",
		"| :--- | :--- | :--- | :--- | :--- |",
	];
	for (const row of rows) {
		lines.push(`| ${row.dependency} | ${row.type} | ${row.action} | ${row.from ?? EM_DASH} | ${row.to} |`);
	}
	return lines.join("\n");
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
 * Lockfile changes (dependency/optionalDependency) and peer dependency updates
 * are consumer-facing and trigger changesets. DevDependency-only changes do NOT
 * trigger changesets but are included in the table when a changeset is created
 * for other reasons.
 */
const createChangesetsImpl = (
	lockfileChanges: ReadonlyArray<LockfileChange>,
	devUpdates: ReadonlyArray<DependencyUpdateResult>,
	peerUpdates: ReadonlyArray<DependencyUpdateResult>,
	workspaceRoot: string,
): Effect.Effect<ReadonlyArray<ChangesetFile>, ChangesetError | FileSystemError> =>
	Effect.gen(function* () {
		// Check if changesets is enabled
		if (!hasChangesets(workspaceRoot)) {
			yield* Effect.logInfo("Repository does not use changesets, skipping changeset creation");
			return [];
		}

		const changesetDir = `${workspaceRoot}/.changeset`;
		const changesets: ChangesetFile[] = [];

		// Group lockfile changes by package
		const grouped = groupChangesByPackage(lockfileChanges);

		// Build per-package change lists combining all sources
		const packageChanges = new Map<string, { triggersChangeset: boolean; rows: ChangesetTableRow[] }>();

		// Lockfile changes (dependency/optionalDependency - consumer-facing)
		for (const [pkgName, changes] of grouped) {
			if (pkgName === "(root)") continue;
			const entry = packageChanges.get(pkgName) ?? { triggersChangeset: false, rows: [] };
			for (const change of changes) {
				entry.triggersChangeset = true;
				entry.rows.push({
					dependency: change.dependency,
					type: change.type,
					action: change.from === null ? "added" : "updated",
					from: change.from,
					to: change.to,
				});
			}
			packageChanges.set(pkgName, entry);
		}

		// Peer updates (consumer-facing)
		for (const update of peerUpdates) {
			if (!update.package) continue;
			const entry = packageChanges.get(update.package) ?? { triggersChangeset: false, rows: [] };
			entry.triggersChangeset = true;
			entry.rows.push({
				dependency: update.dependency,
				type: "peerDependency",
				action: "updated",
				from: update.from,
				to: update.to,
			});
			packageChanges.set(update.package, entry);
		}

		// DevDep updates (NOT consumer-facing, included in table only)
		for (const update of devUpdates) {
			if (!update.package) continue;
			const entry = packageChanges.get(update.package) ?? { triggersChangeset: false, rows: [] };
			entry.rows.push({
				dependency: update.dependency,
				type: "devDependency",
				action: "updated",
				from: update.from,
				to: update.to,
			});
			packageChanges.set(update.package, entry);
		}

		// Deduplicate rows per package (lockfile detection may overlap with direct updates)
		for (const [, data] of packageChanges) {
			const seen = new Set<string>();
			data.rows = data.rows.filter((row) => {
				const key = `${row.dependency}|${row.type}`;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
		}

		// Create changesets for packages with consumer-facing changes
		for (const [pkgName, data] of packageChanges) {
			if (!data.triggersChangeset) continue;
			const id = generateChangesetId();
			const summary = formatRowsAsTable(data.rows);
			const content = `---\n"${pkgName}": patch\n---\n\n${summary}\n`;
			const filepath = `${changesetDir}/${id}.md`;

			yield* Effect.try({
				try: () => writeFileSync(filepath, content, "utf-8"),
				catch: (e) => new FileSystemError({ operation: "write", path: filepath, reason: String(e) }),
			});

			yield* Effect.logDebug(`Created changeset ${id} for ${pkgName}`);
			changesets.push({ id, packages: [pkgName], type: "patch", summary });
		}

		// Root/config changesets (empty changeset for config-only changes)
		if (grouped.has("(root)")) {
			const rootChanges = grouped.get("(root)") ?? [];
			const changeset = yield* createEmptyChangeset(rootChanges, changesetDir);
			changesets.push(changeset);
		}

		yield* Effect.logInfo(`Created ${changesets.length} changeset(s)`);
		return changesets;
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
