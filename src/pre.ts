/**
 * Pre-action entry point.
 *
 * Provisions the GitHub App installation token via `GitHubToken.provision` —
 * which reads the `app-client-id` / `app-private-key` inputs, mints the token,
 * verifies it grants the scopes this action needs, resolves the App identity
 * best-effort, and persists the envelope to `ActionState` for the main and post
 * phases. Also records the start time for post-phase duration reporting.
 *
 * @module pre
 */

import { GitHubApp } from "@effected/github";
import { Action, ActionEnvironment, ActionInput, ActionState, GitHubToken } from "@effected/github-actions";
import { Effect } from "effect";
import { STATE_KEYS, StartTimeState } from "./state.js";

export const pre = Effect.gen(function* () {
	const state = yield* ActionState;
	const env = yield* ActionEnvironment;
	yield* Effect.logDebug("Running pre-action script");

	// Record start time for post-phase duration reporting.
	yield* state.save(STATE_KEYS.startTime, new StartTimeState({ startedAt: Date.now() }), StartTimeState);

	// The kit's provision takes credentials explicitly rather than reading the
	// inputs itself, so the two app inputs are parsed here. `required` is
	// verified against what GitHub actually granted, before the token is
	// persisted — a misconfigured installation fails here in `pre` rather than
	// mid-run in `main` with a 403 on one request.
	const appId = yield* ActionInput.string("app-client-id");
	const privateKey = yield* ActionInput.redacted("app-private-key");
	const owner = (yield* env.github).repositoryOwner;

	yield* Effect.logInfo("Generating GitHub App installation token...");
	const token = yield* GitHubToken.provision({
		appId,
		privateKey,
		owner,
		required: { contents: "write", pull_requests: "write", checks: "write" },
	});

	yield* Effect.logInfo(
		`Token generated${token.appName !== undefined ? ` for app "${token.appName}"` : ""} (expires: ${token.expiresAt})`,
	);
	yield* Effect.logDebug("Pre-action completed");
});

/**
 * Domain layers for pre-action. `GitHubToken.provision` needs a `GitHubApp`,
 * which in the kit is a self-contained layer — there is no octokit auth-app
 * strategy to provide and no separate HttpClient wiring. `ActionState` /
 * `ActionOutputs` come from `Action.run`'s runtime.
 */
export const PreLive = GitHubApp.layer;

/* v8 ignore next 3 -- entry-point guard, only runs in GitHub Actions */
if (process.env.GITHUB_ACTIONS) {
	await Action.run(pre, { layer: PreLive });
}
