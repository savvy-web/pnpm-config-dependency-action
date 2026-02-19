/**
 * Pre-action script.
 *
 * Runs before the main action to:
 * 1. Generate GitHub App installation token
 * 2. Save token and metadata to state for main.ts and post.ts
 *
 * @module pre
 */

import { debug, getInput, info, saveState, setFailed, setOutput, setSecret } from "@actions/core";
import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";

import { generateInstallationToken } from "./lib/github/auth.js";
import { shouldSkipTokenRevoke } from "./lib/inputs.js";

/**
 * Pre-action program.
 */
export const program = Effect.gen(function* () {
	yield* Effect.logInfo("Running pre-action script");

	// Store start time for duration logging in post.ts
	const startTime = Date.now().toString();
	saveState("startTime", startTime);

	// Get required GitHub App credentials
	const appId = getInput("app-id", { required: true });
	const privateKey = getInput("app-private-key", { required: true });
	const skipTokenRevoke = shouldSkipTokenRevoke();

	if (!appId || !privateKey) {
		return yield* Effect.fail(new Error("app-id and app-private-key are required"));
	}

	// Generate installation token
	const tokenResult = yield* generateInstallationToken(appId, privateKey);

	// Mark token as secret to mask in logs
	setSecret(tokenResult.token);

	// Save state for main.ts and post.ts
	saveState("token", tokenResult.token);
	saveState("expiresAt", tokenResult.expiresAt);
	saveState("installationId", tokenResult.installationId.toString());
	saveState("appSlug", tokenResult.appSlug);
	saveState("skipTokenRevoke", skipTokenRevoke.toString());

	// Set outputs for use in workflow
	setOutput("token", tokenResult.token);

	info(`Token generated for app "${tokenResult.appSlug}" (expires: ${tokenResult.expiresAt})`);
	debug(`Pre-action completed at ${startTime}`);
}).pipe(
	Effect.catchAll((error) =>
		Effect.sync(() => {
			const message = error instanceof Error ? error.message : String(error);
			setFailed(`Pre-action failed: ${message}`);
		}),
	),
);

// Run the pre-action
NodeRuntime.runMain(program);
