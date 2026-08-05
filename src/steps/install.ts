/**
 * Step: regenerate the lockfile and install, dispatched on the package manager.
 *
 * Gated by the caller on whether anything actually changed — an install with
 * nothing to install is logged as a skip with that reason, never silence.
 *
 * **Failure posture: fail-the-job.** `runInstall` uses `Run.text`, which fails
 * typed on a non-zero exit, so an install failure aborts the run rather than
 * committing a lockfile that does not match the manifests.
 *
 * @module steps/install
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import type { CommandFailedError, CommandOutputError } from "@effected/commands";
import { Run } from "@effected/commands";
import { Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { ChildProcess } from "effect/unstable/process";
import { INSTALL_LABEL } from "../format.js";
import type { SupportedPm } from "../services/package-manager.js";

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
 * Run the install when anything changed, or log why it was skipped.
 *
 * `shouldInstall` is decided by the caller because it folds four steps' results
 * together — package-manager, config, regular and peer updates — and a step
 * should not reach across to its siblings' outputs to decide whether it runs.
 */
export const installStep = (
	shouldInstall: boolean,
	pm: SupportedPm,
	workspaceRoot: string,
): Effect.Effect<void, CommandFailedError | CommandOutputError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		if (!shouldInstall) {
			yield* Effect.logInfo(
				"Step: install — SKIPPED: nothing to install (no dependency, config or package-manager updates)",
			);
			return;
		}

		yield* Effect.logInfo(`Step: install — ${INSTALL_LABEL[pm]}  (config + regular updates pending)`);
		yield* runInstall(pm, workspaceRoot);
	});
