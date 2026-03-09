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
	AutoMerge,
	CheckRun,
	CheckRunLive,
	CommandRunner,
	CommandRunnerLive,
	DryRunLive,
	GitBranchLive,
	GitCommitLive,
	GitHubApp,
	GitHubAppLive,
	GitHubClient,
	GitHubClientLive,
	GitHubGraphQLLive,
} from "@savvy-web/github-action-effects";
import { Duration, Effect, Layer, Schema } from "effect";

import { createChangesets } from "./lib/changeset/create.js";
import { commitChanges, manageBranch } from "./lib/github/branch.js";
import { captureLockfileState, compareLockfiles } from "./lib/lockfile/compare.js";
import { updateConfigDeps } from "./lib/pnpm/config.js";
import { formatWorkspaceYaml, readWorkspaceYaml } from "./lib/pnpm/format.js";
import { updateRegularDeps } from "./lib/pnpm/regular.js";
import { upgradePnpm } from "./lib/pnpm/upgrade.js";
import type { ChangesetFile, DependencyUpdateResult, PullRequest } from "./types/index.js";

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
 * Create or update the dependency update PR.
 */
export const createOrUpdatePR = (
	branch: string,
	updates: ReadonlyArray<DependencyUpdateResult>,
	changesets: ReadonlyArray<ChangesetFile>,
): Effect.Effect<PullRequest, never, GitHubClient> =>
	Effect.gen(function* () {
		const client = yield* GitHubClient;
		const { owner, repo } = yield* client.repo;

		const title = "chore(deps): update pnpm config dependencies";
		const body = generatePRBody(updates, changesets);

		// Check if PR already exists
		const existingPR = yield* client
			.rest("pulls.list", (octokit) =>
				(
					octokit as {
						rest: {
							pulls: {
								list: (
									opts: Record<string, unknown>,
								) => Promise<{ data: Array<{ number: number; html_url: string; node_id: string }> }>;
							};
						};
					}
				).rest.pulls
					.list({
						owner,
						repo,
						head: `${owner}:${branch}`,
						base: "main",
						state: "open",
					})
					.then((r) =>
						r.data.length > 0
							? {
									number: r.data[0].number,
									url: r.data[0].html_url,
									nodeId: r.data[0].node_id,
								}
							: null,
					)
					.then((data) => ({ data })),
			)
			.pipe(Effect.catchAll(() => Effect.succeed(null)));

		if (existingPR) {
			yield* Effect.logInfo(`Updating existing PR #${existingPR.number}`);
			yield* client
				.rest("pulls.update", (octokit) =>
					(
						octokit as { rest: { pulls: { update: (opts: Record<string, unknown>) => Promise<{ data: unknown }> } } }
					).rest.pulls.update({
						owner,
						repo,
						pull_number: existingPR.number,
						title,
						body,
					}),
				)
				.pipe(Effect.catchAll(() => Effect.void));
			return {
				number: existingPR.number,
				url: existingPR.url,
				created: false,
				nodeId: existingPR.nodeId,
			} as PullRequest;
		}

		yield* Effect.logInfo("Creating new PR");
		const pr = yield* client
			.rest("pulls.create", (octokit) =>
				(
					octokit as {
						rest: {
							pulls: {
								create: (
									opts: Record<string, unknown>,
								) => Promise<{ data: { number: number; html_url: string; node_id: string } }>;
							};
						};
					}
				).rest.pulls.create({
					owner,
					repo,
					title,
					body,
					head: branch,
					base: "main",
				}),
			)
			.pipe(
				Effect.map(
					(data) =>
						({
							number: data.number,
							url: data.html_url,
							created: true,
							nodeId: data.node_id,
						}) as PullRequest,
				),
				Effect.catchAll(() =>
					Effect.succeed({ number: 0, url: "", created: false, nodeId: "" } as unknown as PullRequest),
				),
			);

		if (pr.number > 0) {
			yield* Effect.logInfo(`Created PR #${pr.number}: ${pr.url}`);
		}
		return pr;
	});

/**
 * Generate commit message for dependency updates.
 *
 * Uses the app slug to attribute the sign-off to the correct bot.
 * When commits are created via the GitHub API without an explicit author,
 * and include a matching sign-off footer, GitHub will verify/sign the commit.
 */
export const generateCommitMessage = (updates: ReadonlyArray<DependencyUpdateResult>, appSlug?: string): string => {
	const configCount = updates.filter((u) => u.type === "config").length;
	const regularCount = updates.filter((u) => u.type === "regular").length;

	const parts: string[] = [];
	if (configCount > 0) parts.push(`${configCount} config`);
	if (regularCount > 0) parts.push(`${regularCount} regular`);

	const botName = appSlug ? `${appSlug}[bot]` : "github-actions[bot]";
	const botEmail = appSlug
		? `${appSlug}[bot]@users.noreply.github.com`
		: "41898282+github-actions[bot]@users.noreply.github.com";

	return `chore(deps): update ${parts.join(" and ")} dependencies

Updated dependencies:
${updates.map((u) => `- ${u.dependency}: ${u.from ?? "new"} -> ${u.to}`).join("\n")}

Signed-off-by: ${botName} <${botEmail}>`;
};

/**
 * Generate npm package URL.
 */
export const npmUrl = (pkg: string): string => `https://www.npmjs.com/package/${pkg}`;

/**
 * Extract clean version from pnpm version string (removes hash suffix).
 */
export const cleanVersion = (version: string | null): string | null => {
	if (!version) return null;
	// Remove +sha512-... suffix if present
	return version.split("+")[0];
};

/**
 * Generate PR body with dependency changes (Dependabot-style formatting).
 */
export const generatePRBody = (
	updates: ReadonlyArray<DependencyUpdateResult>,
	changesets: ReadonlyArray<ChangesetFile>,
): string => {
	const lines: string[] = [];

	const configUpdates = updates.filter((u) => u.type === "config");
	const regularUpdates = updates.filter((u) => u.type === "regular");

	// Title section
	lines.push("## Dependency Updates");
	lines.push("");

	// Summary line
	const parts: string[] = [];
	if (configUpdates.length > 0) parts.push(`${configUpdates.length} config`);
	if (regularUpdates.length > 0) parts.push(`${regularUpdates.length} regular`);
	lines.push(`Updates ${parts.join(" and ")} ${parts.length > 1 ? "dependencies" : "dependency"}.`);
	lines.push("");

	// Config dependencies section
	if (configUpdates.length > 0) {
		lines.push("### Config Dependencies");
		lines.push("");
		lines.push("| Package | From | To |");
		lines.push("|---------|------|-----|");
		for (const update of configUpdates) {
			const from = cleanVersion(update.from) ?? "_new_";
			const to = cleanVersion(update.to);
			lines.push(`| [\`${update.dependency}\`](${npmUrl(update.dependency)}) | ${from} | ${to} |`);
		}
		lines.push("");
	}

	// Regular dependencies section
	if (regularUpdates.length > 0) {
		lines.push("### Regular Dependencies");
		lines.push("");
		lines.push("| Package | From | To |");
		lines.push("|---------|------|-----|");
		for (const update of regularUpdates) {
			const from = update.from ?? "_new_";
			const to = update.to;
			const pkgLink = update.dependency.includes("*")
				? `\`${update.dependency}\``
				: `[\`${update.dependency}\`](${npmUrl(update.dependency)})`;
			lines.push(`| ${pkgLink} | ${from} | ${to} |`);
		}
		lines.push("");
	}

	// Changesets section - one expandable per affected package/workspace
	if (changesets.length > 0) {
		lines.push("### Changesets");
		lines.push("");
		lines.push(`${changesets.length} changeset(s) created for version management.`);
		lines.push("");
		for (const cs of changesets) {
			// Empty changesets are for root workspace config deps
			const isRootWorkspace = cs.packages.length === 0;
			const label = isRootWorkspace ? "root workspace" : cs.packages.join(", ");

			lines.push("<details>");
			lines.push(`<summary>${label}</summary>`);
			lines.push("");
			lines.push(`**Changeset:** \`${cs.id}\``);
			lines.push(`**Type:** ${cs.type}`);
			lines.push("");
			lines.push("```");
			lines.push(cs.summary);
			lines.push("```");
			lines.push("");
			lines.push("</details>");
			lines.push("");
		}
	}

	// Footer
	lines.push("---");
	lines.push("");
	lines.push(
		"_This PR was automatically created by [pnpm-config-dependency-action](https://github.com/savvy-web/pnpm-config-dependency-action)_",
	);

	return lines.join("\n");
};

/**
 * Generate summary text for check run and job summary.
 */
export const generateSummary = (
	updates: ReadonlyArray<DependencyUpdateResult>,
	changesets: ReadonlyArray<ChangesetFile>,
	pr: PullRequest | null,
	dryRun: boolean,
): string => {
	const lines: string[] = [];

	lines.push("### Summary");
	lines.push("");
	lines.push(`- **Dependencies updated:** ${updates.length}`);
	lines.push(`- **Changesets created:** ${changesets.length}`);

	if (pr && pr.number > 0) {
		lines.push(`- **Pull request:** [#${pr.number}](${pr.url})`);
	}

	lines.push("");
	lines.push("### Updated Dependencies");
	lines.push("");

	const configUpdates = updates.filter((u) => u.type === "config");
	const regularUpdates = updates.filter((u) => u.type === "regular");

	if (configUpdates.length > 0) {
		lines.push("#### Config Dependencies");
		lines.push("");
		lines.push("| Package | From | To |");
		lines.push("|---------|------|-----|");
		for (const update of configUpdates) {
			const from = cleanVersion(update.from) ?? "_new_";
			const to = cleanVersion(update.to);
			lines.push(`| \`${update.dependency}\` | ${from} | ${to} |`);
		}
		lines.push("");
	}

	if (regularUpdates.length > 0) {
		lines.push("#### Regular Dependencies");
		lines.push("");
		lines.push("| Package | From | To |");
		lines.push("|---------|------|-----|");
		for (const update of regularUpdates) {
			const from = update.from ?? "_new_";
			const to = update.to;
			lines.push(`| \`${update.dependency}\` | ${from} | ${to} |`);
		}
		lines.push("");
	}

	// Show changeset details - one expandable per affected package/workspace
	if (changesets.length > 0) {
		lines.push("### Changesets Created");
		lines.push("");
		for (const cs of changesets) {
			const isRootWorkspace = cs.packages.length === 0;
			const label = isRootWorkspace ? "root workspace" : cs.packages.join(", ");

			lines.push("<details>");
			lines.push(`<summary>${label}</summary>`);
			lines.push("");
			lines.push(`**Changeset:** \`${cs.id}\``);
			lines.push("");
			lines.push("```");
			lines.push(cs.summary);
			lines.push("```");
			lines.push("");
			lines.push("</details>");
			lines.push("");
		}
	}

	// In dry-run mode, show what the PR body would look like
	if (dryRun && updates.length > 0) {
		lines.push("### PR Body Preview");
		lines.push("");
		lines.push("This is what the PR body would look like:");
		lines.push("");
		lines.push("<details>");
		lines.push("<summary>View PR body</summary>");
		lines.push("");
		lines.push(generatePRBody(updates, changesets));
		lines.push("");
		lines.push("</details>");
	}

	return lines.join("\n");
};

/**
 * Main action program.
 *
 * Single-phase entry point that handles token lifecycle, check runs,
 * and the full dependency update workflow.
 */
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
				// Build all dependent layers from the token
				const ghClient = GitHubClientLive(token);
				const appLayer = Layer.mergeAll(
					ghClient,
					GitBranchLive.pipe(Layer.provide(ghClient)),
					GitCommitLive.pipe(Layer.provide(ghClient)),
					CheckRunLive.pipe(Layer.provide(ghClient)),
					GitHubGraphQLLive.pipe(Layer.provide(ghClient)),
					CommandRunnerLive,
					DryRunLive(dryRun),
				);

				yield* Effect.provide(innerProgram(inputs, dryRun), appLayer);
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
) =>
	Effect.gen(function* () {
		const outputs = yield* ActionOutputs;
		const checkRunService = yield* CheckRun;
		const headSha = context.sha;

		// Create check run for visibility
		const checkRunName = dryRun ? "Dependency Updates (Dry Run)" : "Dependency Updates";

		yield* checkRunService.withCheckRun(checkRunName, headSha, (checkRunId) =>
			Effect.gen(function* () {
				// Step 3: Manage branch
				yield* Effect.logInfo("Step 1: Managing branch");
				const branchResult = yield* manageBranch(inputs.branch, "main");
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
					const pnpmUpgrade = yield* upgradePnpm().pipe(
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

				const configUpdates = yield* updateConfigDeps(inputs["config-dependencies"]);
				yield* Effect.logDebug(`Config dependency updates: ${JSON.stringify(configUpdates)}`);

				// Step 7: Update regular dependencies
				yield* Effect.logInfo("Step 5: Updating regular dependencies");
				const regularUpdates = yield* updateRegularDeps(inputs.dependencies);

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
				if (dryRun) {
					yield* Effect.logInfo("Step 12: [DRY RUN] Skipping commit and push");
				} else {
					yield* Effect.logInfo("Step 12: Committing via GitHub API");
					const commitMessage = generateCommitMessage(allUpdates);
					yield* commitChanges(commitMessage, inputs.branch);
				}

				// Step 15: Create/update PR
				let pr: PullRequest | null = null;
				if (dryRun) {
					yield* Effect.logInfo("Step 13: [DRY RUN] Skipping PR creation/update");
				} else {
					yield* Effect.logInfo("Step 13: Creating/updating PR");
					const client = yield* GitHubClient;
					pr = yield* createOrUpdatePR(inputs.branch, allUpdates, changesets).pipe(
						Effect.provide(Layer.succeed(GitHubClient, client)),
					);

					// Enable auto-merge if configured
					if (inputs["auto-merge"] && pr && pr.nodeId) {
						const mergeMethod = inputs["auto-merge"].toUpperCase() as "MERGE" | "SQUASH" | "REBASE";
						yield* AutoMerge.enable(pr.nodeId, mergeMethod).pipe(
							Effect.tap(() => Effect.logInfo(`Auto-merge enabled (${inputs["auto-merge"]})`)),
							Effect.catchAll((error) =>
								Effect.logWarning(
									`Failed to enable auto-merge: ${error.reason}. ` +
										`Ensure the repository has "Allow auto-merge" enabled and branch protection rules configured.`,
								),
							),
						);
					}
				}

				// Update check run
				const summaryText = generateSummary(allUpdates, changesets, pr, dryRun);
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
		);
	});

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
