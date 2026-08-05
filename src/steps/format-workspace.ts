/**
 * Step: format `pnpm-workspace.yaml` after the config-dependency edits.
 *
 * pnpm-only — a bun or npm repo has no such file. Formatting exists to stop the
 * consumer's own lint-staged hook rewriting the file on the next commit, which
 * would show up as churn attributable to this action.
 *
 * **Failure posture: fail-the-job.** A `FileSystemError` here means the file was
 * read and could not be written back, which leaves it in an unknown state.
 *
 * @module steps/format-workspace
 */

import { Effect } from "effect";
import type { FileSystemError } from "../errors/errors.js";
import type { SupportedPm } from "../services/package-manager.js";
import { formatWorkspaceYaml, readWorkspaceYaml } from "../services/workspace-yaml.js";

/** Format the workspace file, or log why the step did not apply. */
export const formatWorkspaceStep = (pm: SupportedPm, workspaceRoot: string): Effect.Effect<void, FileSystemError> =>
	Effect.gen(function* () {
		if (pm !== "pnpm") {
			yield* Effect.logInfo(`Step: workspace formatting — SKIPPED: not a pnpm workspace (detected ${pm})`);
			return;
		}

		yield* Effect.logInfo("Step: workspace formatting — formatting pnpm-workspace.yaml");
		yield* formatWorkspaceYaml(workspaceRoot);

		const workspaceAfter = yield* readWorkspaceYaml(workspaceRoot).pipe(Effect.catch(() => Effect.succeed(null)));
		yield* Effect.logDebug(`pnpm-workspace.yaml (after): ${JSON.stringify(workspaceAfter)}`);
	});
