/**
 * pnpm self-upgrade logic.
 *
 * Detects the current pnpm version from `packageManager` and `devEngines.packageManager`
 * fields in root `package.json`, resolves the latest version within the `^` range,
 * and upgrades via `corepack use`.
 *
 * @module pnpm/upgrade
 */

import { readFileSync, writeFileSync } from "node:fs";
import { Effect } from "effect";
import * as semver from "semver";

import { FileSystemError } from "../errors/types.js";
import { PnpmExecutor } from "../services/index.js";

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Result of a pnpm upgrade operation.
 */
export interface PnpmUpgradeResult {
	readonly from: string;
	readonly to: string;
	readonly packageManagerUpdated: boolean;
	readonly devEnginesUpdated: boolean;
}

/**
 * Parsed pnpm version info.
 */
export interface ParsedPnpmVersion {
	readonly version: string;
	readonly hasCaret: boolean;
	readonly hasSha: boolean;
}

// ══════════════════════════════════════════════════════════════════════════════
// Pure Helpers (exported for testing)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Parse a pnpm version string from `packageManager` or `devEngines.packageManager.version`.
 *
 * Handles formats:
 * - `pnpm@10.28.2` (packageManager field, exact)
 * - `pnpm@10.28.2+sha512...` (packageManager field, with integrity hash)
 * - `pnpm@^10.28.2` (packageManager field, with caret)
 * - `10.28.2` (devEngines version field, exact)
 * - `^10.28.2` (devEngines version field, with caret)
 *
 * @param raw - The raw version string
 * @param stripPnpmPrefix - Whether to strip the `pnpm@` prefix (true for packageManager field)
 */
export const parsePnpmVersion = (raw: string, stripPnpmPrefix = false): ParsedPnpmVersion | null => {
	if (!raw) return null;

	let value = raw.trim();

	// Strip `pnpm@` prefix if present
	if (stripPnpmPrefix) {
		if (!value.startsWith("pnpm@")) return null;
		value = value.slice(5); // Remove "pnpm@"
	}

	// Detect and strip sha suffix
	const hasSha = value.includes("+");
	if (hasSha) {
		value = value.split("+")[0];
	}

	// Detect and strip caret
	const hasCaret = value.startsWith("^");
	if (hasCaret) {
		value = value.slice(1);
	}

	// Validate as semver
	if (!semver.valid(value)) return null;

	return { version: value, hasCaret, hasSha };
};

/**
 * Format a pnpm version with optional caret prefix.
 */
export const formatPnpmVersion = (version: string, hasCaret: boolean): string => {
	return hasCaret ? `^${version}` : version;
};

/**
 * Resolve the latest version within a `^` range from available versions.
 *
 * @param versions - Available versions to choose from
 * @param current - The current version (used to construct `^current` range)
 * @returns The highest version satisfying `^current`, or null if none found
 */
export const resolveLatestInRange = (versions: ReadonlyArray<string>, current: string): string | null => {
	// Filter out pre-release versions
	const stableVersions = versions.filter((v) => !semver.prerelease(v));

	const result = semver.maxSatisfying(stableVersions, `^${current}`);
	return result;
};

// ══════════════════════════════════════════════════════════════════════════════
// Internal Helpers
// ══════════════════════════════════════════════════════════════════════════════

const fsReadError = (path: string, e: unknown) => new FileSystemError({ operation: "read", path, reason: String(e) });

const fsWriteError = (path: string, e: unknown) => new FileSystemError({ operation: "write", path, reason: String(e) });

// ══════════════════════════════════════════════════════════════════════════════
// Main Upgrade Function
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Upgrade pnpm to the latest version within the `^` range.
 *
 * 1. Reads root `package.json`
 * 2. Parses `packageManager` and `devEngines.packageManager` fields
 * 3. Queries available pnpm versions via `npm view pnpm versions --json`
 * 4. Resolves the latest version in the `^` range
 * 5. Runs `corepack use pnpm@<version>` to update `packageManager`
 * 6. Updates `devEngines.packageManager.version` if present
 *
 * @returns Upgrade result, or null if no upgrade was needed
 */
export const upgradePnpm = (
	workspaceRoot: string = process.cwd(),
): Effect.Effect<PnpmUpgradeResult | null, FileSystemError, PnpmExecutor> =>
	Effect.gen(function* () {
		const packageJsonPath = `${workspaceRoot}/package.json`;

		// Step 1: Read and parse package.json
		const packageJsonRaw = yield* Effect.try({
			try: () => readFileSync(packageJsonPath, "utf-8"),
			catch: (e) => fsReadError(packageJsonPath, e),
		});

		const packageJson = yield* Effect.try({
			try: () => JSON.parse(packageJsonRaw) as Record<string, unknown>,
			catch: (e) => fsReadError(packageJsonPath, `Invalid JSON: ${e}`),
		});

		// Step 2: Parse packageManager field
		const packageManagerRaw = typeof packageJson.packageManager === "string" ? packageJson.packageManager : null;
		const packageManagerParsed = packageManagerRaw ? parsePnpmVersion(packageManagerRaw, true) : null;

		// Step 3: Parse devEngines.packageManager field
		const devEngines = packageJson.devEngines as { packageManager?: { name?: string; version?: string } } | undefined;
		const devEnginesPm = devEngines?.packageManager;
		const devEnginesParsed =
			devEnginesPm?.name === "pnpm" && typeof devEnginesPm.version === "string"
				? parsePnpmVersion(devEnginesPm.version)
				: null;

		// If neither field found, nothing to do
		if (!packageManagerParsed && !devEnginesParsed) {
			yield* Effect.logInfo("No pnpm version fields found in package.json, skipping upgrade");
			return null;
		}

		// Step 4: Query available pnpm versions
		const pnpm = yield* PnpmExecutor;
		const versionsOutput = yield* pnpm
			.run("npm view pnpm versions --json")
			.pipe(Effect.mapError((e) => fsReadError("npm registry", `Failed to query pnpm versions: ${e.stderr}`)));

		const allVersions = yield* Effect.try({
			try: () => JSON.parse(versionsOutput) as string[],
			catch: (e) => fsReadError("npm registry", `Failed to parse pnpm versions: ${e}`),
		});

		// Step 5: Resolve latest version for each field
		const pmResolved = packageManagerParsed ? resolveLatestInRange(allVersions, packageManagerParsed.version) : null;
		const deResolved = devEnginesParsed ? resolveLatestInRange(allVersions, devEnginesParsed.version) : null;

		// Determine the highest resolved version across both fields
		let resolved: string | null = null;
		if (pmResolved && deResolved) {
			resolved = semver.gt(pmResolved, deResolved) ? pmResolved : deResolved;
		} else {
			resolved = pmResolved ?? deResolved;
		}

		if (!resolved) {
			yield* Effect.logInfo("No newer pnpm version found in range");
			return null;
		}

		// Determine the current version (the highest between the two fields)
		const currentVersion = (() => {
			const pmVersion = packageManagerParsed?.version;
			const deVersion = devEnginesParsed?.version;
			if (pmVersion && deVersion) {
				return semver.gt(pmVersion, deVersion) ? pmVersion : deVersion;
			}
			return pmVersion ?? deVersion ?? resolved;
		})();

		// Check if already up-to-date
		if (resolved === currentVersion) {
			yield* Effect.logInfo(`pnpm ${currentVersion} is already the latest in range`);
			return null;
		}

		// Step 6: Run corepack use to update packageManager field
		let packageManagerUpdated = false;
		if (packageManagerParsed) {
			yield* Effect.logInfo(`Running corepack use pnpm@${resolved}`);
			yield* pnpm
				.run(`corepack use pnpm@${resolved}`)
				.pipe(Effect.mapError((e) => fsWriteError(packageJsonPath, `corepack use failed: ${e.stderr}`)));
			packageManagerUpdated = true;
		}

		// Step 7: Update devEngines.packageManager.version if present
		let devEnginesUpdated = false;
		if (devEnginesParsed) {
			// Re-read package.json since corepack may have modified it
			const updatedRaw = yield* Effect.try({
				try: () => readFileSync(packageJsonPath, "utf-8"),
				catch: (e) => fsReadError(packageJsonPath, e),
			});

			// Detect indentation from file
			const indent = detectIndent(updatedRaw);

			const updatedJson = yield* Effect.try({
				try: () => JSON.parse(updatedRaw) as Record<string, unknown>,
				catch: (e) => fsReadError(packageJsonPath, `Invalid JSON: ${e}`),
			});

			const updatedDevEngines = updatedJson.devEngines as
				| { packageManager?: { name?: string; version?: string } }
				| undefined;

			if (updatedDevEngines?.packageManager) {
				updatedDevEngines.packageManager.version = formatPnpmVersion(resolved, devEnginesParsed.hasCaret);

				yield* Effect.try({
					try: () => writeFileSync(packageJsonPath, `${JSON.stringify(updatedJson, null, indent)}\n`, "utf-8"),
					catch: (e) => fsWriteError(packageJsonPath, e),
				});

				devEnginesUpdated = true;
			}
		}

		return {
			from: currentVersion,
			to: resolved,
			packageManagerUpdated,
			devEnginesUpdated,
		};
	});

/**
 * Detect indentation used in a JSON file (tab or N spaces).
 */
export const detectIndent = (content: string): string | number => {
	const match = content.match(/^(\s+)"/m);
	if (match) {
		const indent = match[1];
		if (indent.includes("\t")) return "\t";
		return indent.length;
	}
	return "\t";
};
