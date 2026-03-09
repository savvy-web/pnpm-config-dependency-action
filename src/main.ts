/**
 * Main action script (single-phase entry point).
 *
 * Orchestrates the dependency update workflow:
 * 1. Parse inputs
 * 2. Generate GitHub App token
 * 3. Create check run
 * 4. Manage branch (create/recreate)
 * 5. Capture lockfile state (before)
 * 6. Upgrade pnpm (if enabled)
 * 7. Update config dependencies
 * 8. Update regular dependencies
 * 9. Clean install (rm -rf node_modules pnpm-lock.yaml + pnpm install)
 * 10. Format pnpm-workspace.yaml
 * 11. Run custom commands (if specified)
 * 12. Capture lockfile state (after)
 * 13. Detect changes
 * 14. Create changesets (if enabled)
 * 15. Commit and push
 * 16. Create/update PR
 *
 * @module main
 */

import { context } from "@actions/github";
import type { ActionInputError } from "@savvy-web/github-action-effects";
import {
	Action,
	ActionOutputs,
	CheckRun,
	CommandRunner,
	GitHubApp,
	GitHubAppLive,
} from "@savvy-web/github-action-effects";
import type { Layer } from "effect";
import { Duration, Effect, Schema } from "effect";
import { makeAppLayer } from "./layers/app.js";
import type { ChangesetFile, DependencyUpdateResult, PullRequestResult } from "./schemas/domain.js";
import { BranchManager } from "./services/branch.js";
import { createChangesets } from "./services/changesets.js";
import { ConfigDeps } from "./services/config-deps.js";
import { captureLockfileState, compareLockfiles } from "./services/lockfile.js";
import { PnpmUpgrade } from "./services/pnpm-upgrade.js";
import { RegularDeps } from "./services/regular-deps.js";
import { Report } from "./services/report.js";
import { formatWorkspaceYaml, readWorkspaceYaml } from "./services/workspace-yaml.js";

/**
 * Result of running custom commands.
 */
export interface RunCommandsResult {
	readonly successful: ReadonlyArray<string>;
	readonly failed: ReadonlyArray<{ command: string; error: string; exitCode?: number }>;
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
		const failed: Array<{ command: string; error: string; exitCode?: number }> = [];

		for (const command of commands) {
			yield* Effect.logInfo(`Running: ${command}`);

			// Split command into executable and args for CommandRunner
			const result = yield* runner.execCapture("sh", ["-c", command]).pipe(
				Effect.map(() => ({ success: true as const })),
				Effect.catchAll((error: { reason?: string; exitCode?: number }) =>
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
 * Main action program.
 *
 * Single-phase entry point that handles token lifecycle, check runs,
 * and the full dependency update workflow.
 */
/* v8 ignore start -- orchestration code tested via integration */
export const program = Effect.gen(function* () {
	yield* Effect.logInfo("Starting pnpm config dependency action");

	// Step 1: Parse inputs
	const inputs = yield* Action.parseInputs(
		{
			"app-id": { schema: Schema.String, required: true, secret: false },
			"app-private-key": { schema: Schema.String, required: true, secret: true },
			branch: { schema: Schema.String, default: "pnpm/config-deps" },
			"config-dependencies": { schema: Schema.Array(Schema.String), multiline: true, default: [] },
			dependencies: { schema: Schema.Array(Schema.String), multiline: true, default: [] },
			run: { schema: Schema.Array(Schema.String), multiline: true, default: [] },
			"update-pnpm": { schema: Schema.Boolean, default: true },
			changesets: { schema: Schema.Boolean, default: true },
			"auto-merge": { schema: Schema.Literal("", "merge", "squash", "rebase"), default: "" as const },
			"dry-run": { schema: Schema.Boolean, default: false },
			timeout: { schema: Schema.NumberFromString, default: "180" },
		},
		(parsed) => {
			// Cross-validate: at least one update type must be active
			const hasConfig = parsed["config-dependencies"].length > 0;
			const hasDeps = parsed.dependencies.length > 0;
			const hasPnpm = parsed["update-pnpm"];
			if (!hasConfig && !hasDeps && !hasPnpm) {
				return Effect.fail(
					new (class extends Error {
						readonly _tag = "ActionInputError" as const;
						readonly inputName = "config-dependencies";
						readonly reason = "At least one update type must be active";
						readonly rawValue = undefined;
					})() as unknown as ActionInputError,
				);
			}
			return Effect.succeed(parsed);
		},
	);

	const dryRun = inputs["dry-run"];

	yield* Effect.logDebug("Debug mode enabled - verbose logging active");
	yield* Effect.logDebug(
		`Parsed inputs: ${JSON.stringify({
			branch: inputs.branch,
			configDependencies: inputs["config-dependencies"],
			dependencies: inputs.dependencies,
			updatePnpm: inputs["update-pnpm"],
			dryRun,
		})}`,
	);

	if (dryRun) {
		yield* Effect.logWarning("Running in dry-run mode - will detect changes but skip commit/push/PR");
	}

	// Step 2: Generate GitHub App token and run the main workflow
	const ghApp = yield* GitHubApp;
	const timeoutSeconds = inputs.timeout;
	yield* ghApp
		.withToken(inputs["app-id"], inputs["app-private-key"], (token) =>
			Effect.gen(function* () {
				const appLayer = makeAppLayer(token, dryRun);
				yield* innerProgram(inputs, dryRun, appLayer);
			}),
		)
		.pipe(
			Effect.timeoutFail({
				duration: Duration.seconds(timeoutSeconds),
				onTimeout: () => new Error(`Action timed out after ${timeoutSeconds} seconds`),
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
		"update-pnpm": boolean;
		changesets: boolean;
		"auto-merge": "" | "merge" | "squash" | "rebase";
		run: ReadonlyArray<string>;
	},
	dryRun: boolean,
	// biome-ignore lint/suspicious/noExplicitAny: Layer type is complex and inferred at call site
	appLayer: Layer.Layer<any, any>,
) =>
	// appLayer is provided at two levels: here (outer) for services used before
	// withCheckRun, and again inside the withCheckRun callback (inner) because
	// the callback signature requires R = never (all services resolved).
	Effect.provide(
		Effect.gen(function* () {
			const outputs = yield* ActionOutputs;
			const checkRunService = yield* CheckRun;
			const headSha = context.sha;

			// Create check run for visibility
			const checkRunName = dryRun ? "Dependency Updates (Dry Run)" : "Dependency Updates";

			yield* checkRunService.withCheckRun(checkRunName, headSha, (checkRunId) =>
				Effect.provide(
					Effect.gen(function* () {
						// Step 3: Manage branch
						yield* Effect.logInfo("Step 1: Managing branch");
						const branchManager = yield* BranchManager;
						const branchResult = yield* branchManager.manage(inputs.branch, "main");
						yield* Effect.logInfo(`Branch: ${branchResult.branch} (created: ${branchResult.created})`);

						// Step 4: Capture lockfile state before updates
						yield* Effect.logInfo("Step 2: Capturing lockfile state (before)");
						const lockfileBefore = yield* captureLockfileState();
						yield* Effect.logDebug(
							`Lockfile state (before): ${JSON.stringify({
								packages: Object.keys(lockfileBefore?.packages || {}).length,
								importers: Object.keys(lockfileBefore?.importers || {}).length,
							})}`,
						);

						// Step 5: Upgrade pnpm (if enabled)
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

						// Step 6: Update config dependencies
						yield* Effect.logInfo("Step 4: Updating config dependencies");
						const workspaceBefore = yield* readWorkspaceYaml().pipe(Effect.catchAll(() => Effect.succeed(null)));
						yield* Effect.logDebug(`pnpm-workspace.yaml (before): ${JSON.stringify(workspaceBefore)}`);

						const configDepsService = yield* ConfigDeps;
						const configUpdates = yield* configDepsService.updateConfigDeps(inputs["config-dependencies"]);
						yield* Effect.logDebug(`Config dependency updates: ${JSON.stringify(configUpdates)}`);

						// Step 7: Update regular dependencies
						yield* Effect.logInfo("Step 5: Updating regular dependencies");
						const regularDepsService = yield* RegularDeps;
						const regularUpdates = yield* regularDepsService.updateRegularDeps(inputs.dependencies);

						// Step 8: Clean install
						if (configUpdates.length > 0 || regularUpdates.length > 0 || configUpdatesFromPnpm.length > 0) {
							yield* Effect.logInfo("Step 6: Running clean install");
							const runner = yield* CommandRunner;
							yield* runner.execCapture("sh", ["-c", "rm -rf node_modules pnpm-lock.yaml"]);
							yield* runner.exec("pnpm", ["install"]);
						}

						// Step 9: Format pnpm-workspace.yaml
						yield* Effect.logInfo("Step 7: Formatting pnpm-workspace.yaml");
						yield* formatWorkspaceYaml();

						const workspaceAfter = yield* readWorkspaceYaml().pipe(Effect.catchAll(() => Effect.succeed(null)));
						yield* Effect.logDebug(`pnpm-workspace.yaml (after): ${JSON.stringify(workspaceAfter)}`);

						// Step 10: Run custom commands (if specified)
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

						// Step 11: Capture lockfile state after updates
						yield* Effect.logInfo("Step 9: Capturing lockfile state (after)");
						const lockfileAfter = yield* captureLockfileState();
						yield* Effect.logDebug(
							`Lockfile state (after): ${JSON.stringify({
								packages: Object.keys(lockfileAfter?.packages || {}).length,
								importers: Object.keys(lockfileAfter?.importers || {}).length,
							})}`,
						);

						// Step 12: Detect changes
						yield* Effect.logInfo("Step 10: Detecting changes");
						const changes = yield* compareLockfiles(lockfileBefore, lockfileAfter);
						yield* Effect.logDebug(`Detected changes: ${JSON.stringify(changes)}`);

						const allUpdates = [...configUpdatesFromPnpm, ...configUpdates, ...regularUpdates];
						yield* Effect.logDebug(
							`Total updates: ${allUpdates.length} (config: ${configUpdates.length + configUpdatesFromPnpm.length}, regular: ${regularUpdates.length})`,
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

						// Step 13: Create changesets (if enabled)
						let changesets: ReadonlyArray<ChangesetFile> = [];
						if (inputs.changesets) {
							yield* Effect.logInfo("Step 11: Creating changesets");

							const configChangesForChangeset = [...configUpdatesFromPnpm, ...configUpdates].map((u) => ({
								type: "config" as const,
								dependency: u.dependency,
								from: u.from,
								to: u.to,
								affectedPackages: [] as string[],
							}));

							const allChangesForChangeset = [...configChangesForChangeset, ...changes];
							changesets = yield* createChangesets(allChangesForChangeset);
						} else {
							yield* Effect.logInfo("Step 11: Skipping changesets (disabled)");
						}

						// Step 14: Commit and push
						const report = yield* Report;
						if (dryRun) {
							yield* Effect.logInfo("Step 12: [DRY RUN] Skipping commit and push");
						} else {
							yield* Effect.logInfo("Step 12: Committing via GitHub API");
							const commitMessage = report.generateCommitMessage(allUpdates);
							yield* branchManager.commitChanges(commitMessage, inputs.branch);
						}

						// Step 15: Create/update PR
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

// Run the main action
Action.run(
	program.pipe(
		Effect.catchAll((error) =>
			Effect.gen(function* () {
				const outs = yield* ActionOutputs;
				const message = error instanceof Error ? error.message : String(error);
				yield* outs.setFailed(`Action failed: ${message}`);
			}),
		),
	),
	GitHubAppLive,
);
/* v8 ignore stop */
