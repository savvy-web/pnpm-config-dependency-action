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

import { getInput, getState, info, warning } from "@actions/core";
import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";

import { revokeInstallationToken } from "./lib/github/auth.js";

/**
 * Post-action cleanup program.
 */
const program = Effect.gen(function* () {
	yield* Effect.logInfo("Running post-action cleanup");

	// Check if token revocation should be skipped
	const skipRevoke = getInput("skip-token-revoke") === "true";
	if (skipRevoke) {
		yield* Effect.logInfo("Skipping token revocation (skip-token-revoke is true)");
		info("Token revocation skipped");
		return;
	}

	// Get token from state
	const token = getState("token");
	if (!token) {
		yield* Effect.logWarning("No token found in state - nothing to revoke");
		warning("No token to revoke");
		return;
	}

	// Revoke the token
	yield* Effect.logInfo("Revoking installation token...");
	yield* revokeInstallationToken(token).pipe(
		Effect.tap(() => Effect.logInfo("Token revoked successfully")),
		Effect.catchAll((error) =>
			Effect.gen(function* () {
				yield* Effect.logWarning(`Failed to revoke token: ${error.reason}`);
				warning(`Failed to revoke token: ${error.reason}`);
			}),
		),
	);

	info("Post-action cleanup complete");
});

// Run the post-action
NodeRuntime.runMain(program);
