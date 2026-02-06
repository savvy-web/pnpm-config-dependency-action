/**
 * Changeset creation utilities.
 *
 * Creates changeset files for dependency updates when the repository uses changesets.
 *
 * @module changeset/create
 */

import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { Effect } from "effect";

import type { ChangedPackage, ChangesetFile, LockfileChange } from "../../types/index.js";
import type { ChangesetError } from "../errors/types.js";
import { FileSystemError } from "../errors/types.js";
import { groupChangesByPackage } from "../lockfile/compare.js";

/**
 * Check if the repository uses changesets.
 */
export const hasChangesets = (workspaceRoot: string = process.cwd()): boolean => {
	return existsSync(`${workspaceRoot}/.changeset`);
};

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
 * Create changeset files for dependency updates.
 *
 * Config dependency changes (type="config") always create empty changesets
 * because they are workspace-level tooling, not package dependencies.
 *
 * Regular dependency changes detected in the lockfile create package
 * changesets for the affected packages.
 */
export const createChangesets = (
	changes: ReadonlyArray<LockfileChange>,
	workspaceRoot: string = process.cwd(),
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

/**
 * Format changeset summary from dependency changes.
 */
const formatChangesetSummary = (changes: ReadonlyArray<LockfileChange>): string => {
	const configChanges = changes.filter((c) => c.type === "config");
	const regularChanges = changes.filter((c) => c.type === "regular");

	const lines: string[] = ["Update dependencies:"];
	lines.push("");

	if (configChanges.length > 0) {
		lines.push("**Config dependencies:**");
		for (const change of configChanges) {
			if (change.from) {
				lines.push(`- ${change.dependency}: ${change.from} → ${change.to}`);
			} else {
				lines.push(`- ${change.dependency}: ${change.to} (new)`);
			}
		}
		lines.push("");
	}

	if (regularChanges.length > 0) {
		lines.push("**Dependencies:**");
		for (const change of regularChanges) {
			if (change.from) {
				lines.push(`- ${change.dependency}: ${change.from} → ${change.to}`);
			} else {
				lines.push(`- ${change.dependency}: ${change.to} (new)`);
			}
		}
	}

	return lines.join("\n").trim();
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
