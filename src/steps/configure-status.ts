/**
 * Step: pin `core.fileMode=false` on the checkout, once, before anything reads
 * `git status`.
 *
 * **Why this exists at all.** The action commits through the GitHub API, which
 * writes a content tree at mode `100644`. An executable-bit-only flip — husky
 * chmod-ing its hooks during a `run` command is the case that actually happens —
 * therefore has no content to commit. Counting it as a change produces an empty
 * commit and a spurious PR.
 *
 * **Why config rather than a per-command flag.** Both status readers (this
 * run's change detection and `BranchManager.commitChanges`) must agree, or the
 * run's verdict and the commit's contents disagree. `@effected/git`'s `status`
 * has no seam for `-c core.fileMode=false`, and threading a flag through two
 * call sites is exactly the kind of consistency a reviewer cannot check by
 * reading one of them. Writing it into `.git/config` makes the setting a
 * property of the checkout rather than of each caller — there is one place to
 * get right, and no way for a third reader to be added without it.
 *
 * `git config <key> <value>` with no scope flag writes the local repository
 * config, which is what `--local` names explicitly. It is scoped to this
 * checkout and does not touch the runner's global config.
 *
 * @module steps/configure-status
 */

import type { GitCommandError, NotARepositoryError, UnknownRefError } from "@effected/git";
import { Git } from "@effected/git";
import { Effect } from "effect";

/**
 * Write `core.fileMode=false` into the checkout's local git config.
 *
 * Failure propagates: if the write did not take, every later status read
 * silently reports exec-bit flips as changes, and the run's whole change
 * verdict is wrong in a way nothing downstream can detect.
 */
export const configureStatusStep = (
	workspaceRoot: string,
): Effect.Effect<void, GitCommandError | NotARepositoryError | UnknownRefError, Git> =>
	Effect.gen(function* () {
		const git = yield* Git;
		yield* git.configSet(workspaceRoot, "core.fileMode", "false");
		yield* Effect.logDebug("Set core.fileMode=false on the checkout");
	});
