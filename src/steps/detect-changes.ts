/**
 * Step: decide whether this run actually changed anything.
 *
 * Not in the original 13-step plan — extracted as a step because it does real
 * I/O (`git status`), and `program.ts` is supposed to have none of its own.
 * Leaving it inline was the one remaining place the composition layer shelled
 * out directly.
 *
 * Two independent signals are combined by the caller: the file-level `git
 * status` result computed here, and the lockfile comparison. Either one being
 * non-empty means there is something to commit.
 *
 * **Failure posture: fail-the-job.** A `git status` that cannot run means the
 * working tree is unreadable, and every downstream decision depends on it.
 *
 * @module steps/detect-changes
 */

import type { CommandFailedError, CommandOutputError } from "@effected/commands";
import { Run } from "@effected/commands";
import { Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { ChildProcess } from "effect/unstable/process";

/** The file-level change signal. */
export interface DetectChangesResult {
	/** One entry per `--porcelain` line; only the count is read today. */
	readonly changedLines: ReadonlyArray<string>;
	readonly hasChanges: boolean;
}

/**
 * Read the working tree's change list.
 *
 * `core.fileMode=false` is load-bearing: executable-bit-only flips (husky
 * chmod-ing hooks during a `run` command, say) do not survive the content-based
 * GitHub API commit at mode 100644, so counting them would produce an empty
 * commit and a spurious PR. **This must stay consistent with
 * `BranchManager.commitChanges`, which queries status the same way.**
 *
 * `Run.collect`, not `Run.text`: `text` trims, and `--porcelain`'s status field
 * is column-aligned, so trimming shifts every parse index. Only the line count
 * is read here, but the repo keeps one rule for porcelain output rather than a
 * per-call-site judgement.
 */
export const detectChangesStep = (): Effect.Effect<
	DetectChangesResult,
	CommandFailedError | CommandOutputError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const statusOut = yield* Run.collect(
			ChildProcess.make("git", ["-c", "core.fileMode=false", "status", "--porcelain"]),
		);
		const changedLines = statusOut.stdout.split("\n").filter((line) => line.length > 0);
		const hasChanges = changedLines.length > 0;
		yield* Effect.logDebug(`Git status has changes: ${hasChanges}`);
		return { changedLines, hasChanges };
	});
