/**
 * Main action script.
 *
 * Orchestrates the dependency update workflow:
 * 1. Parse inputs and setup
 * 2. Manage branch (create/rebase)
 * 3. Capture lockfile state (before)
 * 4. Update config dependencies
 * 5. Run pnpm install
 * 6. Update regular dependencies
 * 7. Format pnpm-workspace.yaml
 * 8. Run custom commands (if specified)
 * 9. Capture lockfile state (after)
 * 10. Detect changes
 * 11. Create changesets (if enabled)
 * 12. Commit and push
 * 13. Create/update PR
 *
 * @module main
 */

import { getState, setFailed, setOutput, summary } from "@actions/core";
import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { createChangesets } from "./lib/changeset/create.js";
import { commitChanges, manageBranch } from "./lib/github/branch.js";
import { isDryRun, parseInputs } from "./lib/inputs.js";
import { captureLockfileState, compareLockfiles } from "./lib/lockfile/compare.js";
import { logDebug, logDebugState } from "./lib/logging.js";
import { formatWorkspaceYaml, getConfigDependencyVersion, readWorkspaceYaml } from "./lib/pnpm/format.js";
import { GitExecutor, GitHubClient, PnpmExecutor, makeAppLayer } from "./lib/services/index.js";
import type { ChangesetFile, DependencyUpdateResult, PullRequest } from "./types/index.js";

/**
 * Main action program.
 */
const program = Effect.gen(function* () {
	yield* Effect.logInfo("Starting pnpm config dependency action");

	// Get token from state (set by pre.ts)
	const token = getState("token");
	if (!token) {
		return yield* Effect.fail(new Error("No token available. Ensure pre.ts ran successfully."));
	}

	// Parse inputs
	const inputs = yield* parseInputs;
	const dryRun = isDryRun();

	yield* logDebug(`Debug mode enabled - verbose logging active`);
	yield* logDebugState("Parsed inputs", {
		branch: inputs.branch,
		configDependencies: inputs.configDependencies,
		dependencies: inputs.dependencies,
		dryRun,
	});

	if (dryRun) {
		yield* Effect.logWarning("Running in dry-run mode - will detect changes but skip commit/push/PR");
	}

	// Create check run for visibility
	const github = yield* GitHubClient;
	const checkRun = yield* github.createCheckRun(dryRun ? "🧪 Dependency Updates (Dry Run)" : "Dependency Updates");

	try {
		// Step 1: Manage branch
		yield* Effect.logInfo("Step 1: Managing branch");
		const branchResult = yield* manageBranch(inputs.branch, "main");
		yield* Effect.logInfo(`Branch: ${branchResult.branch} (created: ${branchResult.created})`);

		// Step 2: Capture lockfile state before updates
		yield* Effect.logInfo("Step 2: Capturing lockfile state (before)");
		const lockfileBefore = yield* captureLockfileState();
		yield* logDebugState("Lockfile state (before)", {
			packages: Object.keys(lockfileBefore?.packages || {}).length,
			importers: Object.keys(lockfileBefore?.importers || {}).length,
		});

		// Step 3: Update config dependencies
		yield* Effect.logInfo("Step 3: Updating config dependencies");
		const workspaceBefore = yield* readWorkspaceYaml().pipe(Effect.catchAll(() => Effect.succeed(null)));
		yield* logDebugState("pnpm-workspace.yaml (before)", workspaceBefore);

		const configUpdates = yield* updateConfigDependencies(inputs.configDependencies);
		yield* logDebugState("Config dependency updates", configUpdates);

		// Step 4: Run pnpm install
		if (configUpdates.length > 0 || inputs.dependencies.length > 0) {
			yield* Effect.logInfo("Step 4: Running pnpm install");
			const pnpm = yield* PnpmExecutor;
			yield* pnpm.install();
		}

		// Step 5: Update regular dependencies
		yield* Effect.logInfo("Step 5: Updating regular dependencies");
		const regularUpdates = yield* updateRegularDependencies(inputs.dependencies);

		// Step 6: Format pnpm-workspace.yaml
		yield* Effect.logInfo("Step 6: Formatting pnpm-workspace.yaml");
		yield* formatWorkspaceYaml();

		const workspaceAfter = yield* readWorkspaceYaml().pipe(Effect.catchAll(() => Effect.succeed(null)));
		yield* logDebugState("pnpm-workspace.yaml (after)", workspaceAfter);

		// Step 7: Run custom commands (if specified)
		let runCommandsResult: RunCommandsResult | null = null;
		if (inputs.run.length > 0) {
			yield* Effect.logInfo("Step 7: Running custom commands");
			runCommandsResult = yield* runCommands(inputs.run);

			if (runCommandsResult.failed.length > 0) {
				const failedCommands = runCommandsResult.failed.map((f) => f.command).join(", ");
				yield* Effect.logError(`${runCommandsResult.failed.length} command(s) failed: ${failedCommands}`);

				// Update check run with failure details
				const failureDetails = runCommandsResult.failed.map((f) => `- \`${f.command}\`: ${f.error}`).join("\n");

				yield* github.updateCheckRun(
					checkRun.id,
					"completed",
					"failure",
					`Custom commands failed:\n\n${failureDetails}`,
				);

				setOutput("has-changes", "false");
				setOutput("updates-count", "0");

				return yield* Effect.fail(new Error(`Custom commands failed: ${failedCommands}`));
			}
		}

		// Step 8: Capture lockfile state after updates
		yield* Effect.logInfo("Step 8: Capturing lockfile state (after)");
		const lockfileAfter = yield* captureLockfileState();
		yield* logDebugState("Lockfile state (after)", {
			packages: Object.keys(lockfileAfter?.packages || {}).length,
			importers: Object.keys(lockfileAfter?.importers || {}).length,
		});

		// Step 9: Detect changes
		yield* Effect.logInfo("Step 9: Detecting changes");
		const changes = yield* compareLockfiles(lockfileBefore, lockfileAfter);
		yield* logDebugState("Detected changes", changes);

		const allUpdates = [...configUpdates, ...regularUpdates];
		yield* logDebug(
			`Total updates: ${allUpdates.length} (config: ${configUpdates.length}, regular: ${regularUpdates.length})`,
		);

		// Check if there are any changes
		const git = yield* GitExecutor;
		const gitStatus = yield* git.status();
		yield* logDebugState("Git status", gitStatus);

		if (!gitStatus.hasChanges && changes.length === 0) {
			yield* Effect.logInfo("No dependency updates available");

			// Update check run
			yield* github.updateCheckRun(
				checkRun.id,
				"completed",
				"neutral",
				"No dependency updates available. All dependencies are up-to-date.",
			);

			setOutput("has-changes", "false");
			setOutput("updates-count", "0");

			return;
		}

		// Step 10: Create changesets (if enabled)
		yield* Effect.logInfo("Step 10: Creating changesets");

		// Merge config dependency updates into changes for changeset creation
		// Config updates need to be converted to LockfileChange format
		const configChangesForChangeset = configUpdates.map((u) => ({
			type: "config" as const,
			dependency: u.dependency,
			from: u.from,
			to: u.to,
			affectedPackages: [] as string[],
		}));

		const allChangesForChangeset = [...configChangesForChangeset, ...changes];
		const changesets = yield* createChangesets(allChangesForChangeset);

		// Step 11: Commit and push
		if (dryRun) {
			yield* Effect.logInfo("Step 11: [DRY RUN] Skipping commit and push");
		} else {
			yield* Effect.logInfo("Step 11: Committing via GitHub API");
			const commitMessage = generateCommitMessage(allUpdates);
			yield* commitChanges(commitMessage, inputs.branch);
		}

		// Step 12: Create/update PR
		let pr: PullRequest | null = null;
		if (dryRun) {
			yield* Effect.logInfo("Step 12: [DRY RUN] Skipping PR creation/update");
		} else {
			yield* Effect.logInfo("Step 12: Creating/updating PR");
			pr = yield* createOrUpdatePR(inputs.branch, allUpdates, changesets);
		}

		// Update check run
		const summaryText = generateSummary(allUpdates, changesets, pr, dryRun);
		yield* github.updateCheckRun(checkRun.id, "completed", "success", summaryText);

		// Set outputs
		setOutput("has-changes", "true");
		setOutput("updates-count", String(allUpdates.length));
		if (pr) {
			setOutput("pr-number", String(pr.number));
			setOutput("pr-url", pr.url);
		}

		// Write job summary
		yield* Effect.sync(() => {
			summary.addHeading("📦 Dependency Updates", 1);
			if (dryRun) {
				summary.addRaw("> 🧪 **DRY RUN MODE** - Changes detected but not committed/pushed\n\n");
			}
			summary.addRaw(summaryText);
			summary.write();
		});

		yield* Effect.logInfo("Dependency update action completed successfully");
	} catch (error) {
		// Update check run on failure
		yield* github.updateCheckRun(
			checkRun.id,
			"completed",
			"failure",
			`Action failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		throw error;
	}
});

/**
 * Update config dependencies with error accumulation.
 */
const updateConfigDependencies = (
	dependencies: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<DependencyUpdateResult>, never, PnpmExecutor> =>
	Effect.gen(function* () {
		if (dependencies.length === 0) {
			return [];
		}

		const pnpm = yield* PnpmExecutor;
		const results: DependencyUpdateResult[] = [];

		for (const dep of dependencies) {
			yield* Effect.logInfo(`Updating config dependency: ${dep}`);

			// Get version before update
			const versionBefore = yield* getConfigDependencyVersion(dep).pipe(Effect.catchAll(() => Effect.succeed(null)));

			// Run pnpm add --config
			const result = yield* pnpm.addConfig(dep).pipe(
				Effect.map(() => ({ success: true as const, output: "" })),
				Effect.catchAll((error) =>
					Effect.gen(function* () {
						yield* Effect.logWarning(`Failed to update ${dep}: ${error.stderr}`);
						return { success: false as const, output: error.stderr };
					}),
				),
			);

			if (result.success) {
				// Get version after update
				const versionAfter = yield* getConfigDependencyVersion(dep).pipe(
					Effect.catchAll(() => Effect.succeed("unknown")),
				);

				results.push({
					dependency: dep,
					from: versionBefore,
					to: versionAfter ?? "unknown",
					type: "config",
					package: null,
				});

				yield* Effect.logInfo(`Updated ${dep}: ${versionBefore ?? "new"} -> ${versionAfter}`);
			}
		}

		return results;
	});

/**
 * Update regular dependencies with error accumulation.
 */
const updateRegularDependencies = (
	dependencies: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<DependencyUpdateResult>, never, PnpmExecutor> =>
	Effect.gen(function* () {
		if (dependencies.length === 0) {
			return [];
		}

		const pnpm = yield* PnpmExecutor;
		const results: DependencyUpdateResult[] = [];

		for (const pattern of dependencies) {
			yield* Effect.logInfo(`Updating dependencies matching: ${pattern}`);

			// Run pnpm up --latest
			const result = yield* pnpm.update(pattern).pipe(
				Effect.map((output) => ({ success: true as const, output })),
				Effect.catchAll((error) =>
					Effect.gen(function* () {
						yield* Effect.logWarning(`Failed to update ${pattern}: ${error.stderr}`);
						return { success: false as const, output: error.stderr };
					}),
				),
			);

			if (result.success) {
				results.push({
					dependency: pattern,
					from: null,
					to: "latest",
					type: "regular",
					package: null,
				});

				yield* Effect.logInfo(`Updated dependencies matching: ${pattern}`);
			}
		}

		return results;
	});

/**
 * Result of running custom commands.
 */
interface RunCommandsResult {
	readonly successful: ReadonlyArray<string>;
	readonly failed: ReadonlyArray<{ command: string; error: string; exitCode?: number }>;
}

/**
 * Run custom commands after dependency updates.
 *
 * Commands are executed sequentially. All commands are attempted even if some fail,
 * but failures are collected and returned for the caller to handle.
 */
const runCommands = (commands: ReadonlyArray<string>): Effect.Effect<RunCommandsResult, never, PnpmExecutor> =>
	Effect.gen(function* () {
		const pnpm = yield* PnpmExecutor;
		const successful: string[] = [];
		const failed: Array<{ command: string; error: string; exitCode?: number }> = [];

		for (const command of commands) {
			yield* Effect.logInfo(`Running: ${command}`);

			const result = yield* pnpm.run(command).pipe(
				Effect.map(() => ({ success: true as const })),
				Effect.catchAll((error: { stderr?: string; exitCode?: number }) =>
					Effect.succeed({
						success: false as const,
						error: error.stderr ?? "Unknown error",
						exitCode: error.exitCode,
					}),
				),
			);

			if (result.success) {
				yield* Effect.logInfo(`Command completed: ${command}`);
				successful.push(command);
			} else {
				yield* Effect.logError(`Command failed: ${command}`);
				yield* logDebugState("Command error", { command, stderr: result.error, exitCode: result.exitCode });
				failed.push({ command, error: result.error, exitCode: result.exitCode });
			}
		}

		return { successful, failed };
	});

/**
 * Create or update the dependency update PR.
 */
const createOrUpdatePR = (
	branch: string,
	updates: ReadonlyArray<DependencyUpdateResult>,
	changesets: ReadonlyArray<ChangesetFile>,
): Effect.Effect<PullRequest, never, GitHubClient> =>
	Effect.gen(function* () {
		const github = yield* GitHubClient;

		// Check if PR already exists
		const existingPR = yield* github.findPR(branch, "main").pipe(Effect.catchAll(() => Effect.succeed(null)));

		const title = "chore(deps): update pnpm config dependencies";
		const body = generatePRBody(updates, changesets);

		if (existingPR) {
			yield* Effect.logInfo(`Updating existing PR #${existingPR.number}`);
			yield* github.updatePR(existingPR.number, { title, body }).pipe(Effect.catchAll(() => Effect.void));
			return { ...existingPR, created: false };
		}

		yield* Effect.logInfo("Creating new PR");
		const pr = yield* github
			.createPR({
				title,
				body,
				head: branch,
				base: "main",
			})
			.pipe(Effect.catchAll(() => Effect.succeed({ number: 0, url: "", created: false } as PullRequest)));

		if (pr.number > 0) {
			yield* Effect.logInfo(`Created PR #${pr.number}: ${pr.url}`);
		}
		return pr;
	});

/**
 * Generate commit message for dependency updates.
 *
 * Uses the app slug from state to attribute the sign-off to the correct bot.
 * When commits are created via the GitHub API without an explicit author,
 * and include a matching sign-off footer, GitHub will verify/sign the commit.
 */
const generateCommitMessage = (updates: ReadonlyArray<DependencyUpdateResult>): string => {
	const configCount = updates.filter((u) => u.type === "config").length;
	const regularCount = updates.filter((u) => u.type === "regular").length;

	const parts: string[] = [];
	if (configCount > 0) parts.push(`${configCount} config`);
	if (regularCount > 0) parts.push(`${regularCount} regular`);

	// Use app slug from state for proper attribution
	const appSlug = getState("appSlug");
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
const npmUrl = (pkg: string): string => `https://www.npmjs.com/package/${pkg}`;

/**
 * Extract clean version from pnpm version string (removes hash suffix).
 */
const cleanVersion = (version: string | null): string | null => {
	if (!version) return null;
	// Remove +sha512-... suffix if present
	return version.split("+")[0];
};

/**
 * Generate PR body with dependency changes (Dependabot-style formatting).
 */
const generatePRBody = (
	updates: ReadonlyArray<DependencyUpdateResult>,
	changesets: ReadonlyArray<ChangesetFile>,
): string => {
	const lines: string[] = [];

	const configUpdates = updates.filter((u) => u.type === "config");
	const regularUpdates = updates.filter((u) => u.type === "regular");

	// Title section
	lines.push("## 📦 Dependency Updates");
	lines.push("");

	// Summary line
	const parts: string[] = [];
	if (configUpdates.length > 0) parts.push(`${configUpdates.length} config`);
	if (regularUpdates.length > 0) parts.push(`${regularUpdates.length} regular`);
	lines.push(`Updates ${parts.join(" and ")} ${parts.length > 1 ? "dependencies" : "dependency"}.`);
	lines.push("");

	// Config dependencies section
	if (configUpdates.length > 0) {
		lines.push("### 🔧 Config Dependencies");
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
		lines.push("### 📦 Regular Dependencies");
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
		lines.push("### 📝 Changesets");
		lines.push("");
		lines.push(`${changesets.length} changeset(s) created for version management.`);
		lines.push("");
		for (const cs of changesets) {
			// Empty changesets are for root workspace config deps
			const isRootWorkspace = cs.packages.length === 0;
			const label = isRootWorkspace ? "root workspace" : cs.packages.join(", ");
			const icon = isRootWorkspace ? "🔧" : "📦";

			lines.push("<details>");
			lines.push(`<summary>${icon} ${label}</summary>`);
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
const generateSummary = (
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
		lines.push("#### 🔧 Config Dependencies");
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
		lines.push("#### 📦 Regular Dependencies");
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
		lines.push("### 📝 Changesets Created");
		lines.push("");
		for (const cs of changesets) {
			const isRootWorkspace = cs.packages.length === 0;
			const label = isRootWorkspace ? "root workspace" : cs.packages.join(", ");
			const icon = isRootWorkspace ? "🔧" : "📦";

			lines.push(`<details>`);
			lines.push(`<summary>${icon} ${label}</summary>`);
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
		lines.push("### 📋 PR Body Preview");
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
 * Run the main program with the application layer.
 */
const runnable = Effect.gen(function* () {
	const token = getState("token");
	if (!token) {
		setFailed("No token available. Ensure pre.ts ran successfully.");
		return;
	}

	const appLayer = makeAppLayer(token);

	yield* program.pipe(
		Effect.provide(appLayer),
		Effect.catchAll((error) =>
			Effect.sync(() => {
				const message = error instanceof Error ? error.message : String(error);
				setFailed(`Action failed: ${message}`);
			}),
		),
	);
});

// Run the main action
NodeRuntime.runMain(runnable);
