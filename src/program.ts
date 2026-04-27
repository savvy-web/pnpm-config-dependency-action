/**
 * Action program and utilities.
 *
 * Contains the main Effect program and helper functions, separated from
 * the entry point (`main.ts`) so tests can import without triggering
 * module-level `Action.run` execution.
 *
 * @module program
 */

import type { CommandRunnerError, LogLevelInput } from "@savvy-web/github-action-effects";
import {
	Action,
	ActionEnvironment,
	ActionInputError,
	ActionOutputs,
	CheckRun,
	CommandRunner,
	GitHubApp,
} from "@savvy-web/github-action-effects";
import { Config, Duration, Effect, LogLevel, Logger, Redacted } from "effect";
import { makeAppLayer } from "./layers/app.js";
import type { ChangesetFile, DependencyUpdateResult, PullRequestResult } from "./schemas/domain.js";
import { BranchManager } from "./services/branch.js";
import { Changesets } from "./services/changesets.js";
import { ConfigDeps } from "./services/config-deps.js";
import { captureLockfileState, compareLockfiles } from "./services/lockfile.js";
import type { PeerSyncConfig } from "./services/peer-sync.js";
import { syncPeers } from "./services/peer-sync.js";
import { PnpmUpgrade } from "./services/pnpm-upgrade.js";
import { RegularDeps } from "./services/regular-deps.js";
import { Report } from "./services/report.js";
import { formatWorkspaceYaml, readWorkspaceYaml } from "./services/workspace-yaml.js";
import { matchesPattern } from "./utils/deps.js";
import { parseMultiValueInput } from "./utils/input.js";

/**
 * Result of running custom commands.
 */
export interface RunCommandsResult {
	readonly successful: ReadonlyArray<string>;
	readonly failed: ReadonlyArray<{ command: string; error: string; exitCode?: number | undefined }>;
}

/**
 * Run custom commands after dependency updates.
 *
 * Commands are executed sequentially. All commands are attempted even if some fail,
 * but failures are collected and returned for the caller to handle.
 */
export const runCommands = (commands: ReadonlyArray<string>): Effect.Effect<RunCommandsResult, never, CommandRunner> =>
	Effect.gen(function* () {
		const runner = yield* CommandRunner;
		const successful: string[] = [];
		const failed: Array<{ command: string; error: string; exitCode?: number | undefined }> = [];

		for (const command of commands) {
			yield* Effect.logInfo(`Running: ${command}`);

			// Split command into executable and args for CommandRunner
			const result = yield* runner.execCapture("sh", ["-c", command]).pipe(
				Effect.map(() => ({ success: true as const })),
				Effect.catchAll((error: CommandRunnerError) =>
					Effect.succeed({
						success: false as const,
						error: error.reason ?? "Unknown error",
						exitCode: error.exitCode,
					}),
				),
			);

			if (result.success) {
				yield* Effect.logInfo(`Command completed: ${command}`);
				successful.push(command);
			} else {
				yield* Effect.logError(`Command failed: ${command}`);
				yield* Effect.logDebug(
					`Command error: ${JSON.stringify({ command, stderr: result.error, exitCode: result.exitCode })}`,
				);
				failed.push({ command, error: result.error, exitCode: result.exitCode });
			}
		}

		return { successful, failed };
	});

/**
 * Run `pnpm install --frozen-lockfile=false --fix-lockfile`.
 *
 * Uses `--frozen-lockfile=false` to opt out of the CI default that refuses to
 * write lockfile changes, and `--fix-lockfile` to reconcile the lockfile
 * against the just-modified manifests while leaving unrelated transitives at
 * their currently-pinned versions.
 */
export const runInstall = (): Effect.Effect<void, CommandRunnerError, CommandRunner> =>
	Effect.gen(function* () {
		const runner = yield* CommandRunner;
		yield* runner.exec("pnpm", ["install", "--frozen-lockfile=false", "--fix-lockfile"]);
	});

/**
 * Main action program.
 *
 * Single-phase entry point that handles token lifecycle, check runs,
 * and the full dependency update workflow.
 */
/* v8 ignore start -- orchestration code tested via integration */
export const program = Effect.gen(function* () {
	// Parse inputs via Config API
	yield* Effect.logInfo("Starting pnpm config dependency action");

	const appId = yield* Config.string("app-id");
	const appPrivateKey = yield* Config.secret("app-private-key");
	const branch = yield* Config.string("branch").pipe(Config.withDefault("pnpm/config-deps"));
	const rawConfigDeps = yield* Config.string("config-dependencies").pipe(Config.withDefault(""));
	const configDependencies = parseMultiValueInput(rawConfigDeps);
	const rawDeps = yield* Config.string("dependencies").pipe(Config.withDefault(""));
	const dependencies = parseMultiValueInput(rawDeps);
	const rawPeerLock = yield* Config.string("peer-lock").pipe(Config.withDefault(""));
	const peerLock = parseMultiValueInput(rawPeerLock);
	const rawPeerMinor = yield* Config.string("peer-minor").pipe(Config.withDefault(""));
	const peerMinor = parseMultiValueInput(rawPeerMinor);
	const rawRun = yield* Config.string("run").pipe(Config.withDefault(""));
	const run = parseMultiValueInput(rawRun);
	const updatePnpm = yield* Config.boolean("update-pnpm").pipe(Config.withDefault(true));
	const changesets = yield* Config.boolean("changesets").pipe(Config.withDefault(true));
	const autoMerge = yield* Config.string("auto-merge").pipe(Config.withDefault(""));
	const dryRun = yield* Config.boolean("dry-run").pipe(Config.withDefault(false));
	const logLevel = yield* Config.string("log-level").pipe(Config.withDefault("auto"));
	const timeout = yield* Config.integer("timeout").pipe(Config.withDefault(180));

	// Cross-validate: at least one update type must be active
	if (configDependencies.length === 0 && dependencies.length === 0 && !updatePnpm) {
		yield* Effect.fail(
			new ActionInputError({
				inputName: "config-dependencies",
				reason: "At least one update type must be active",
				rawValue: undefined,
			}),
		);
	}

	// Validate peer-lock and peer-minor don't overlap
	const peerOverlap = peerLock.filter((p) => peerMinor.includes(p));
	if (peerOverlap.length > 0) {
		yield* Effect.fail(
			new ActionInputError({
				inputName: "peer-lock",
				reason: `Packages appear in both peer-lock and peer-minor: ${peerOverlap.join(", ")}`,
				rawValue: undefined,
			}),
		);
	}

	// Warn if peer entries don't match any dependencies pattern
	for (const pkg of [...peerLock, ...peerMinor]) {
		const hasMatch = dependencies.some((p) => matchesPattern(pkg, p));
		if (!hasMatch) {
			yield* Effect.logWarning(`peer-lock/peer-minor entry "${pkg}" does not match any dependencies pattern`);
		}
	}

	// Resolve log level
	const resolvedLogLevel = Action.resolveLogLevel(logLevel as LogLevelInput);
	// Map ActionLogLevel ("info" | "verbose" | "debug") to Effect LogLevel
	// "info" = show info and above (default CI behavior)
	// "verbose" = show all info (same as info for Effect's logger)
	// "debug" = show debug and above (verbose output)
	const effectLogLevel =
		resolvedLogLevel === "debug" ? LogLevel.Debug : resolvedLogLevel === "verbose" ? LogLevel.Debug : LogLevel.Info;

	yield* Effect.logDebug("Debug mode enabled - verbose logging active");
	yield* Effect.logDebug(
		`Parsed inputs: ${JSON.stringify({
			branch,
			configDependencies,
			dependencies,
			peerLock,
			peerMinor,
			updatePnpm,
			dryRun,
		})}`,
	);

	if (dryRun) {
		yield* Effect.logWarning("Running in dry-run mode - will detect changes but skip commit/push/PR");
	}

	// Generate GitHub App token and run the main workflow
	const ghApp = yield* GitHubApp;
	const env = yield* ActionEnvironment;
	const github = yield* env.github;
	const headSha = github.sha;

	yield* ghApp
		.withToken(appId, Redacted.value(appPrivateKey), (token) =>
			Effect.gen(function* () {
				// Bridge GitHub App token to GitHubClientLive (reads from env)
				process.env.GITHUB_TOKEN = token;
				const appLayer = makeAppLayer(dryRun);
				yield* innerProgram(
					{
						branch,
						"config-dependencies": configDependencies,
						dependencies,
						"peer-lock": peerLock,
						"peer-minor": peerMinor,
						"update-pnpm": updatePnpm,
						changesets,
						"auto-merge": autoMerge as "" | "merge" | "squash" | "rebase",
						run,
					},
					dryRun,
					headSha,
					appLayer,
				).pipe(Logger.withMinimumLogLevel(effectLogLevel));
			}),
		)
		.pipe(
			Effect.timeoutFail({
				duration: Duration.seconds(timeout),
				onTimeout: () => new Error(`Action timed out after ${timeout} seconds`),
			}),
		);
});

/**
 * Inner program that runs with all services provided.
 */
const innerProgram = (
	inputs: {
		branch: string;
		"config-dependencies": ReadonlyArray<string>;
		dependencies: ReadonlyArray<string>;
		"peer-lock": ReadonlyArray<string>;
		"peer-minor": ReadonlyArray<string>;
		"update-pnpm": boolean;
		changesets: boolean;
		"auto-merge": "" | "merge" | "squash" | "rebase";
		run: ReadonlyArray<string>;
	},
	dryRun: boolean,
	headSha: string,
	appLayer: ReturnType<typeof makeAppLayer>,
) =>
	// appLayer is provided at two levels: here (outer) for services used before
	// withCheckRun, and again inside the withCheckRun callback (inner) because
	// the callback signature requires R = never (all services resolved).
	Effect.provide(
		Effect.gen(function* () {
			const outputs = yield* ActionOutputs;
			const checkRunService = yield* CheckRun;

			// Create check run for visibility
			const checkRunName = dryRun ? "Dependency Updates (Dry Run)" : "Dependency Updates";

			yield* checkRunService.withCheckRun(checkRunName, headSha, (checkRunId) =>
				Effect.provide(
					Effect.gen(function* () {
						// Manage branch
						yield* Effect.logInfo("Step 1: Managing branch");
						const branchManager = yield* BranchManager;
						const branchResult = yield* branchManager.manage(inputs.branch, "main");
						yield* Effect.logInfo(`Branch: ${branchResult.branch} (created: ${branchResult.created})`);

						// Capture lockfile state before updates
						yield* Effect.logInfo("Step 2: Capturing lockfile state (before)");
						const lockfileBefore = yield* captureLockfileState();
						yield* Effect.logDebug(
							`Lockfile state (before): ${JSON.stringify({
								packages: Object.keys(lockfileBefore?.packages || {}).length,
								importers: Object.keys(lockfileBefore?.importers || {}).length,
							})}`,
						);

						// Upgrade pnpm (if enabled)
						const configUpdatesFromPnpm: DependencyUpdateResult[] = [];
						if (inputs["update-pnpm"]) {
							yield* Effect.logInfo("Step 3: Upgrading pnpm");
							const pnpmUpgradeService = yield* PnpmUpgrade;
							const pnpmUpgrade = yield* pnpmUpgradeService.upgrade().pipe(
								Effect.catchAll((error) => {
									return Effect.gen(function* () {
										yield* Effect.logWarning(`Failed to upgrade pnpm: ${error.reason}`);
										return null;
									});
								}),
							);

							if (pnpmUpgrade) {
								yield* Effect.logInfo(`pnpm: ${pnpmUpgrade.from} -> ${pnpmUpgrade.to}`);
								configUpdatesFromPnpm.push({
									dependency: "pnpm",
									from: pnpmUpgrade.from,
									to: pnpmUpgrade.to,
									type: "config",
									package: null,
								});
							} else {
								yield* Effect.logInfo("pnpm is already up-to-date");
							}
						}

						// Update config dependencies
						yield* Effect.logInfo("Step 4: Updating config dependencies");
						const workspaceBefore = yield* readWorkspaceYaml().pipe(Effect.catchAll(() => Effect.succeed(null)));
						yield* Effect.logDebug(`pnpm-workspace.yaml (before): ${JSON.stringify(workspaceBefore)}`);

						const configDepsService = yield* ConfigDeps;
						const configUpdates = yield* configDepsService.updateConfigDeps(inputs["config-dependencies"]);
						yield* Effect.logDebug(`Config dependency updates: ${JSON.stringify(configUpdates)}`);

						// Update regular dependencies
						yield* Effect.logInfo("Step 5: Updating regular dependencies");
						const regularDepsService = yield* RegularDeps;
						const regularUpdates = yield* regularDepsService.updateRegularDeps(inputs.dependencies);

						// Sync peer dependencies
						const peerSyncConfig: PeerSyncConfig = {
							lock: inputs["peer-lock"],
							minor: inputs["peer-minor"],
						};
						yield* Effect.logInfo("Step 5b: Syncing peer dependencies");
						const peerUpdates = yield* syncPeers(peerSyncConfig, regularUpdates);
						if (peerUpdates.length > 0) {
							yield* Effect.logInfo(`Synced ${peerUpdates.length} peer dependency range(s)`);
						}

						// Reconcile lockfile and install
						if (
							configUpdates.length > 0 ||
							regularUpdates.length > 0 ||
							configUpdatesFromPnpm.length > 0 ||
							peerUpdates.length > 0
						) {
							yield* Effect.logInfo("Step 6: Reconciling lockfile and installing");
							yield* runInstall();
						}

						// Format pnpm-workspace.yaml
						yield* Effect.logInfo("Step 7: Formatting pnpm-workspace.yaml");
						yield* formatWorkspaceYaml();

						const workspaceAfter = yield* readWorkspaceYaml().pipe(Effect.catchAll(() => Effect.succeed(null)));
						yield* Effect.logDebug(`pnpm-workspace.yaml (after): ${JSON.stringify(workspaceAfter)}`);

						// Run custom commands (if specified)
						if (inputs.run.length > 0) {
							yield* Effect.logInfo("Step 8: Running custom commands");
							const runCommandsResult = yield* runCommands(inputs.run);

							if (runCommandsResult.failed.length > 0) {
								const failedCommands = runCommandsResult.failed.map((f) => f.command).join(", ");
								yield* Effect.logError(`${runCommandsResult.failed.length} command(s) failed: ${failedCommands}`);

								const failureDetails = runCommandsResult.failed.map((f) => `- \`${f.command}\`: ${f.error}`).join("\n");

								yield* checkRunService.complete(checkRunId, "failure", {
									title: "Custom Commands Failed",
									summary: `Custom commands failed:\n\n${failureDetails}`,
								});

								yield* outputs.set("has-changes", "false");
								yield* outputs.set("updates-count", "0");

								return yield* Effect.fail(new Error(`Custom commands failed: ${failedCommands}`));
							}
						}

						// Capture lockfile state after updates
						yield* Effect.logInfo("Step 9: Capturing lockfile state (after)");
						const lockfileAfter = yield* captureLockfileState();
						yield* Effect.logDebug(
							`Lockfile state (after): ${JSON.stringify({
								packages: Object.keys(lockfileAfter?.packages || {}).length,
								importers: Object.keys(lockfileAfter?.importers || {}).length,
							})}`,
						);

						// Detect changes
						yield* Effect.logInfo("Step 10: Detecting changes");
						const changes = yield* compareLockfiles(lockfileBefore, lockfileAfter);
						yield* Effect.logDebug(`Detected changes: ${JSON.stringify(changes)}`);

						const allUpdates = [...configUpdatesFromPnpm, ...configUpdates, ...regularUpdates, ...peerUpdates];
						yield* Effect.logDebug(
							`Total updates: ${allUpdates.length} (config: ${configUpdates.length + configUpdatesFromPnpm.length}, dev: ${regularUpdates.length}, peer: ${peerUpdates.length})`,
						);

						// Check if there are any changes via git status
						const runner = yield* CommandRunner;
						const statusResult = yield* runner.execCapture("git", ["status", "--porcelain"]);
						const hasChanges = statusResult.stdout.trim().length > 0;
						yield* Effect.logDebug(`Git status has changes: ${hasChanges}`);

						if (!hasChanges && changes.length === 0) {
							yield* Effect.logInfo("No dependency updates available");

							yield* checkRunService.complete(checkRunId, "neutral", {
								title: "No Updates",
								summary: "No dependency updates available. All dependencies are up-to-date.",
							});

							yield* outputs.set("has-changes", "false");
							yield* outputs.set("updates-count", "0");

							return;
						}

						// Create changesets (if enabled)
						let changesets: ReadonlyArray<ChangesetFile> = [];
						if (inputs.changesets) {
							yield* Effect.logInfo("Step 11: Creating changesets");
							const changesetsService = yield* Changesets;
							changesets = yield* changesetsService.create(process.cwd(), changes, regularUpdates, peerUpdates);
						} else {
							yield* Effect.logInfo("Step 11: Skipping changesets (disabled)");
						}

						// Commit and push
						const report = yield* Report;
						if (dryRun) {
							yield* Effect.logInfo("Step 12: [DRY RUN] Skipping commit and push");
						} else {
							yield* Effect.logInfo("Step 12: Committing via GitHub API");
							const commitMessage = report.generateCommitMessage(allUpdates);
							yield* branchManager.commitChanges(commitMessage, inputs.branch);
						}

						// Create/update PR
						let pr: PullRequestResult | null = null;
						if (dryRun) {
							yield* Effect.logInfo("Step 13: [DRY RUN] Skipping PR creation/update");
						} else {
							yield* Effect.logInfo("Step 13: Creating/updating PR");
							pr = yield* report
								.createOrUpdatePR(inputs.branch, allUpdates, changesets, inputs["auto-merge"] || undefined)
								.pipe(
									Effect.catchAll((error) =>
										Effect.gen(function* () {
											yield* Effect.logWarning(`PR creation failed: ${error.reason}`);
											return null;
										}),
									),
								);
						}

						// Update check run
						const summaryText = report.generateSummary(allUpdates, changesets, pr, dryRun);
						yield* checkRunService.complete(checkRunId, "success", {
							title: "Dependency Updates Complete",
							summary: summaryText,
						});

						// Set outputs
						yield* outputs.set("has-changes", "true");
						yield* outputs.set("updates-count", String(allUpdates.length));
						if (pr) {
							yield* outputs.set("pr-number", String(pr.number));
							yield* outputs.set("pr-url", pr.url);
						}

						// Write job summary
						const jobSummaryLines = ["# Dependency Updates"];
						if (dryRun) {
							jobSummaryLines.push("", "> **DRY RUN MODE** - Changes detected but not committed/pushed");
						}
						jobSummaryLines.push("", summaryText);
						yield* outputs.summary(jobSummaryLines.join("\n"));

						yield* Effect.logInfo("Dependency update action completed successfully");
					}),
					appLayer,
				),
			);
		}),
		appLayer,
	);
/* v8 ignore stop */
