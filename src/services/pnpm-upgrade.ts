/**
 * PnpmUpgrade service for pnpm self-upgrade operations.
 *
 * Detects the current pnpm version from `packageManager` and `devEngines.packageManager`
 * fields in root `package.json`, resolves the latest version within the `^` range,
 * and upgrades via `corepack use`.
 *
 * @module services/pnpm-upgrade
 */

import { readFileSync, writeFileSync } from "node:fs";
import { CommandRunner, SemverResolver } from "@savvy-web/github-action-effects";
import { Context, Effect, Layer } from "effect";

import { FileSystemError } from "../errors/errors.js";
import { detectIndent, formatPnpmVersion, parsePnpmVersion } from "../utils/pnpm.js";
import { resolveLatestInRange } from "../utils/semver.js";

type CommandRunnerShape = Context.Tag.Service<typeof CommandRunner>;

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

// ══════════════════════════════════════════════════════════════════════════════
// Service Interface
// ══════════════════════════════════════════════════════════════════════════════

export class PnpmUpgrade extends Context.Tag("PnpmUpgrade")<
	PnpmUpgrade,
	{
		readonly upgrade: (workspaceRoot?: string) => Effect.Effect<PnpmUpgradeResult | null, FileSystemError>;
	}
>() {}

export const PnpmUpgradeLive = Layer.effect(
	PnpmUpgrade,
	Effect.gen(function* () {
		const runner = yield* CommandRunner;
		return {
			upgrade: (workspaceRoot = process.cwd()) => upgradePnpmImpl(runner, workspaceRoot),
		};
	}),
);

// ══════════════════════════════════════════════════════════════════════════════
// Internal Helpers
// ══════════════════════════════════════════════════════════════════════════════

const fsReadError = (path: string, e: unknown) => new FileSystemError({ operation: "read", path, reason: String(e) });

const fsWriteError = (path: string, e: unknown) => new FileSystemError({ operation: "write", path, reason: String(e) });

// ══════════════════════════════════════════════════════════════════════════════
// Implementation
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Core upgrade implementation that accepts a runner directly.
 */
const upgradePnpmImpl = (
	runner: CommandRunnerShape,
	workspaceRoot: string,
): Effect.Effect<PnpmUpgradeResult | null, FileSystemError> =>
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
		const versionsResult = yield* runner
			.execCapture("sh", ["-c", "npm view pnpm versions --json"])
			.pipe(Effect.mapError((e) => fsReadError("npm registry", `Failed to query pnpm versions: ${e.stderr}`)));

		const allVersions = yield* Effect.try({
			try: () => JSON.parse(versionsResult.stdout) as string[],
			catch: (e) => fsReadError("npm registry", `Failed to parse pnpm versions: ${e}`),
		});

		// Step 5: Resolve latest version for each field
		const pmResolved = packageManagerParsed
			? yield* resolveLatestInRange(allVersions, packageManagerParsed.version)
			: null;
		const deResolved = devEnginesParsed ? yield* resolveLatestInRange(allVersions, devEnginesParsed.version) : null;

		// Determine the highest resolved version across both fields
		let resolved: string | null = null;
		if (pmResolved && deResolved) {
			const cmp = yield* SemverResolver.compare(pmResolved, deResolved).pipe(
				Effect.catchAll(() => Effect.succeed(0 as -1 | 0 | 1)),
			);
			resolved = cmp > 0 ? pmResolved : deResolved;
		} else {
			resolved = pmResolved ?? deResolved;
		}

		if (!resolved) {
			yield* Effect.logInfo("No newer pnpm version found in range");
			return null;
		}

		// Determine the current version (the highest between the two fields)
		const currentVersion = yield* Effect.gen(function* () {
			const pmVersion = packageManagerParsed?.version;
			const deVersion = devEnginesParsed?.version;
			if (pmVersion && deVersion) {
				const cmp = yield* SemverResolver.compare(pmVersion, deVersion).pipe(
					Effect.catchAll(() => Effect.succeed(0 as -1 | 0 | 1)),
				);
				return cmp > 0 ? pmVersion : deVersion;
			}
			return pmVersion ?? deVersion ?? resolved;
		});

		// Check if already up-to-date
		if (resolved === currentVersion) {
			yield* Effect.logInfo(`pnpm ${currentVersion} is already the latest in range`);
			return null;
		}

		// Step 6: Run corepack use to update packageManager field
		let packageManagerUpdated = false;
		if (packageManagerParsed) {
			yield* Effect.logInfo(`Running corepack use pnpm@${resolved}`);
			yield* runner
				.execCapture("sh", ["-c", `corepack use pnpm@${resolved}`])
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
