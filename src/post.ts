/**
 * Post-action cleanup script.
 *
 * Runs after the main action completes (or fails).
 * Responsible for:
 * - Revoking the GitHub App installation token (unless skip-token-revoke is set)
 * - Cleaning up any temporary state
 *
 * @module post
 */

import { Action, ActionState, ActionStateLive } from "@savvy-web/github-action-effects";
import { Effect, Option, Schema } from "effect";

import { revokeInstallationToken } from "./lib/github/auth.js";

/**
 * Schema for the token state saved by pre.ts.
 */
const TokenState = Schema.Struct({
	token: Schema.String,
	expiresAt: Schema.String,
	installationId: Schema.Number,
	appSlug: Schema.String,
});

/**
 * Post-action cleanup program.
 */
export const program = Effect.gen(function* () {
	yield* Effect.logInfo("Running post-action cleanup");

	const state = yield* ActionState;

	// Check if token revocation should be skipped
	const skipRevokeOption = yield* state.getOptional("skipTokenRevoke", Schema.Struct({ value: Schema.String }));
	const skipRevoke = Option.isSome(skipRevokeOption) && skipRevokeOption.value.value === "true";

	if (skipRevoke) {
		yield* Effect.logInfo("Skipping token revocation (skip-token-revoke is true)");
		return;
	}

	// Get token from state
	const tokenOption = yield* state.getOptional("tokenState", TokenState);

	if (Option.isNone(tokenOption)) {
		yield* Effect.logWarning("No token found in state - nothing to revoke");
		return;
	}

	const tokenState = tokenOption.value;

	// Revoke the token
	yield* Effect.logInfo("Revoking installation token...");
	yield* revokeInstallationToken(tokenState.token).pipe(
		Effect.tap(() => Effect.logInfo("Token revoked successfully")),
		Effect.catchAll((error) => Effect.logWarning(`Failed to revoke token: ${error.reason}`)),
	);

	yield* Effect.logInfo("Post-action cleanup complete");
});

// Run the post-action
Action.run(program, ActionStateLive);
