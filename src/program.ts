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
import { resultLines, runContextLines } from "./format.js";
import { makeAppLayer } from "./layers/app.js";
import type {
	CatalogDelta,
	ChangesetFile,
	DependencyUpdateResult,
	LockfileChange,
	PeerIssue,
	PullRequestResult,
	RunResultDocument,
} from "./schema/domain.js";
import type { InnerProgramInputs } from "./schema/inputs.js";
import { readInputs } from "./schema/inputs.js";
import { emitOutputs, encodeRunResult, initialOutputs } from "./schema/outputs.js";
import { LOCKFILE_NAMES, compareLockfiles } from "./services/lockfile.js";
import type { DetectedPm } from "./services/package-manager.js";
import { Report } from "./services/report.js";
import { branchStep } from "./steps/branch.js";
import { changesetsStep } from "./steps/changesets.js";
import { commitAndPrStep } from "./steps/commit-and-pr.js";
import { configDependenciesStep } from "./steps/config-dependencies.js";
import { configureStatusStep } from "./steps/configure-status.js";
import { customCommandsStep, failedCommandNames, formatCommandFailures } from "./steps/custom-commands.js";
import { detectChangesStep } from "./steps/detect-changes.js";
import { detectPackageManagerStep } from "./steps/detect-package-manager.js";
import { formatWorkspaceStep } from "./steps/format-workspace.js";
import { installStep } from "./steps/install.js";
import { lockfileSnapshotStep } from "./steps/lockfile-snapshot.js";
import { peerCheckStep } from "./steps/peer-check.js";
import { peerSyncStep } from "./steps/peer-sync.js";
import { regularDependenciesStep } from "./steps/regular-dependencies.js";
import { upgradePackageManagerStep } from "./steps/upgrade-package-manager.js";
import { upgradeRuntimesStep } from "./steps/upgrade-runtimes.js";

/**
 * Assemble the structured `result` document from the run's own values.
 *
 * Built from the same records that drive the scalar outputs and the PR body —
 * not a parallel reporting shape — so the two cannot disagree about what
 * happened.
 */
const buildRunResult = (params: {
	readonly hasChanges: boolean;
	readonly dryRun: boolean;
	readonly detected: DetectedPm;
	readonly branch: string;
	readonly targetBranch: string;
	readonly updates: ReadonlyArray<DependencyUpdateResult>;
	readonly deltas: ReadonlyArray<CatalogDelta>;
	readonly lockfileChanges: ReadonlyArray<LockfileChange>;
	readonly changesets: ReadonlyArray<ChangesetFile>;
	readonly peerIssues: ReadonlyArray<PeerIssue>;
	readonly pullRequest: PullRequestResult | null;
}): RunResultDocument => ({
	schemaVersion: 1,
	hasChanges: params.hasChanges,
	dryRun: params.dryRun,
	packageManager: params.detected.pm,
	workspaceRoot: params.detected.root,
	branch: params.branch,
	targetBranch: params.targetBranch,
	updates: params.updates,
	catalogDeltas: params.deltas,
	peerIssues: params.peerIssues,
	lockfileChanges: params.lockfileChanges,
	changesets: params.changesets,
	pullRequest: params.pullRequest,
});

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

					for (const line of runContextLines({
						detected,
						evidence,
						packageCount,
						lockfileName,
						branch: inputs.branch,
						sourceBranch: inputs.sourceBranch,
						targetBranch: inputs.targetBranch,
						dryRun,
						changesets: inputs.changesets,
						runtimeData: inputs.runtimeData,
					})) {
						yield* Effect.logInfo(line);
					}

					// ── git config ──────────────────────────────────────────────────
					// Before ANY status read, and once for the whole run, so this run's
					// change verdict and the commit's contents cannot disagree.
					yield* configureStatusStep(detected.root);

					// ── branch ────────────────────────────────────────────────────
					yield* branchStep(inputs.branch, inputs.sourceBranch, inputs.targetBranch, detected.root);

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

					// Assigned by the peer-check step below, which runs only once a PR
					// is actually going to be opened. Declared here rather than inline
					// at each exit path so all three report the SAME value -- the
					// failure exit has already shipped a bug of exactly that shape,
					// reporting `updates: []` for a run that really did update things.
					// The two early exits keep `[]`, which is honest: they open no PR,
					// so nothing was examined and nothing is gated.
					let peerIssues: ReadonlyArray<PeerIssue> = [];
					let withholdAutoMerge = false;

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

					// Aggregated HERE, above the custom-commands step, not below it.
					// Every source is already resolved by this point, and the failure
					// exit below has to describe them: a run that updated five
					// dependencies and then failed `pnpm test` did do that work, and a
					// document reporting an empty update set for it is false.
					const allUpdates = [
						...configUpdatesFromPackageManager,
						...runtimeUpdates,
						...configUpdates,
						...regularUpdates,
						...peerUpdates,
					];

					// ── custom commands ─────────────────────────────────────────────
					// The step reports what happened; concluding the check run and
					// publishing outputs stay here, because the run's verdict is a
					// composition concern.
					const commandsResult = yield* customCommandsStep(inputs.run, detected.root);
					if (commandsResult !== null && commandsResult.failed.length > 0) {
						yield* conclude(
							"failure",
							CheckRunOutput.make({
								title: "Custom Commands Failed",
								summary: `Custom commands failed:\n\n${formatCommandFailures(commandsResult)}`,
							}),
						);

						// `has-changes` is false because nothing was committed and no PR
						// opened — that is what the flag means. `updates-count` reports the
						// updates that DID happen, so it cannot contradict the document
						// below; the two are the same fact, and one path wording it two
						// ways is exactly the drift the single-document design forbids.
						yield* outputs.set("has-changes", "false");
						yield* outputs.set("updates-count", String(allUpdates.length));
						// Re-encode `result` rather than leaving the pre-run baseline in
						// place. Detection HAS succeeded by now, and so have the update
						// steps — a run that bumped five dependencies and then failed
						// `pnpm test` did that work, and the working tree still holds it.
						// Publishing an empty update set here would be a false statement
						// about a run that a consumer is reading precisely to find out
						// what happened before it broke.
						yield* outputs.set(
							"result",
							encodeRunResult(
								buildRunResult({
									hasChanges: false,
									dryRun,
									detected,
									branch: inputs.branch,
									targetBranch: inputs.targetBranch,
									updates: allUpdates,
									deltas: configDeltas,
									peerIssues,
									// The "after" lockfile snapshot and its comparison run
									// below this exit, so there is genuinely nothing to
									// report here — empty because it was never computed,
									// not because it was discarded.
									lockfileChanges: [],
									changesets: [],
									pullRequest: null,
								}),
							),
						);

						return yield* Effect.fail(new Error(`Custom commands failed: ${failedCommandNames(commandsResult)}`));
					}

					// ── lockfile snapshot (after) ───────────────────────────────────
					const lockfileAfter = yield* lockfileSnapshotStep("after", detected.pm, detected.root);

					// ── changes ──────────────────────────────────────────────────────
					const changes = yield* compareLockfiles(lockfileBefore, lockfileAfter, detected.root);
					yield* Effect.logDebug(`Detected changes: ${JSON.stringify(changes)}`);

					yield* Effect.logDebug(
						`Total updates: ${allUpdates.length} (config: ${configUpdates.length + configUpdatesFromPackageManager.length}, dev: ${regularUpdates.length}, peer: ${peerUpdates.length})`,
					);

					const { entries: changedEntries, hasChanges } = yield* detectChangesStep(detected.root);

					yield* Effect.logInfo(
						`Step: changes — ${allUpdates.length} dependency change(s), ${changes.length} lockfile change(s), ${changedEntries.length} file(s) modified`,
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
						// Same reasoning as the custom-commands exit: detection succeeded,
						// so the baseline document no longer describes this run. A
						// no-changes run is the case a consumer is MOST likely to inspect
						// programmatically, and "which package manager and root did you
						// find nothing in?" is the first question it would ask.
						yield* outputs.set(
							"result",
							encodeRunResult(
								buildRunResult({
									hasChanges: false,
									dryRun,
									detected,
									branch: inputs.branch,
									targetBranch: inputs.targetBranch,
									updates: allUpdates,
									deltas: configDeltas,
									peerIssues,
									lockfileChanges: changes,
									changesets: [],
									pullRequest: null,
								}),
							),
						);

						return;
					}

					// ── changesets ───────────────────────────────────────────────────
					const changesetsResult = yield* changesetsStep(inputs.changesets, inputs.targetBranch, detected.root);
					const changesetFiles = changesetsResult.files;
					const changesetsSkipReason = changesetsResult.skipReason;

					// ── peer check ───────────────────────────────────────────────────
					// Runs against the "after" snapshot -- the lockfile this PR will
					// carry -- and only on the path that actually opens a PR, so a
					// no-changes run never spawns the config-dependency hook replay.
					const peerCheckResult = yield* peerCheckStep(inputs["check-peers"], lockfileAfter, detected.root);
					peerIssues = peerCheckResult.issues;
					withholdAutoMerge = peerCheckResult.decision.withhold;
					// `null` when the check did not run, so the Result block reports it
					// as a skip rather than as a clean pass.
					const peerSummary =
						inputs["check-peers"] === "false"
							? null
							: {
									issues: peerCheckResult.issues.length,
									required: peerCheckResult.requiredCount,
									withheld: peerCheckResult.decision.withhold,
									reason: peerCheckResult.decision.reason,
									unverifiedReasons: peerCheckResult.unverifiedReasons,
								};

					// ── commit and pull request ─────────────────────────────────────
					const { pullRequest: pr } = yield* commitAndPrStep({
						branch: inputs.branch,
						targetBranch: inputs.targetBranch,
						// Withholding is a SEPARATE call being skipped, not a different
						// merge method: the PR still opens, it just cannot merge itself.
						autoMerge: withholdAutoMerge ? "" : inputs["auto-merge"],
						updates: allUpdates,
						changesets: changesetFiles,
						deltas: configDeltas,
						peerIssues,
						peerGate: {
							withheld: withholdAutoMerge,
							reason: peerCheckResult.decision.reason,
							unverifiedReasons: peerCheckResult.unverifiedReasons,
						},
						changedFileCount: changedEntries.length,
						workspaceRoot: detected.root,
						dryRun,
					});

					// ── Result ───────────────────────────────────────────────────────
					for (const line of resultLines({
						updates: allUpdates,
						deltas: configDeltas,
						packageManagerSkip: pmSkipReason,
						peerConfigured,
						isPnpm: detected.pm === "pnpm",
						customCommandsConfigured: inputs.run.length > 0,
						peers: peerSummary,
						changesetsSkip: changesetsSkipReason,
					})) {
						yield* Effect.logInfo(line);
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
					yield* outputs.set(
						"result",
						encodeRunResult(
							buildRunResult({
								hasChanges: true,
								dryRun,
								detected,
								branch: inputs.branch,
								targetBranch: inputs.targetBranch,
								updates: allUpdates,
								deltas: configDeltas,
								peerIssues,
								lockfileChanges: changes,
								changesets: changesetFiles,
								pullRequest: pr,
							}),
						),
					);

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
