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
const mockGenerateToken = vi.fn();
vi.mock("./lib/github/auth.js", () => ({
	generateInstallationToken: (...args: unknown[]) => mockGenerateToken(...args),
}));

import { program } from "./pre.js";

const makeTestLayer = (inputs: Record<string, string>) => {
	const outputState = ActionOutputsTest.empty();
	const logState = ActionLoggerTest.empty();
	const stateState = ActionStateTest.empty();
	const layer = Layer.mergeAll(
		ActionInputsTest.layer(inputs),
		ActionOutputsTest.layer(outputState),
		ActionLoggerTest.layer(logState),
		ActionStateTest.layer(stateState),
	);
	return { outputState, logState, stateState, layer };
};

const runProgram = (layer: Layer.Layer<never, never, never>) =>
	Effect.runPromise(Effect.exit(program.pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None))));

describe("pre.ts program", () => {
	it("generates token and saves state on success", async () => {
		const { layer, outputState, stateState } = makeTestLayer({
			"app-id": "123",
			"app-private-key": "private-key",
		});

		mockGenerateToken.mockReturnValue(
			Effect.succeed({
				token: "ghs_test_token",
				expiresAt: "2024-01-01T01:00:00Z",
				installationId: 42,
				appSlug: "my-app",
			}),
		);

		await runProgram(layer as Layer.Layer<never, never, never>);

		// Token should be set as secret
		expect(outputState.secrets).toContain("ghs_test_token");

		// Token should be set as output
		expect(outputState.outputs).toContainEqual({ name: "token", value: "ghs_test_token" });

		// State should contain token data
		const tokenStateRaw = stateState.entries.get("tokenState") ?? "{}";
		const tokenState = JSON.parse(tokenStateRaw);
		expect(tokenState.token).toBe("ghs_test_token");
		expect(tokenState.expiresAt).toBe("2024-01-01T01:00:00Z");
		expect(tokenState.installationId).toBe(42);
		expect(tokenState.appSlug).toBe("my-app");
	});

	it("saves startTime to state", async () => {
		const { layer, stateState } = makeTestLayer({
			"app-id": "123",
			"app-private-key": "key",
		});

		mockGenerateToken.mockReturnValue(
			Effect.succeed({
				token: "tok",
				expiresAt: "2024-01-01T00:00:00Z",
				installationId: 1,
				appSlug: "app",
			}),
		);

		await runProgram(layer as Layer.Layer<never, never, never>);

		expect(stateState.entries.has("startTime")).toBe(true);
	});

	it("fails when app-id is missing", async () => {
		const { layer } = makeTestLayer({});

		const exit = await runProgram(layer as Layer.Layer<never, never, never>);

		expect(exit._tag).toBe("Failure");
	});

	it("fails when token generation fails", async () => {
		const { layer } = makeTestLayer({
			"app-id": "123",
			"app-private-key": "key",
		});

		const { AuthenticationError } = await import("./lib/schemas/errors.js");
		mockGenerateToken.mockReturnValue(
			Effect.fail(new AuthenticationError({ reason: "Bad credentials", appId: "123" })),
		);

		const exit = await runProgram(layer as Layer.Layer<never, never, never>);

		expect(exit._tag).toBe("Failure");
	});
});
