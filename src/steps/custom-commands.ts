/**
 * Step: run the workflow author's custom commands after the updates land.
 *
 * **Failure posture: fail-the-job — but the caller owns the failure.** This step
 * runs every command, collects the failures, and *returns* them; it does not
 * conclude the check run, set outputs, or fail the effect.
 *
 * That boundary is deliberate. Concluding the check run and publishing outputs
 * are composition concerns — `program.ts` owns them for every terminal state, so
 * a step reaching for `conclude` would be the one place the run's verdict is
 * decided somewhere other than the composition layer. The step reports what
 * happened; the program decides what that means.
 *
 * @module steps/custom-commands
 */

import { Run } from "@effected/commands";
import { Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { ChildProcess } from "effect/unstable/process";

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
 *
 * Every command runs at `workspaceRoot` — the DETECTED root, not the process
 * cwd. The two differ whenever the action is invoked from a subdirectory, and a
 * command inheriting the process cwd would then lint, test or build a different
 * tree than the one this run just edited: it would pass while proving nothing.
 */
export const runCommands = (
	commands: ReadonlyArray<string>,
	workspaceRoot: string,
): Effect.Effect<RunCommandsResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const successful: string[] = [];
		const failed: Array<{ command: string; error: string; exitCode?: number | undefined }> = [];

		for (const command of commands) {
			yield* Effect.logInfo(`Running: ${command}`);

			// Run.collect treats a non-zero exit as a RESULT, so the failure branch
			// is driven by the exit code rather than the error channel; the catch
			// covers only a genuine spawn failure.
			const result = yield* Run.collect(
				ChildProcess.make("sh", ["-c", command]).pipe(ChildProcess.setCwd(workspaceRoot)),
			).pipe(
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
 * Run every configured command, or log that none were configured.
 *
 * Returns `null` when the step did not run, so the caller can distinguish "not
 * configured" from "ran and everything passed" — the closing Result block words
 * those differently.
 */
export const customCommandsStep = (
	commands: ReadonlyArray<string>,
	workspaceRoot: string,
): Effect.Effect<RunCommandsResult | null, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		if (commands.length === 0) {
			yield* Effect.logInfo("Step: custom commands — SKIPPED: no run commands configured");
			return null;
		}

		yield* Effect.logInfo(`Step: custom commands — ${commands.length} command(s)`);
		const result = yield* runCommands(commands, workspaceRoot);

		if (result.failed.length > 0) {
			const failedCommands = result.failed.map((f) => f.command).join(", ");
			yield* Effect.logError(`${result.failed.length} command(s) failed: ${failedCommands}`);
		}

		return result;
	});

/** The `- \`cmd\`: error` block the check-run summary renders on failure. */
export const formatCommandFailures = (result: RunCommandsResult): string =>
	result.failed.map((f) => `- \`${f.command}\`: ${f.error}`).join("\n");

/** The comma-joined command list used in both the log line and the failure message. */
export const failedCommandNames = (result: RunCommandsResult): string => result.failed.map((f) => f.command).join(", ");
