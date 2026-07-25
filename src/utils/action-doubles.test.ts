/**
 * In-memory doubles for the action runtime services the pre/post phases use.
 *
 * Replaces the deleted `@savvy-web/github-action-effects/testing` subpath
 * (`ActionStateTest`, `GitHubAppTest`, `ActionOutputsTest`). The kit ships
 * `makeTest`/`layerTest` per service instead, with unstubbed members dying, so
 * the recording behavior those suites assert on lives here.
 *
 * @module utils/action-doubles.test
 */

import type { InstallationToken } from "@effected/github";
import { AppIdentity, GitHubApp } from "@effected/github";
import { ActionOutputs, ActionState } from "@effected/github-actions";
import type { Layer } from "effect";
import { DateTime, Effect, Option, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";

// ══════════════════════════════════════════════════════════════════════════════
// ActionState
// ══════════════════════════════════════════════════════════════════════════════

/** The recorded contents of a fake `GITHUB_STATE`. */
export interface ActionStateRecording {
	/** key → encoded JSON, mirroring what the real store writes. */
	readonly entries: Map<string, string>;
}

export const emptyActionState = (): ActionStateRecording => ({ entries: new Map() });

/**
 * An `ActionState` backed by an in-memory map, encoding through each caller's
 * schema exactly as the real store does — so a round trip proves the schema is
 * usable across the phase boundary rather than asserting on the double.
 */
export const actionStateTestLayer = (recording: ActionStateRecording): Layer.Layer<ActionState> =>
	ActionState.layerTest({
		save: <A, I>(key: string, value: A, schema: Schema.Codec<A, I>) =>
			Effect.gen(function* () {
				const encoded = yield* Schema.encodeUnknownEffect(schema)(value).pipe(Effect.orDie);
				recording.entries.set(key, JSON.stringify(encoded));
			}),
		get: <A, I>(key: string, schema: Schema.Codec<A, I>) =>
			Effect.gen(function* () {
				const raw = recording.entries.get(key);
				if (raw === undefined) {
					return yield* Effect.die(`ActionState double: no entry for "${key}"`);
				}
				return yield* Schema.decodeUnknownEffect(schema)(JSON.parse(raw)).pipe(Effect.orDie);
			}),
		getOptional: <A, I>(key: string, schema: Schema.Codec<A, I>) =>
			Effect.gen(function* () {
				const raw = recording.entries.get(key);
				if (raw === undefined) return Option.none<A>();
				const decoded = yield* Schema.decodeUnknownEffect(schema)(JSON.parse(raw)).pipe(Effect.orDie);
				return Option.some(decoded);
			}),
		saveSecret: (key: string, secret: string) =>
			Effect.sync(() => {
				recording.entries.set(key, secret);
			}),
	});

// ══════════════════════════════════════════════════════════════════════════════
// ActionOutputs
// ══════════════════════════════════════════════════════════════════════════════

/** Values masked through `setSecret`, in call order. */
export interface ActionOutputsRecording {
	readonly masked: Array<string>;
	readonly outputs: Map<string, string>;
}

export const emptyActionOutputs = (): ActionOutputsRecording => ({ masked: [], outputs: new Map() });

/** An `ActionOutputs` recording only what the token lifecycle actually calls. */
export const actionOutputsTestLayer = (recording: ActionOutputsRecording): Layer.Layer<ActionOutputs> =>
	ActionOutputs.layerTest({
		// Effect.suspend: an eager recorder would log calls that were only
		// described and never run.
		setSecret: (value: string) =>
			Effect.suspend(() => {
				recording.masked.push(value);
				return Effect.void;
			}),
		set: (name: string, value: string) =>
			Effect.suspend(() => {
				recording.outputs.set(name, value);
				return Effect.void;
			}),
	});

// ══════════════════════════════════════════════════════════════════════════════
// GitHubApp
// ══════════════════════════════════════════════════════════════════════════════

/** One recorded token mint. */
export interface TokenMint {
	readonly appId: string;
}

export interface GitHubAppRecording {
	readonly generateCalls: Array<TokenMint>;
	readonly revokeCalls: Array<string>;
	/** Permissions the minted token reports as granted. */
	permissions: Record<string, string>;
}

export const emptyGitHubApp = (): GitHubAppRecording => ({
	generateCalls: [],
	revokeCalls: [],
	// provision verifies the granted scopes before persisting, so the default
	// grants what this action asks for; a test narrows it to exercise the gap.
	permissions: { contents: "write", pull_requests: "write", checks: "write" },
});

export const makeInstallationToken = (permissions: Record<string, string>): InstallationToken =>
	({
		token: Redacted.make("ghs_test_token"),
		expiresAt: DateTime.fromDateUnsafe(new Date(Date.now() + 60 * 60 * 1000)),
		installationId: 42,
		permissions,
		appSlug: "silk-bot",
		appName: "Silk Bot",
		appUserId: 1234,
	}) as unknown as InstallationToken;

/** A `GitHubApp` recording mints and revocations. */
export const gitHubAppTestLayer = (recording: GitHubAppRecording): Layer.Layer<GitHubApp> =>
	GitHubApp.layerTest({
		token: (request) =>
			Effect.suspend(() => {
				recording.generateCalls.push({ appId: request.appId });
				return Effect.succeed(makeInstallationToken(recording.permissions));
			}),
		revoke: (token) =>
			Effect.suspend(() => {
				recording.revokeCalls.push(Redacted.value(token));
				return Effect.void;
			}),
		// provision resolves the app identity best-effort to label the token.
		identity: () => Effect.succeed(AppIdentity.make({ slug: "silk-bot", name: "Silk Bot", userId: 1234 })),
	});

describe("action doubles", () => {
	it("round-trips a value through ActionState's schema", async () => {
		const recording = emptyActionState();
		const Payload = Schema.Struct({ startedAt: Schema.Number });

		const read = await Effect.runPromise(
			Effect.gen(function* () {
				const state = yield* ActionState;
				yield* state.save("k", { startedAt: 7 }, Payload);
				return yield* state.get("k", Payload);
			}).pipe(Effect.provide(actionStateTestLayer(recording))),
		);

		expect(read.startedAt).toBe(7);
		expect(recording.entries.has("k")).toBe(true);
	});

	it("answers none for an unset optional key", async () => {
		const recording = emptyActionState();
		const Payload = Schema.Struct({ startedAt: Schema.Number });

		const read = await Effect.runPromise(
			Effect.gen(function* () {
				const state = yield* ActionState;
				return yield* state.getOptional("missing", Payload);
			}).pipe(Effect.provide(actionStateTestLayer(recording))),
		);

		expect(Option.isNone(read)).toBe(true);
	});
});
