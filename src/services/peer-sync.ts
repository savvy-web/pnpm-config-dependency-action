/**
 * PeerSync module for syncing peerDependency ranges after devDependency updates.
 *
 * Uses semver-effect for robust version parsing and comparison.
 *
 * @module services/peer-sync
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { SemVer } from "semver-effect";
import { getPackageInfosAsync } from "workspace-tools";

import { FileSystemError } from "../errors/errors.js";
import type { DependencyUpdateResult } from "../schemas/domain.js";
import { parseSpecifier } from "../utils/deps.js";
import { detectIndent } from "../utils/pnpm.js";

export type PeerStrategy = "lock" | "minor";

export interface PeerSyncConfig {
	readonly lock: ReadonlyArray<string>;
	readonly minor: ReadonlyArray<string>;
}

/**
 * Compute the new peer dependency range based on strategy.
 *
 * Returns the new specifier string, or null if no update needed
 * (e.g., minor strategy with a patch-only bump).
 */
export const computePeerRange = (params: {
	strategy: PeerStrategy;
	currentPeerSpecifier: string;
	oldVersion: string;
	newVersion: string;
}): Effect.Effect<string | null> =>
	Effect.gen(function* () {
		const { strategy, currentPeerSpecifier, oldVersion, newVersion } = params;

		const parsed = parseSpecifier(currentPeerSpecifier);
		if (!parsed) return null;

		const oldSemver = yield* SemVer.parse(oldVersion).pipe(Effect.catchAll(() => Effect.succeed(null)));
		const newSemver = yield* SemVer.parse(newVersion).pipe(Effect.catchAll(() => Effect.succeed(null)));

		if (!oldSemver || !newSemver) return null;

		if (strategy === "lock") {
			return `${parsed.prefix}${newVersion}`;
		}

		// minor strategy: sync only on minor+ bumps
		const isMinorOrMajorBump =
			newSemver.major > oldSemver.major || (newSemver.major === oldSemver.major && newSemver.minor > oldSemver.minor);

		if (!isMinorOrMajorBump) return null;

		// Floor patch to .0
		return `${parsed.prefix}${newSemver.major}.${newSemver.minor}.0`;
	});

/**
 * Sync peerDependency ranges based on devDependency updates and peer config.
 */
export const syncPeers = (
	config: PeerSyncConfig,
	devUpdates: ReadonlyArray<DependencyUpdateResult>,
	workspaceRoot: string = process.cwd(),
): Effect.Effect<ReadonlyArray<DependencyUpdateResult>> =>
	Effect.gen(function* () {
		if (config.lock.length === 0 && config.minor.length === 0) return [];

		const results: DependencyUpdateResult[] = [];

		// Overlap is validated in program.ts before syncPeers is called
		const strategyMap = new Map<string, PeerStrategy>();
		for (const pkg of config.lock) strategyMap.set(pkg, "lock");
		for (const pkg of config.minor) strategyMap.set(pkg, "minor");

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

		const nameToPath = new Map<string, string>();
		const rootPkgJson = join(workspaceRoot, "package.json");
		// Resolve root package name from package.json
		const rootName = yield* Effect.try({
			try: () => {
				const raw = readFileSync(rootPkgJson, "utf-8");
				const pkg = JSON.parse(raw) as { name?: string };
				return pkg.name ?? "(root)";
			},
			catch: () =>
				new FileSystemError({ operation: "read", path: rootPkgJson, reason: "Failed to read root package.json" }),
		}).pipe(Effect.catchAll(() => Effect.succeed("(root)")));
		nameToPath.set(rootName, rootPkgJson);
		if (rootName !== "(root)") nameToPath.set("(root)", rootPkgJson);
		for (const [name, info] of Object.entries(packageInfos)) {
			nameToPath.set(name, info.packageJsonPath);
		}

		for (const update of devUpdates) {
			const strategy = strategyMap.get(update.dependency);
			if (!strategy) continue;

			const pkgPath = update.package ? nameToPath.get(update.package) : null;
			if (!pkgPath) {
				yield* Effect.logWarning(
					`Cannot find package.json path for "${update.package}" to sync peer "${update.dependency}"`,
				);
				continue;
			}

			const raw = yield* Effect.try({
				try: () => readFileSync(pkgPath, "utf-8"),
				catch: (e) => new FileSystemError({ operation: "read", path: pkgPath, reason: String(e) }),
			}).pipe(
				Effect.catchAll((e) =>
					Effect.gen(function* () {
						yield* Effect.logWarning(`Failed to read ${pkgPath}: ${e.reason}`);
						return null;
					}),
				),
			);

			if (!raw) continue;

			const indent = detectIndent(raw);
			const pkg = JSON.parse(raw) as Record<string, unknown>;
			const peers = pkg.peerDependencies as Record<string, string> | undefined;

			if (!peers || !(update.dependency in peers)) {
				yield* Effect.logWarning(
					`No peerDependencies entry for "${update.dependency}" in ${pkgPath}, skipping peer sync`,
				);
				continue;
			}

			const currentPeerSpecifier = peers[update.dependency];

			// Skip newly-added deps (no previous version to determine bump size)
			const fromParsed = parseSpecifier(update.from ?? "");
			const toParsed = parseSpecifier(update.to);
			if (!fromParsed || !toParsed) continue;

			const newPeerSpecifier = yield* computePeerRange({
				strategy,
				currentPeerSpecifier,
				oldVersion: fromParsed.version,
				newVersion: toParsed.version,
			});

			if (!newPeerSpecifier || newPeerSpecifier === currentPeerSpecifier) continue;

			peers[update.dependency] = newPeerSpecifier;
			yield* Effect.try({
				try: () => writeFileSync(pkgPath, `${JSON.stringify(pkg, null, indent)}\n`, "utf-8"),
				catch: (e) => new FileSystemError({ operation: "write", path: pkgPath, reason: String(e) }),
			}).pipe(Effect.catchAll((e) => Effect.logWarning(`Failed to write ${pkgPath}: ${e.reason}`)));

			yield* Effect.logInfo(
				`Synced peer ${update.dependency} in ${update.package}: ${currentPeerSpecifier} -> ${newPeerSpecifier}`,
			);

			results.push({
				dependency: update.dependency,
				from: currentPeerSpecifier,
				to: newPeerSpecifier,
				type: "peerDependency",
				package: update.package,
			});
		}

		return results;
	});
