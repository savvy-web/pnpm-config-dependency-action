/**
 * Action program and utilities.
 *
 * Contains the main Effect program and helper functions, separated from
 * the entry point (`main.ts`) so tests can import without triggering
 * module-level `Action.run` execution.
 *
 * @module program
 */

import { CheckRun, CheckRunOutput } from "@effected/github";
import { ActionEnvironment, ActionOutputs } from "@effected/github-actions";
import { Duration, Effect, References } from "effect";
import { formatCatalogCountsCompact, groupCatalogDeltas } from "./format.js";
import { makeAppLayer } from "./layers/app.js";
import type { InnerProgramInputs } from "./schema/inputs.js";
import { readInputs } from "./schema/inputs.js";
import { emitOutputs, initialOutputs } from "./schema/outputs.js";
import { LOCKFILE_NAMES, compareLockfiles } from "./services/lockfile.js";
import { Report } from "./services/report.js";
import { readWorkspaceYaml } from "./services/workspace-yaml.js";
import { branchStep } from "./steps/branch.js";
import { changesetsStep } from "./steps/changesets.js";
import { commitAndPrStep } from "./steps/commit-and-pr.js";
import { configDependenciesStep } from "./steps/config-dependencies.js";
import { customCommandsStep, failedCommandNames, formatCommandFailures } from "./steps/custom-commands.js";
import { detectChangesStep } from "./steps/detect-changes.js";
import { detectPackageManagerStep } from "./steps/detect-package-manager.js";
import { formatWorkspaceStep } from "./steps/format-workspace.js";
import { installStep } from "./steps/install.js";
import { lockfileSnapshotStep } from "./steps/lockfile-snapshot.js";
import { peerSyncStep } from "./steps/peer-sync.js";
import { regularDependenciesStep } from "./steps/regular-dependencies.js";
import { upgradePackageManagerStep } from "./steps/upgrade-package-manager.js";
import { upgradeRuntimesStep } from "./steps/upgrade-runtimes.js";

/**
 * Main action program (the `main` phase).
 *
 * Orchestrates the full dependency-update workflow: input parsing, the check
 * run, and the update steps. The GitHub App token lifecycle lives in the
 * pre/post phases — provisioned via `GitHubToken.provision` in `pre.ts` and
 * read here through the app layer's `GitHubToken.client()`.
 */
/* v8 ignore start -- real layer wiring; exercised end-to-end on the runner, not in-process */
export const program = Effect.gen(function* () {
	yield* Effect.logInfo("Starting Silk Update Action");

	// Publish the all-disabled baseline BEFORE any work, so every declared output
	// has a value on every exit path — including a failure in `readInputs` itself,
	// which is the earliest thing that can abort the run.
	//
	// Emitted first rather than from `Effect.onError`, deliberately. A failure
	// handler that re-emits the baseline also OVERWRITES anything a step already
	// published: a run that opened a PR and then failed later would report
	// `pr-number: ""` and `has-changes: false`, which is not a conservative
	// default, it is a false statement about work that actually happened. Writing
	// the baseline up front and letting steps refine it gives the same guarantee
	// with no lying.
	yield* emitOutputs(initialOutputs);

	const { inputs, dryRun, timeout, runtimeLive } = yield* readInputs;

	// Resolve log level: normal (info) or debug when step debug logging is
	// enabled on the runner (RUNNER_DEBUG=1 via ACTIONS_STEP_DEBUG). The kit has
	// no Action.resolveLogLevel — ActionEnvironment.isDebug is the seam that
	// reads the runner flag.
	const env = yield* ActionEnvironment;
	const effectLogLevel = (yield* env.isDebug) ? "Debug" : "Info";

	yield* Effect.logDebug("Debug mode enabled - verbose logging active");
	yield* Effect.logDebug(
		`Parsed inputs: ${JSON.stringify({
			branch: inputs.branch,
			configDependencies: inputs["config-dependencies"],
			dependencies: inputs.dependencies,
			peerLock: inputs["peer-lock"],
			peerMinor: inputs["peer-minor"],
			upgradePackageManager: inputs["upgrade-package-manager"],
			dryRun,
		})}`,
	);

	if (dryRun) {
		yield* Effect.logWarning("Running in dry-run mode - will detect changes but skip commit/push/PR");
	}

	// Read head SHA and run the main workflow. The GitHub App installation token
	// was provisioned in the pre phase and is read back inside the app layer via
	// GitHubToken.clientLayer(); no token plumbing happens here.
	const github = yield* env.github;
	const headSha = github.sha;

	const appLayer = makeAppLayer(dryRun, { runtimeLive });
	yield* innerProgram(inputs, dryRun, headSha, appLayer)
		.pipe(Effect.provideService(References.MinimumLogLevel, effectLogLevel))
		.pipe(
			Effect.timeoutOrElse({
				duration: Duration.seconds(timeout),
				orElse: () => Effect.fail(new Error(`Action timed out after ${timeout} seconds`)),
			}),
		);
});
/* v8 ignore stop */

/**
 * Inner program that runs with all services provided.
 *
 * Every step is named, not numbered — there is no fixed sequence once the
 * package manager, config-dependency and install steps each dispatch on the
 * detected package manager. A step that does not run always logs that it
 * did not, and why: `changesets: false`, "no .changeset/ directory" and
 * "nothing to install" must never look like silence. Decisions (which path a
 * dispatch point took, and on what evidence; a resolution's input range,
 * resolved value, current value and verdict) are logged at info; per-item
 * evidence (registry queries, per-file writes) stays at debug so the info
 * stream reads end to end as a decision log.
 *
 * Exported for testability — `program.inner.test.ts` drives it directly with a
 * fake app layer (mock domain services, the library's in-memory ActionOutputs /
 * CheckRun test layers, and the real upstream WorkspaceRoot /
 * PackageManagerDetector over a temp-dir fixture) and captures the log stream to
 * assert on the decisions above: which package manager each dispatch point
 * routed to, that the install and workspace-format gates opened only when they
 * should, that every skipped step said so with a reason, and that an
 * unsatisfiable `upgrade-package-manager` range warns rather than passing for a
 * routine skip.
 */
export const innerProgram = (
	inputs: InnerProgramInputs,
	dryRun: boolean,
	headSha: string,
	appLayer: ReturnType<typeof makeAppLayer>,
) =>
	// appLayer is provided ONCE, here. There used to be a second provide inside the
	// withCheckRun callback, justified by "the callback signature requires R =
	// never" — that is false against @effected/github: `withCheckRun` is generic in
	// R (`use: (id, conclude) => Effect<A, E, R>` returning `Effect<A, E |
	// GitHubError, R | Repo>`), so the callback inherits the surrounding context
	// like any other effect and the inner provide was redundant wiring built on a
	// stale claim.
	Effect.provide(
		Effect.gen(function* () {
			const outputs = yield* ActionOutputs;
			const checkRunService = yield* CheckRun;

			// Create check run for visibility
			const checkRunName = dryRun ? "Dependency Updates (Dry Run)" : "Dependency Updates";

			yield* checkRunService.withCheckRun(checkRunName, headSha, (_checkRunId, conclude) =>
				Effect.gen(function* () {
					// Detect the package manager once, up front: every dispatch below
					// (config deps, install, package-manager upgrade) reads this one
					// value. It runs inside withCheckRun — like validateBranches, and
					// for the same reason — so an unsupported workspace (yarn, or no
					// workspace root at all) fails with a check run in the GitHub UI
					// rather than an invisible early exit.
					const { detected, evidence, packageCount } = yield* detectPackageManagerStep();
					const lockfileName = LOCKFILE_NAMES[detected.pm];

					yield* Effect.logInfo("Run context");
					yield* Effect.logInfo(
						`  package manager  ${detected.pm}${detected.version ? ` ${detected.version}` : ""}${
							evidence ? `   (${evidence})` : ""
						}`,
					);
					yield* Effect.logInfo(
						`  workspace root   ${detected.root}${
							packageCount !== null ? ` (${packageCount} package${packageCount === 1 ? "" : "s"})` : ""
						}`,
					);
					yield* Effect.logInfo(`  lockfile         ${lockfileName}`);
					yield* Effect.logInfo(
						`  branches         update ${inputs.branch} ← source ${inputs.sourceBranch} → target ${inputs.targetBranch}`,
					);
					yield* Effect.logInfo(
						`  mode             ${dryRun ? "dry run" : "live"} · changesets ${
							inputs.changesets ? "on" : "off"
						} · runtime data ${inputs.runtimeData}`,
					);

					// ── branch ────────────────────────────────────────────────────
					yield* branchStep(inputs.branch, inputs.sourceBranch, inputs.targetBranch);

					// ── lockfile snapshot (before) ──────────────────────────────────
					// Every step below reads and writes at `detected.root` — the resolved
					// workspace root — not at the process cwd. They are not the same thing:
					// the action can be invoked from a subdirectory of the workspace, and a
					// helper defaulting to `process.cwd()` would then read (and rewrite) the
					// wrong manifests, or none at all.
					const lockfileBefore = yield* lockfileSnapshotStep("before", detected.pm, detected.root);

					// ── package manager ─────────────────────────────────────────────
					const pmOutcome = yield* upgradePackageManagerStep(
						inputs["upgrade-package-manager"],
						detected.pm,
						detected.root,
					);
					const configUpdatesFromPackageManager = pmOutcome.updates;
					const pmSkipReason = pmOutcome.skipReason;

					// ── runtimes ─────────────────────────────────────────────────────
					const runtimeUpdates = (yield* upgradeRuntimesStep(inputs.runtime, detected.root)).updates;

					// ── config dependencies ─────────────────────────────────────────
					const workspaceBefore = yield* readWorkspaceYaml(detected.root).pipe(
						Effect.catch(() => Effect.succeed(null)),
					);
					yield* Effect.logDebug(`pnpm-workspace.yaml (before): ${JSON.stringify(workspaceBefore)}`);

					const configResult = yield* configDependenciesStep(
						inputs["config-dependencies"],
						inputs.dependencies,
						detected.pm,
						detected.root,
					);
					const configUpdates = configResult.updates;
					const configDeltas = configResult.deltas;
					yield* Effect.logDebug(`Config dependency updates: ${JSON.stringify(configUpdates)}`);
					if (configDeltas.length > 0) {
						yield* Effect.logDebug(`Catalog deltas: ${JSON.stringify(configDeltas)}`);
					}

					// ── regular dependencies ────────────────────────────────────────
					const regularUpdates = (yield* regularDependenciesStep(
						inputs.dependencies,
						inputs["config-dependencies"],
						detected.pm,
						detected.root,
					)).updates;

					// ── peer sync ────────────────────────────────────────────────────
					const peerResult = yield* peerSyncStep(
						{ lock: inputs["peer-lock"], minor: inputs["peer-minor"] },
						regularUpdates,
						detected.root,
					);
					const peerUpdates = peerResult.updates;
					const peerConfigured = peerResult.configured;

					// ── install ──────────────────────────────────────────────────────
					const shouldInstall =
						configUpdates.length > 0 ||
						regularUpdates.length > 0 ||
						configUpdatesFromPackageManager.length > 0 ||
						peerUpdates.length > 0;
					yield* installStep(shouldInstall, detected.pm, detected.root);

					// ── workspace formatting ────────────────────────────────────────
					yield* formatWorkspaceStep(detected.pm, detected.root);

					// ── custom commands ─────────────────────────────────────────────
					// The step reports what happened; concluding the check run and
					// publishing outputs stay here, because the run's verdict is a
					// composition concern.
					const commandsResult = yield* customCommandsStep(inputs.run);
					if (commandsResult !== null && commandsResult.failed.length > 0) {
						yield* conclude(
							"failure",
							CheckRunOutput.make({
								title: "Custom Commands Failed",
								summary: `Custom commands failed:\n\n${formatCommandFailures(commandsResult)}`,
							}),
						);

						yield* outputs.set("has-changes", "false");
						yield* outputs.set("updates-count", "0");

						return yield* Effect.fail(new Error(`Custom commands failed: ${failedCommandNames(commandsResult)}`));
					}

					// ── lockfile snapshot (after) ───────────────────────────────────
					const lockfileAfter = yield* lockfileSnapshotStep("after", detected.pm, detected.root);

					// ── changes ──────────────────────────────────────────────────────
					const changes = yield* compareLockfiles(lockfileBefore, lockfileAfter, detected.root);
					yield* Effect.logDebug(`Detected changes: ${JSON.stringify(changes)}`);

					const allUpdates = [
						...configUpdatesFromPackageManager,
						...runtimeUpdates,
						...configUpdates,
						...regularUpdates,
						...peerUpdates,
					];
					yield* Effect.logDebug(
						`Total updates: ${allUpdates.length} (config: ${configUpdates.length + configUpdatesFromPackageManager.length}, dev: ${regularUpdates.length}, peer: ${peerUpdates.length})`,
					);

					const { changedLines, hasChanges } = yield* detectChangesStep();

					yield* Effect.logInfo(
						`Step: changes — ${allUpdates.length} dependency change(s), ${changes.length} lockfile change(s), ${changedLines.length} file(s) modified`,
					);

					if (!hasChanges && changes.length === 0) {
						yield* Effect.logInfo(
							"Step: changes — SKIPPED: no changes detected; changesets, commit and pull request steps do not run",
						);

						yield* conclude(
							"neutral",
							CheckRunOutput.make({
								title: "No Updates",
								summary: "No dependency updates available. All dependencies are up-to-date.",
							}),
						);

						yield* outputs.set("has-changes", "false");
						yield* outputs.set("updates-count", "0");

						return;
					}

					// ── changesets ───────────────────────────────────────────────────
					const changesetsResult = yield* changesetsStep(inputs.changesets, inputs.targetBranch, detected.root);
					const changesetFiles = changesetsResult.files;
					const changesetsSkipReason = changesetsResult.skipReason;

					// ── commit and pull request ─────────────────────────────────────
					const { pullRequest: pr } = yield* commitAndPrStep({
						branch: inputs.branch,
						targetBranch: inputs.targetBranch,
						autoMerge: inputs["auto-merge"],
						updates: allUpdates,
						changesets: changesetFiles,
						deltas: configDeltas,
						changedFileCount: changedLines.length,
						workspaceRoot: detected.root,
						dryRun,
					});

					// ── Result ───────────────────────────────────────────────────────
					yield* Effect.logInfo("Result");
					if (allUpdates.length > 0) {
						const updateLines = allUpdates.map((u) => `${u.dependency} ${u.from ?? "added"} -> ${u.to} (${u.type})`);
						yield* Effect.logInfo(`  updated   ${updateLines.join(", ")}`);
					}
					if (configDeltas.length > 0) {
						const catalogLines = Array.from(
							groupCatalogDeltas(configDeltas),
							([catalog, counts]) => `${catalog}: ${formatCatalogCountsCompact(counts)}`,
						);
						yield* Effect.logInfo(`  catalogs  ${catalogLines.join(", ")}`);
					}
					const skippedSummary: string[] = [];
					if (pmSkipReason !== null) skippedSummary.push(`package-manager upgrade (${pmSkipReason})`);
					if (!peerConfigured) skippedSummary.push("peer sync (not configured)");
					if (detected.pm !== "pnpm") skippedSummary.push("workspace formatting (not pnpm)");
					if (inputs.run.length === 0) skippedSummary.push("custom commands (not configured)");
					if (changesetsSkipReason !== null) skippedSummary.push(`changesets (${changesetsSkipReason})`);
					if (skippedSummary.length > 0) {
						yield* Effect.logInfo(`  skipped   ${skippedSummary.join(" · ")}`);
					}

					// Update check run
					const report = yield* Report;
					const summaryText = report.generateSummary(allUpdates, changesetFiles, pr, dryRun, configDeltas);
					yield* conclude(
						"success",
						CheckRunOutput.make({
							title: "Dependency Updates Complete",
							summary: summaryText,
						}),
					);

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
		}),
		appLayer,
	);
