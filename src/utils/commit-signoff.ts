/**
 * DCO sign-off trailer for action-created commits.
 *
 * @remarks
 * This action commits through the Git Data API so the commit verifies, which
 * means it must supply its own `Signed-off-by` trailer — the identity is not
 * inferred by GitHub the way a `git commit -s` trailer is added by porcelain.
 * The identity comes from `GitHubToken.botIdentity()`, so the trailer names the
 * GitHub App bot that actually authors the commit; if the persisted token
 * cannot be read it falls back to the well-known `github-actions[bot]`.
 *
 * @module utils/commit-signoff
 */

import { BotIdentity } from "@effected/github";
import type { ActionState } from "@effected/github-actions";
import { GitHubToken } from "@effected/github-actions";
import { Effect } from "effect";

/**
 * Resolve the DCO `Signed-off-by` trailer for a commit this action creates.
 *
 * @remarks
 * **This replaced a hand-rolled `signoffLine(appSlug?)` that was always called
 * without a slug**, so every run signed as `github-actions[bot]` while the
 * commit it signed was authored by the installation's own App bot. Nothing
 * failed: the trailer is well-formed, DCO checks pass, and the only symptom is
 * a commit whose author and sign-off name two different identities — visible
 * in a consumer's repository, on a commit this action already reported as
 * successful.
 *
 * The trailer text is rendered by `BotIdentity.signoff` rather than
 * interpolated here. `Signed-off-by:` is DCO 1.1 — fixed casing, spacing and
 * angle brackets — and since the API commit bypasses `git commit -s` nothing
 * validates it at commit time. What stays local is the **policy**: which
 * identity to sign as, and that an unreadable token degrades to the well-known
 * bot rather than failing a run whose dependency work is already done.
 *
 * Two fallbacks, at different depths, both load-bearing:
 * `GitHubToken.botIdentity()` already answers `BotIdentity.githubActions` when
 * the persisted token carries no `appSlug`; the `Effect.catch` here covers the
 * outer case where the state read itself fails — no token was persisted at all,
 * which is every unit test that does not stand up a `pre` phase.
 *
 * @returns A `Signed-off-by: Name <email>` line for the App bot identity, or
 *   the `github-actions[bot]` fallback when the persisted token cannot be read.
 */
export const resolveSignoff = (): Effect.Effect<string, never, ActionState> =>
	GitHubToken.botIdentity().pipe(
		Effect.catch(() => Effect.succeed(BotIdentity.githubActions)),
		Effect.map((identity) => identity.signoff),
	);
