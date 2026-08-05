/**
 * Action program and utilities.
 *
 * Contains the main Effect program and helper functions, separated from
 * the entry point (`main.ts`) so tests can import without triggering
 * module-level `Action.run` execution.
 *
 * @module program
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import type { CommandFailedError, CommandOutputError } from "@effected/commands";
import { Run } from "@effected/commands";
import { CheckRun, CheckRunOutput } from "@effected/github";
import { ActionEnvironment, ActionOutputs } from "@effected/github-actions";
import { WorkspaceDiscovery } from "@effected/workspaces";
import { Duration, Effect, References } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { ChildProcess } from "effect/unstable/process";
import {
	INSTALL_LABEL,
	describePmEvidence,
	formatCatalogCounts,
	formatCatalogCountsCompact,
	groupCatalogDeltas,
} from "./format.js";
import { makeAppLayer } from "./layers/app.js";
import type { CatalogDelta, ChangesetFile, DependencyUpdateResult, PullRequestResult } from "./schema/domain.js";
import type { InnerProgramInputs } from "./schema/inputs.js";
import { readInputs } from "./schema/inputs.js";
import { emitOutputs, initialOutputs } from "./schema/outputs.js";
import { BranchManager } from "./services/branch.js";
import { CatalogConfigDeps } from "./services/catalog-config-deps.js";
import { Changesets, hasChangesets } from "./services/changesets.js";
import { ConfigDeps } from "./services/config-deps.js";
import { LOCKFILE_NAMES, captureLockfileState, compareLockfiles } from "./services/lockfile.js";
import type { SupportedPm } from "./services/package-manager.js";
import { detectPackageManager } from "./services/package-manager.js";
import type { PackageManagerUpgradeOutcome } from "./services/package-manager-upgrade.js";
import { PackageManagerUpgrade } from "./services/package-manager-upgrade.js";
import type { PeerSyncConfig } from "./services/peer-sync.js";
import { syncPeers } from "./services/peer-sync.js";
import { RegularDeps } from "./services/regular-deps.js";
import { Report } from "./services/report.js";
import { RuntimeUpgrade } from "./services/runtime-upgrade.js";
import { formatWorkspaceYaml, readWorkspaceYaml } from "./services/workspace-yaml.js";
import { matchesPattern } from "./utils/deps.js";

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
export const runCommands = (
	commands: ReadonlyArray<string>,
): Effect.Effect<RunCommandsResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const successful: string[] = [];
		const failed: Array<{ command: string; error: string; exitCode?: number | undefined }> = [];

		for (const command of commands) {
			yield* Effect.logInfo(`Running: ${command}`);

			// Run.collect treats a non-zero exit as a RESULT, so the failure branch
			// is driven by the exit code rather than the error channel; the catch
			// covers only a genuine spawn failure.
			const result = yield* Run.collect(ChildProcess.make("sh", ["-c", command])).pipe(
				Effect.map((output) =>
					output.succeeded
						? { success: true as const }
						: {
								success: false as const,
								error: output.stderr.trim() || `Command exited ${output.exitCode}`,
								exitCode: output.exitCode,
							},
				),
				Effect.catch((error) =>
					Effect.succeed({
						success: false as const,
						error: error.message,
						exitCode: undefined as number | undefined,
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
 * Regenerate the lockfile and install, dispatched on the detected package manager.
 *
 * The action mutates all three inputs to dependency resolution — the package
 * manager version, the package manager's own config (config dependencies and
 * their hooks), and the declared ranges — so the lockfile is regenerated from a
 * clean slate rather than repaired in place. A repair-only install (pnpm's
 * `--fix-lockfile`) never re-runs resolution under the changed inputs, so it can
 * commit an inconsistent lockfile: an upstream peer range moving leaves a
 * required peer unfilled and the consumer gets ERR_MODULE_NOT_FOUND at runtime.
 * Advancing transitives is the expected consequence, not noise.
 *
 * - **pnpm:** `pnpm clean --lockfile` removes the lockfile and node_modules via
 *   Node, unlinking cleanly across platforms (including Windows junctions).
 *   Requires pnpm 11+, and runs a consumer's own `clean`/`purge` script over the
 *   built-in when one exists. `--frozen-lockfile=false` opts out of the CI
 *   default that refuses to write lockfile changes.
 * - **bun:** `--force` re-resolves every dependency against the registry rather
 *   than replaying the lockfile.
 * - **npm:** npm has no clean-and-resolve mode — `npm ci` requires a lockfile to
 *   already be correct — so the lockfile is removed and a plain install re-resolves.
 *   The removal goes through `node:fs` rather than shelling out to `rm`, matching
 *   the platform-agnostic unlink `pnpm clean --lockfile` performs: `rm` does not
 *   exist on a Windows runner.
 *
 * Every command — and the npm lockfile removal — is anchored at `workspaceRoot`
 * (the root the package manager was detected at), not at the process cwd: the
 * action can legitimately be invoked from a subdirectory of the workspace.
 */
export const runInstall = (
	pm: SupportedPm,
	workspaceRoot: string = process.cwd(),
): Effect.Effect<void, CommandFailedError | CommandOutputError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		// Run.text fails typed on a non-zero exit, preserving the old `exec`
		// contract that an install failure aborts the run.
		const run = (executable: string, args: ReadonlyArray<string>) =>
			Run.text(ChildProcess.make(executable, [...args]).pipe(ChildProcess.setCwd(workspaceRoot)));

		switch (pm) {
			case "pnpm":
				yield* run("pnpm", ["clean", "--lockfile"]);
				yield* run("pnpm", ["install", "--frozen-lockfile=false"]);
				return;
			case "bun":
				yield* run("bun", ["install", "--force"]);
				return;
			case "npm":
				yield* Effect.sync(() => {
					rmSync(join(workspaceRoot, "package-lock.json"), { force: true });
				});
				yield* run("npm", ["install"]);
				return;
		}
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
					const detected = yield* detectPackageManager();
					const evidence = describePmEvidence(detected);
					const lockfileName = LOCKFILE_NAMES[detected.pm];

					// Cheap, already-provided lookup used only to enrich the Run
					// context line with a package count — never fails the run.
					const discovery = yield* WorkspaceDiscovery;
					const packageCount = yield* discovery.listPackages().pipe(
						Effect.map((pkgs) => pkgs.length),
						Effect.catch(() => Effect.succeed(null)),
					);

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
					// Validate refs before any destructive branch operation, then manage branch.
					const branchManager = yield* BranchManager;
					yield* branchManager.validateBranches(inputs.sourceBranch, inputs.targetBranch);
					const branchResult = yield* branchManager.manage(inputs.branch, inputs.sourceBranch);
					yield* Effect.logInfo(
						`Step: branch — ${branchResult.branch} ${
							branchResult.created ? "created" : "exists, reset"
						} from ${branchResult.baseRef}`,
					);

					// ── lockfile snapshot (before) ──────────────────────────────────
					// Every step below reads and writes at `detected.root` — the resolved
					// workspace root — not at the process cwd. They are not the same thing:
					// the action can be invoked from a subdirectory of the workspace, and a
					// helper defaulting to `process.cwd()` would then read (and rewrite) the
					// wrong manifests, or none at all.
					const lockfileBefore = yield* captureLockfileState(detected.pm, detected.root);
					if (lockfileBefore) {
						yield* Effect.logInfo(
							`Step: lockfile snapshot (before) — read ${lockfileName} (${lockfileBefore.packages.length} packages)`,
						);
					} else {
						yield* Effect.logInfo(
							`Step: lockfile snapshot (before) — SKIPPED: no ${lockfileName} found (first install)`,
						);
					}
					yield* Effect.logDebug(
						`Lockfile state (before): ${JSON.stringify({
							packages: lockfileBefore?.packages.length ?? 0,
							importers: lockfileBefore?.importers.length ?? 0,
						})}`,
					);

					// ── package manager ─────────────────────────────────────────────
					const configUpdatesFromPackageManager: DependencyUpdateResult[] = [];
					let pmSkipReason: string | null = null;
					const pmMode = inputs["upgrade-package-manager"];
					if (pmMode === "false") {
						pmSkipReason = "disabled (upgrade-package-manager: false)";
						yield* Effect.logInfo(`Step: package manager — SKIPPED: ${pmSkipReason}`);
					} else {
						yield* Effect.logInfo(
							`Step: package manager — upgrade-package-manager "${pmMode}" applies to ${detected.pm}`,
						);
						const packageManagerUpgradeService = yield* PackageManagerUpgrade;
						const outcome: PackageManagerUpgradeOutcome = yield* packageManagerUpgradeService
							.upgrade(pmMode, detected.pm, detected.root)
							.pipe(
								Effect.catch((error) =>
									Effect.gen(function* () {
										yield* Effect.logWarning(`Failed to upgrade ${detected.pm}: ${error.reason}`);
										const fallback: PackageManagerUpgradeOutcome = {
											applied: false,
											pm: detected.pm,
											reference: null,
											referenceSource: null,
											targetRange: null,
											kind: "error",
											reason: `read/write error: ${error.reason}`,
										};
										return fallback;
									}),
								),
							);

						const refPart =
							outcome.reference !== null
								? `reference ${outcome.reference}${
										outcome.referenceSource
											? ` (${outcome.referenceSource === "devEngines" ? "devEngines.packageManager" : "packageManager"})`
											: ""
									}`
								: "reference none found";
						const rangePart = outcome.targetRange !== null ? ` · range "${outcome.targetRange}"` : "";

						if (outcome.applied) {
							yield* Effect.logInfo(`  ${refPart}${rangePart} → resolved ${outcome.to}`);
							yield* Effect.logInfo(`  ${detected.pm}: ${outcome.from ?? "added"} -> ${outcome.to}`);
							configUpdatesFromPackageManager.push({
								dependency: detected.pm,
								from: outcome.from,
								to: outcome.to,
								type: "config",
								package: null,
							});
						} else if (outcome.kind === "unsatisfiable") {
							// The acceptance signal. Nothing in this package manager's release
							// list satisfies the configured range — overwhelmingly because the
							// range was typed for a *different* package manager than the one
							// detected here (a pnpm "^11.0.0" in a bun repo, copy-pasted from
							// another repo's workflow). A misconfigured workflow must not scroll
							// past at the same level as a benign "disabled" or "already current"
							// skip, so this one kind — and only this one — reports at warning.
							pmSkipReason = outcome.reason;
							yield* Effect.logWarning(`  ${refPart}${rangePart} → no upgrade`);
							yield* Effect.logWarning(
								`  SKIPPED: no ${outcome.pm} release satisfies the range "${outcome.targetRange}" — this ` +
									`workspace uses ${outcome.pm}, so check that the upgrade-package-manager range is a ` +
									`${outcome.pm} range`,
							);
						} else {
							yield* Effect.logInfo(`  ${refPart}${rangePart} → no upgrade`);
							pmSkipReason = outcome.reason;
							yield* Effect.logInfo(`  SKIPPED: ${outcome.reason}`);
						}
					}

					// ── runtimes ─────────────────────────────────────────────────────
					const runtimeUpdates: DependencyUpdateResult[] = [];
					const runtimeModeParts = (["node", "deno", "bun"] as const).map(
						(rt) => `${rt}: ${inputs.runtime[rt] === "false" ? "not requested" : `"${inputs.runtime[rt]}"`}`,
					);
					yield* Effect.logInfo(`Step: runtimes — ${runtimeModeParts.join(" · ")}`);
					const runtimeUpgradeService = yield* RuntimeUpgrade;
					const runtimeResults = yield* runtimeUpgradeService.upgrade(inputs.runtime, detected.root).pipe(
						Effect.catch((error) =>
							Effect.gen(function* () {
								yield* Effect.logWarning(`Failed to upgrade runtimes: ${error.reason}`);
								return [] as const;
							}),
						),
					);
					for (const r of runtimeResults) {
						yield* Effect.logInfo(`  ${r.runtime}: ${r.from} -> ${r.to}`);
						runtimeUpdates.push({
							dependency: r.runtime,
							from: r.from,
							to: r.to,
							type: "runtime",
							package: null,
						});
					}

					// ── config dependencies ─────────────────────────────────────────
					const workspaceBefore = yield* readWorkspaceYaml(detected.root).pipe(
						Effect.catch(() => Effect.succeed(null)),
					);
					yield* Effect.logDebug(`pnpm-workspace.yaml (before): ${JSON.stringify(workspaceBefore)}`);

					let configUpdates: ReadonlyArray<DependencyUpdateResult> = [];
					let configDeltas: ReadonlyArray<CatalogDelta> = [];

					if (inputs["config-dependencies"].length === 0) {
						yield* Effect.logInfo("Step: config dependencies — SKIPPED: no config-dependencies configured");
					} else {
						// Config dependencies are a pnpm concept (pnpm-workspace.yaml). bun
						// has no equivalent, so CatalogConfigDeps reproduces the workflow by
						// merging the plugin's catalogs export into package.json. npm has no
						// catalog: protocol at all, so there is nothing to reproduce.
						switch (detected.pm) {
							case "pnpm": {
								yield* Effect.logInfo("Step: config dependencies — pnpm mode (pnpm-workspace.yaml)");
								const configDepsService = yield* ConfigDeps;
								configUpdates = yield* configDepsService.updateConfigDeps(inputs["config-dependencies"], detected.root);
								for (const u of configUpdates) {
									yield* Effect.logInfo(`  ${u.dependency} ${u.from ?? "added"} -> ${u.to}`);
								}
								break;
							}
							case "bun": {
								yield* Effect.logInfo(
									"Step: config dependencies — compat catalog mode (bun; catalogs live in package.json)",
								);
								// bun owns the package.json range for a config dependency
								// itself (CatalogConfigDeps bumps it below), so a
								// `dependencies` glob that also matches it must not bump it
								// a second time in the regular-deps pass below.
								const ownedByConfig = inputs["config-dependencies"].filter((name) =>
									inputs.dependencies.some((pattern) => matchesPattern(name, pattern)),
								);
								for (const name of ownedByConfig) {
									yield* Effect.logInfo(`  ${name} SKIPPED: owned by config-dependencies`);
								}
								const catalogConfigDeps = yield* CatalogConfigDeps;
								const catalogResult = yield* catalogConfigDeps.update(inputs["config-dependencies"], detected.root);
								configUpdates = catalogResult.updates;
								configDeltas = catalogResult.deltas;
								for (const u of configUpdates) {
									yield* Effect.logInfo(`  ${u.dependency} ${u.from ?? "added"} -> ${u.to}`);
								}
								for (const [catalog, counts] of groupCatalogDeltas(configDeltas)) {
									yield* Effect.logInfo(`  catalog "${catalog}": ${formatCatalogCounts(counts)}`);
								}
								break;
							}
							case "npm": {
								yield* Effect.logWarning(
									`Skipping ${inputs["config-dependencies"].length} config dependencies: npm does not implement the catalog: protocol. ` +
										"Config dependencies are supported for pnpm (pnpm-workspace.yaml) and bun (package.json catalogs).",
								);
								yield* Effect.logInfo(
									`Step: config dependencies — SKIPPED: npm has no catalog: protocol (${inputs["config-dependencies"].length} requested)`,
								);
								break;
							}
						}
					}
					yield* Effect.logDebug(`Config dependency updates: ${JSON.stringify(configUpdates)}`);
					if (configDeltas.length > 0) {
						yield* Effect.logDebug(`Catalog deltas: ${JSON.stringify(configDeltas)}`);
					}

					// ── regular dependencies ────────────────────────────────────────
					let regularUpdates: ReadonlyArray<DependencyUpdateResult> = [];
					if (inputs.dependencies.length === 0) {
						yield* Effect.logInfo("Step: regular dependencies — SKIPPED: no dependencies patterns configured");
					} else {
						yield* Effect.logInfo(`Step: regular dependencies — patterns ${inputs.dependencies.join(", ")}`);
						const regularDepsService = yield* RegularDeps;
						// bun is the only package manager whose config-dep path owns the
						// package.json entry: CatalogConfigDeps bumps the range there itself,
						// so a `dependencies` glob that also matches it must not bump it a
						// second time and race the same manifest write. Under pnpm the config
						// deps live in pnpm-workspace.yaml and ConfigDeps never touches
						// package.json; under npm they are skipped entirely. Excluding them
						// there would freeze the package.json range of a package that is both
						// a config dependency and a devDependency, forever.
						regularUpdates = yield* regularDepsService.updateRegularDeps(
							inputs.dependencies,
							detected.root,
							detected.pm === "bun" ? new Set(inputs["config-dependencies"]) : undefined,
						);
						for (const u of regularUpdates) {
							yield* Effect.logInfo(`  ${u.dependency} ${u.from ?? "added"} -> ${u.to}`);
						}
					}

					// ── peer sync ────────────────────────────────────────────────────
					const peerSyncConfig: PeerSyncConfig = {
						lock: inputs["peer-lock"],
						minor: inputs["peer-minor"],
					};
					let peerUpdates: ReadonlyArray<DependencyUpdateResult> = [];
					const peerConfigured = inputs["peer-lock"].length > 0 || inputs["peer-minor"].length > 0;
					if (!peerConfigured) {
						yield* Effect.logInfo("Step: peer sync — SKIPPED: no peer-lock or peer-minor patterns configured");
					} else {
						yield* Effect.logInfo(
							`Step: peer sync — peer-lock ${inputs["peer-lock"].join(", ") || "none"} · peer-minor ${
								inputs["peer-minor"].join(", ") || "none"
							}`,
						);
						peerUpdates = yield* syncPeers(peerSyncConfig, regularUpdates, detected.root);
						yield* Effect.logInfo(`  synced ${peerUpdates.length} peer dependency range(s)`);
					}

					// ── install ──────────────────────────────────────────────────────
					const shouldInstall =
						configUpdates.length > 0 ||
						regularUpdates.length > 0 ||
						configUpdatesFromPackageManager.length > 0 ||
						peerUpdates.length > 0;
					if (shouldInstall) {
						yield* Effect.logInfo(`Step: install — ${INSTALL_LABEL[detected.pm]}  (config + regular updates pending)`);
						yield* runInstall(detected.pm, detected.root);
					} else {
						yield* Effect.logInfo(
							"Step: install — SKIPPED: nothing to install (no dependency, config or package-manager updates)",
						);
					}

					// ── workspace formatting ────────────────────────────────────────
					// pnpm-only: a bun or npm repo has no pnpm-workspace.yaml to format.
					if (detected.pm === "pnpm") {
						yield* Effect.logInfo("Step: workspace formatting — formatting pnpm-workspace.yaml");
						yield* formatWorkspaceYaml(detected.root);

						const workspaceAfter = yield* readWorkspaceYaml(detected.root).pipe(
							Effect.catch(() => Effect.succeed(null)),
						);
						yield* Effect.logDebug(`pnpm-workspace.yaml (after): ${JSON.stringify(workspaceAfter)}`);
					} else {
						yield* Effect.logInfo(
							`Step: workspace formatting — SKIPPED: not a pnpm workspace (detected ${detected.pm})`,
						);
					}

					// ── custom commands ─────────────────────────────────────────────
					if (inputs.run.length === 0) {
						yield* Effect.logInfo("Step: custom commands — SKIPPED: no run commands configured");
					} else {
						yield* Effect.logInfo(`Step: custom commands — ${inputs.run.length} command(s)`);
						const runCommandsResult = yield* runCommands(inputs.run);

						if (runCommandsResult.failed.length > 0) {
							const failedCommands = runCommandsResult.failed.map((f) => f.command).join(", ");
							yield* Effect.logError(`${runCommandsResult.failed.length} command(s) failed: ${failedCommands}`);

							const failureDetails = runCommandsResult.failed.map((f) => `- \`${f.command}\`: ${f.error}`).join("\n");

							yield* conclude(
								"failure",
								CheckRunOutput.make({
									title: "Custom Commands Failed",
									summary: `Custom commands failed:\n\n${failureDetails}`,
								}),
							);

							yield* outputs.set("has-changes", "false");
							yield* outputs.set("updates-count", "0");

							return yield* Effect.fail(new Error(`Custom commands failed: ${failedCommands}`));
						}
					}

					// ── lockfile snapshot (after) ───────────────────────────────────
					const lockfileAfter = yield* captureLockfileState(detected.pm, detected.root);
					if (lockfileAfter) {
						yield* Effect.logInfo(
							`Step: lockfile snapshot (after) — read ${lockfileName} (${lockfileAfter.packages.length} packages)`,
						);
					} else {
						yield* Effect.logInfo(`Step: lockfile snapshot (after) — SKIPPED: no ${lockfileName} found`);
					}
					yield* Effect.logDebug(
						`Lockfile state (after): ${JSON.stringify({
							packages: lockfileAfter?.packages.length ?? 0,
							importers: lockfileAfter?.importers.length ?? 0,
						})}`,
					);

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

					// Check if there are any changes via git status.
					//
					// Use core.fileMode=false so executable-bit-only flips (e.g. husky
					// chmod-ing .husky hooks during a `run` command) are not counted as
					// changes. They don't survive the content-based GitHub API commit
					// (mode 100644), so treating them as changes would otherwise produce
					// an empty commit and a spurious PR. This must stay consistent with
					// BranchManager.commitChanges, which queries status the same way.
					// Run.collect, not Run.text: text() trims, and --porcelain's status
					// field is column-aligned, so trimming shifts every parse index. Only
					// the line COUNT is read here, but the repo keeps one rule for
					// porcelain output rather than a per-call-site judgement.
					const statusOut = yield* Run.collect(
						ChildProcess.make("git", ["-c", "core.fileMode=false", "status", "--porcelain"]),
					);
					const changedLines = statusOut.stdout.split("\n").filter((line) => line.length > 0);
					const hasChanges = changedLines.length > 0;
					yield* Effect.logDebug(`Git status has changes: ${hasChanges}`);

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
					let changesetFiles: ReadonlyArray<ChangesetFile> = [];
					let changesetsSkipReason: string | null = null;
					if (!inputs.changesets) {
						changesetsSkipReason = "disabled (changesets: false)";
						yield* Effect.logInfo(`Step: changesets — SKIPPED: ${changesetsSkipReason}`);
					} else if (!hasChangesets(detected.root)) {
						changesetsSkipReason = "no .changeset/ directory";
						yield* Effect.logInfo(`Step: changesets — SKIPPED: ${changesetsSkipReason}`);
					} else {
						yield* Effect.logInfo(
							`Step: changesets — regenerating from merge-base(${inputs.targetBranch}) -> worktree diff`,
						);
						// DepsRegen diffs against merge-base(target-branch); make sure that
						// history is available locally before it runs (no-op on a
						// fetch-depth: 0 checkout of the target).
						yield* branchManager.ensureBaseHistory(inputs.targetBranch);
						const changesetsService = yield* Changesets;
						// DepsRegen recomputes the cumulative dependency diff from
						// merge-base(target-branch) → worktree and consolidates/dedupes
						// existing pure-dep changesets. The per-run `changes`/
						// `regularUpdates`/`peerUpdates` still drive reporting below.
						changesetFiles = yield* changesetsService.create(detected.root, inputs.targetBranch);
						yield* Effect.logInfo(`  wrote ${changesetFiles.length} changeset(s)`);
					}

					// ── commit ───────────────────────────────────────────────────────
					const report = yield* Report;
					if (dryRun) {
						yield* Effect.logInfo("Step: commit — SKIPPED: dry run");
					} else {
						yield* Effect.logInfo(`Step: commit — ${changedLines.length} file(s) -> ${inputs.branch}`);
						const commitMessage = report.generateCommitMessage(allUpdates);
						yield* branchManager.commitChanges(commitMessage, inputs.branch, detected.root);
					}

					// ── pull request ────────────────────────────────────────────────
					let pr: PullRequestResult | null = null;
					if (dryRun) {
						yield* Effect.logInfo("Step: pull request — SKIPPED: dry run");
					} else {
						pr = yield* report
							.createOrUpdatePR(
								inputs.branch,
								inputs.targetBranch,
								allUpdates,
								changesetFiles,
								inputs["auto-merge"] || undefined,
								configDeltas,
							)
							.pipe(
								Effect.catch((error) =>
									Effect.gen(function* () {
										yield* Effect.logWarning(`PR creation failed: ${error.reason}`);
										return null;
									}),
								),
							);
						yield* Effect.logInfo(
							`Step: pull request — ${pr ? (pr.created ? `created #${pr.number}` : `updated #${pr.number}`) : "FAILED (see warning above)"}`,
						);
					}

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
