/**
 * Fixture tests for the pre-action Effect program.
 *
 * Drives `pre` against in-memory doubles for the action runtime. `pre` calls
 * `GitHubToken.provision` with required scopes, so the minted test token's
 * `permissions` must grant them or `provision` fails with
 * `TokenPermissionError`.
 */

import type { GitHubApp } from "@effected/github";
import type { ActionEnvironment, ActionOutputs, ActionState } from "@effected/github-actions";
import { ActionEnvironment as ActionEnvironmentTag, ActionInput } from "@effected/github-actions";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { pre } from "../../src/pre.js";
import type { ActionOutputsRecording, ActionStateRecording, GitHubAppRecording } from "../utils/action-doubles.js";
import {
	actionOutputsTestLayer,
	actionStateTestLayer,
	emptyActionOutputs,
	emptyActionState,
	emptyGitHubApp,
	gitHubAppTestLayer,
} from "../utils/action-doubles.js";
import { silentLogger } from "../utils/fixtures.js";

interface Fixtures {
	stateState: ActionStateRecording;
	appState: GitHubAppRecording;
	outputsState: ActionOutputsRecording;
	layer: Layer.Layer<ActionOutputs | ActionState | GitHubApp | ActionEnvironment>;
}

const makeFixtures = (): Fixtures => {
	const stateState = emptyActionState();
	const appState = emptyGitHubApp();
	const outputsState = emptyActionOutputs();
	const layer = Layer.mergeAll(
		actionOutputsTestLayer(outputsState),
		actionStateTestLayer(stateState),
		gitHubAppTestLayer(appState),
		// Seeds the twelve GITHUB_*/RUNNER_* variables; `pre` reads
		// repositoryOwner from here to scope the installation lookup.
		ActionEnvironmentTag.layerTest(),
	);
	return { stateState, appState, outputsState, layer };
};

const runPre = (fixtures: Fixtures): Promise<void> =>
	pre.pipe(
		Effect.provide(fixtures.layer),
		// Inputs are Config values read through the ambient provider — never
		// process.env — so they are injected as a reference override.
		Effect.provide(
			ActionInput.layer({
				"INPUT_APP-CLIENT-ID": "test-client-id",
				"INPUT_APP-PRIVATE-KEY": "test-private-key",
			}),
		),
		Effect.provide(silentLogger),
		Effect.runPromise,
	);

describe("pre", () => {
	it("provisions an installation token", async () => {
		const fixtures = makeFixtures();
		await runPre(fixtures);
		expect(fixtures.appState.generateCalls).toHaveLength(1);
	});

	it("persists the start time and the token envelope to ActionState", async () => {
		const fixtures = makeFixtures();
		await runPre(fixtures);
		expect(fixtures.stateState.entries.has("startTime")).toBe(true);
		const startTime = JSON.parse(fixtures.stateState.entries.get("startTime") ?? "{}");
		expect(typeof startTime.startedAt).toBe("number");
		// startTime + the internal token envelope provision writes.
		expect(fixtures.stateState.entries.size).toBeGreaterThanOrEqual(2);
		// The app-client-id input flowed through to provision's token mint.
		expect(fixtures.appState.generateCalls[0]?.appId).toBe("test-client-id");
	});

	it("masks the minted token before it is persisted", async () => {
		const fixtures = makeFixtures();
		await runPre(fixtures);
		// GITHUB_STATE is plaintext by protocol, so masking is the only defense.
		expect(fixtures.outputsState.masked).toContain("ghs_test_token");
	});
});
