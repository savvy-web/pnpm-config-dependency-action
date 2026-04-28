/**
 * Changesets service for creating changeset files after dependency updates.
 *
 * A workspace package gets a changeset only when it is versionable
 * (publishable OR versionPrivate) AND a consumer-facing change occurred.
 * Triggers are non-dev LockfileChange records (dependency,
 * optionalDependency, peerDependency), peer-sync rewrites, and any
 * regularUpdates whose `type` is dependency/optionalDependency/peerDependency.
 * devDependency rows (from lockfile changes or regularUpdates) are
 * informational only and never themselves trigger a changeset. Empty
 * changesets are not written.
 *
 * @module services/changesets
 */

import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import type { WorkspacePackage } from "workspaces-effect";
import { PublishabilityDetector, WorkspaceDiscovery } from "workspaces-effect";

import type { ChangesetError } from "../errors/errors.js";
import { FileSystemError } from "../errors/errors.js";
import type { ChangesetFile, DependencyUpdateResult, LockfileChange } from "../schemas/domain.js";
import { ChangesetConfig } from "./changeset-config.js";

// ══════════════════════════════════════════════════════════════════════════════
// Service Interface
// ══════════════════════════════════════════════════════════════════════════════

export class Changesets extends Context.Tag("Changesets")<
	Changesets,
	{
		readonly create: (
			workspaceRoot: string,
			lockfileChanges: ReadonlyArray<LockfileChange>,
			regularUpdates?: ReadonlyArray<DependencyUpdateResult>,
			peerUpdates?: ReadonlyArray<DependencyUpdateResult>,
		) => Effect.Effect<ReadonlyArray<ChangesetFile>, ChangesetError | FileSystemError>;
	}
>() {}

// ══════════════════════════════════════════════════════════════════════════════
// Module-Level Exports
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Check if the repository uses changesets.
 */
export const hasChangesets = (workspaceRoot: string = process.cwd()): boolean =>
	existsSync(join(workspaceRoot, ".changeset"));

// ══════════════════════════════════════════════════════════════════════════════
// Live Layer
// ══════════════════════════════════════════════════════════════════════════════

export const ChangesetsLive = Layer.effect(
	Changesets,
	Effect.gen(function* () {
		const discovery = yield* WorkspaceDiscovery;
		const detector = yield* PublishabilityDetector;
		const config = yield* ChangesetConfig;
		return {
			create: (workspaceRoot, lockfileChanges, regularUpdates = [], peerUpdates = []) =>
				createChangesetsImpl(workspaceRoot, lockfileChanges, regularUpdates, peerUpdates, discovery, detector, config),
		};
	}),
);

// ══════════════════════════════════════════════════════════════════════════════
// Internal Helpers
// ══════════════════════════════════════════════════════════════════════════════

const TRIGGER_TYPES: ReadonlySet<LockfileChange["type"]> = new Set([
	"dependency",
	"optionalDependency",
	"peerDependency",
]);

const EM_DASH = "—";

interface ChangesetTableRow {
	readonly dependency: string;
	readonly type: string;
	readonly action: string;
	readonly from: string | null;
	readonly to: string;
}

interface PerPackage {
	triggerRows: ChangesetTableRow[];
	devRows: ChangesetTableRow[];
}

const formatRowsAsTable = (rows: ReadonlyArray<ChangesetTableRow>): string => {
	const lines = [
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

const generateChangesetId = (): string => {
	const adjectives = ["brave", "calm", "eager", "fair", "giant", "happy", "jolly", "kind", "lucky", "merry"];
	const nouns = ["apple", "beach", "cloud", "dream", "eagle", "flame", "grape", "heart", "island", "jewel"];
	const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
	const noun = nouns[Math.floor(Math.random() * nouns.length)];
	const suffix = randomBytes(4).toString("hex");
	return `${adj}-${noun}-${suffix}`;
};

const lockfileChangeToRow = (c: LockfileChange): ChangesetTableRow => ({
	dependency: c.dependency,
	type: c.type,
	action: c.from === null ? "added" : "updated",
	from: c.from,
	to: c.to,
});

const updateToRow = (u: DependencyUpdateResult, typeOverride?: string): ChangesetTableRow => ({
	dependency: u.dependency,
	type: typeOverride ?? u.type,
	action: u.from === null ? "added" : "updated",
	from: u.from,
	to: u.to,
});

const dedupeRows = (rows: ChangesetTableRow[]): ChangesetTableRow[] => {
	const seen = new Set<string>();
	return rows.filter((row) => {
		const key = `${row.dependency}|${row.type}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
};

// ══════════════════════════════════════════════════════════════════════════════
// Implementation
// ══════════════════════════════════════════════════════════════════════════════

const createChangesetsImpl = (
	workspaceRoot: string,
	lockfileChanges: ReadonlyArray<LockfileChange>,
	regularUpdates: ReadonlyArray<DependencyUpdateResult>,
	peerUpdates: ReadonlyArray<DependencyUpdateResult>,
	discovery: Context.Tag.Service<typeof WorkspaceDiscovery>,
	detector: Context.Tag.Service<typeof PublishabilityDetector>,
	config: Context.Tag.Service<typeof ChangesetConfig>,
): Effect.Effect<ReadonlyArray<ChangesetFile>, ChangesetError | FileSystemError> =>
	Effect.gen(function* () {
		if (!hasChangesets(workspaceRoot)) {
			yield* Effect.logInfo("Repository does not use changesets, skipping changeset creation");
			return [];
		}

		const allPackages = yield* discovery.listPackages(workspaceRoot).pipe(
			Effect.catchAll((error) =>
				Effect.gen(function* () {
					yield* Effect.logWarning(`Failed to list workspace packages: ${String(error)}`);
					return [] as ReadonlyArray<WorkspacePackage>;
				}),
			),
		);

		// Group changes per package
		const perPackage = new Map<string, PerPackage>();
		const ensure = (name: string): PerPackage => {
			let entry = perPackage.get(name);
			if (!entry) {
				entry = { triggerRows: [], devRows: [] };
				perPackage.set(name, entry);
			}
			return entry;
		};

		for (const change of lockfileChanges) {
			if (change.type === "config") continue;
			const isTrigger = TRIGGER_TYPES.has(change.type);
			for (const pkg of change.affectedPackages) {
				const entry = ensure(pkg);
				if (isTrigger) {
					entry.triggerRows.push(lockfileChangeToRow(change));
				} else {
					entry.devRows.push(lockfileChangeToRow(change));
				}
			}
		}

		for (const update of peerUpdates) {
			if (!update.package) continue;
			ensure(update.package).triggerRows.push(updateToRow(update, "peerDependency"));
		}

		// regularUpdates carry the real section type (dependency / devDependency
		// / optionalDependency). Route by type — non-dev types are triggers,
		// devDependency is informational only.
		for (const update of regularUpdates) {
			if (!update.package) continue;
			const isTrigger = TRIGGER_TYPES.has(update.type as LockfileChange["type"]);
			const row = updateToRow(update);
			if (isTrigger) {
				ensure(update.package).triggerRows.push(row);
			} else {
				ensure(update.package).devRows.push(row);
			}
		}

		const changesetDir = join(workspaceRoot, ".changeset");
		const out: ChangesetFile[] = [];

		for (const pkg of allPackages) {
			const entry = perPackage.get(pkg.name);
			if (!entry || entry.triggerRows.length === 0) continue;

			// Versionable cascade: publishable OR versionPrivate
			// pkg is already a full WorkspacePackage from getWorkspacePackagesSync v0.5.0
			const targets = yield* detector.detect(pkg, workspaceRoot);
			const publishable = targets.length > 0;
			const versionable = publishable || (yield* config.versionPrivate(workspaceRoot));

			if (!versionable) {
				yield* Effect.logDebug(`Skipping changeset for ${pkg.name}: not versionable`);
				continue;
			}

			const allRows = dedupeRows([...entry.triggerRows, ...entry.devRows]);
			const summary = formatRowsAsTable(allRows);
			const id = generateChangesetId();
			const filepath = join(changesetDir, `${id}.md`);
			const content = `---\n"${pkg.name}": patch\n---\n\n${summary}\n`;

			yield* Effect.try({
				try: () => writeFileSync(filepath, content, "utf-8"),
				catch: (e) => new FileSystemError({ operation: "write", path: filepath, reason: String(e) }),
			});

			yield* Effect.logDebug(`Created changeset ${id} for ${pkg.name}`);
			out.push({ id, packages: [pkg.name], type: "patch", summary });
		}

		yield* Effect.logInfo(`Created ${out.length} changeset(s)`);
		return out;
	});
