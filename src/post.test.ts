/**
 * Fixture tests for the post-action Effect program.
 *
 * `post` revokes the installation token `pre` provisioned, reading it back out
 * of the shared `ActionState`. Provisioning here goes through the real
 * `GitHubToken.provision` so the envelope `post` reads is the one the real
 * lifecycle writes, not a hand-placed fixture.
 */

import type { GitHubApp } from "@effected/github";
import type { ActionOutputs, ActionState } from "@effected/github-actions";
import { GitHubToken } from "@effected/github-actions";
import { Effect, Layer, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { post } from "./post.js";
import type { ActionStateRecording, GitHubAppRecording } from "./utils/action-doubles.test.js";
import {
	actionOutputsTestLayer,
	actionStateTestLayer,
	emptyActionOutputs,
	emptyActionState,
	emptyGitHubApp,
	gitHubAppTestLayer,
} from "./utils/action-doubles.test.js";

interface Fixtures {
	stateState: ActionStateRecording;
	appState: GitHubAppRecording;
	layer: Layer.Layer<ActionOutputs | ActionState | GitHubApp>;
}

const makeFixtures = (): Fixtures => {
	const stateState = emptyActionState();
	const appState = emptyGitHubApp();
	// provision masks the minted token via ActionOutputs.setSecret, so the
	// shared layer must satisfy ActionOutputs as well.
	const layer = Layer.mergeAll(
		actionStateTestLayer(stateState),
		gitHubAppTestLayer(appState),
		actionOutputsTestLayer(emptyActionOutputs()),
	);
	return { stateState, appState, layer };
};

/** Provision a token into the shared ActionState, simulating the pre phase. */
const provisionToken = (fixtures: Fixtures): Promise<void> =>
	GitHubToken.provision({ appId: "test-client-id", privateKey: Redacted.make("test-private-key") }).pipe(
		Effect.provide(fixtures.layer),
		Effect.asVoid,
		Effect.runPromise,
	);

const runPost = (fixtures: Fixtures): Promise<void> => post.pipe(Effect.provide(fixtures.layer), Effect.runPromise);

describe("post", () => {
	it("revokes the installation token provisioned by pre", async () => {
		const fixtures = makeFixtures();
		await provisionToken(fixtures);
		await runPost(fixtures);
		expect(fixtures.appState.revokeCalls).toContain("ghs_test_token");
	});

	it("completes cleanly when no token was provisioned", async () => {
		const fixtures = makeFixtures();
		await runPost(fixtures);
		expect(fixtures.appState.revokeCalls).toHaveLength(0);
	});

	it("reports duration when pre recorded a start time", async () => {
		const fixtures = makeFixtures();
		fixtures.stateState.entries.set("startTime", JSON.stringify({ startedAt: Date.now() - 1000 }));
		await provisionToken(fixtures);
		// The duration-log path runs without throwing; revocation still happens.
		await runPost(fixtures);
		expect(fixtures.appState.revokeCalls).toContain("ghs_test_token");
	});
});
