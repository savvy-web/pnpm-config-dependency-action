import {
	ActionInputsTest,
	ActionLoggerTest,
	ActionOutputsTest,
	ActionStateTest,
} from "@savvy-web/github-action-effects";
import { Effect, Layer, LogLevel, Logger } from "effect";
import { describe, expect, it, vi } from "vitest";

// Mock Action.run to prevent module-level execution
vi.mock("@savvy-web/github-action-effects", async (importActual) => {
	const actual = await importActual<typeof import("@savvy-web/github-action-effects")>();
	return {
		...actual,
		Action: {
			...actual.Action,
			run: vi.fn(),
		},
	};
});

// Mock auth module
const mockRevokeToken = vi.fn();
vi.mock("./lib/github/auth.js", () => ({
	revokeInstallationToken: (...args: unknown[]) => mockRevokeToken(...args),
}));

import { program } from "./post.js";

const makeTestLayer = (stateEntries: Record<string, unknown> = {}) => {
	const outputState = ActionOutputsTest.empty();
	const logState = ActionLoggerTest.empty();
	const stateState = ActionStateTest.empty();

	// Pre-populate state entries (simulating what pre.ts saved)
	for (const [key, value] of Object.entries(stateEntries)) {
		stateState.entries.set(key, JSON.stringify(value));
	}

	const layer = Layer.mergeAll(
		ActionInputsTest.layer({}),
		ActionOutputsTest.layer(outputState),
		ActionLoggerTest.layer(logState),
		ActionStateTest.layer(stateState),
	);
	return { outputState, logState, stateState, layer };
};

const runProgram = (layer: Layer.Layer<never, never, never>) =>
	Effect.runPromise(program.pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)));

describe("post.ts program", () => {
	it("skips revocation when skipTokenRevoke state is true", async () => {
		const { layer } = makeTestLayer({
			skipTokenRevoke: { value: "true" },
		});

		await runProgram(layer as Layer.Layer<never, never, never>);

		expect(mockRevokeToken).not.toHaveBeenCalled();
	});

	it("warns when no token in state", async () => {
		const { layer } = makeTestLayer();

		await runProgram(layer as Layer.Layer<never, never, never>);

		expect(mockRevokeToken).not.toHaveBeenCalled();
	});

	it("revokes token successfully", async () => {
		const { layer } = makeTestLayer({
			tokenState: {
				token: "ghs_test_token",
				expiresAt: "2024-01-01T01:00:00Z",
				installationId: 42,
				appSlug: "my-app",
			},
		});
		mockRevokeToken.mockReturnValue(Effect.void);

		await runProgram(layer as Layer.Layer<never, never, never>);

		expect(mockRevokeToken).toHaveBeenCalledWith("ghs_test_token");
	});

	it("logs warning but does not fail when revocation fails", async () => {
		const { layer } = makeTestLayer({
			tokenState: {
				token: "ghs_test_token",
				expiresAt: "2024-01-01T01:00:00Z",
				installationId: 42,
				appSlug: "my-app",
			},
		});

		const { AuthenticationError } = await import("./lib/schemas/errors.js");
		mockRevokeToken.mockReturnValue(Effect.fail(new AuthenticationError({ reason: "Network error" })));

		// Should not throw - warning is logged but program completes
		await runProgram(layer as Layer.Layer<never, never, never>);

		// If we get here, the program didn't throw
		expect(true).toBe(true);
	});
});
