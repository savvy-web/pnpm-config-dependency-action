/**
 * Pre-action script.
 *
 * Runs before the main action to:
 * 1. Generate GitHub App installation token
 * 2. Save token and metadata to state for main.ts and post.ts
 *
 * @module pre
 */

import { Action, ActionInputs, ActionOutputs, ActionState, ActionStateLive } from "@savvy-web/github-action-effects";
import { Effect, Schema } from "effect";

import { generateInstallationToken } from "./lib/github/auth.js";

/**
 * Schema for the token state saved for main.ts and post.ts.
 */
const TokenState = Schema.Struct({
	token: Schema.String,
	expiresAt: Schema.String,
	installationId: Schema.Number,
	appSlug: Schema.String,
});

/**
 * Pre-action program.
 */
export const program = Effect.gen(function* () {
	yield* Effect.logInfo("Running pre-action script");

	const inputs = yield* ActionInputs;
	const outputs = yield* ActionOutputs;
	const state = yield* ActionState;

	// Store start time for duration logging in post.ts
	yield* state.save("startTime", { value: Date.now().toString() }, Schema.Struct({ value: Schema.String }));

	// Get required GitHub App credentials
	const appId = yield* inputs.get("app-id", Schema.String);
	const privateKey = yield* inputs.getSecret("app-private-key", Schema.String);
	const skipTokenRevoke = yield* inputs.getBooleanOptional("skip-token-revoke", false);

	// Generate installation token
	const tokenResult = yield* generateInstallationToken(appId, privateKey);

	// Mark token as secret to mask in logs
	yield* outputs.setSecret(tokenResult.token);

	// Save state for main.ts and post.ts
	yield* state.save("tokenState", tokenResult, TokenState);
	yield* state.save("skipTokenRevoke", { value: skipTokenRevoke.toString() }, Schema.Struct({ value: Schema.String }));

	// Set outputs for use in workflow
	yield* outputs.set("token", tokenResult.token);

	yield* Effect.logInfo(`Token generated for app "${tokenResult.appSlug}" (expires: ${tokenResult.expiresAt})`);
	yield* Effect.logDebug(`Pre-action completed at ${Date.now()}`);
});

// Run the pre-action
Action.run(program, ActionStateLive);
