import { describe, expect, it, vi } from "vitest";

// Mock @effect/platform-node to prevent NodeRuntime.runMain from executing
vi.mock("@effect/platform-node", () => ({
	NodeRuntime: { runMain: vi.fn() },
}));

// Mock @actions/core
const mockSaveState = vi.fn();
const mockSetSecret = vi.fn();
const mockSetOutput = vi.fn();
const mockSetFailed = vi.fn();
const mockGetInput = vi.fn(() => "");
const mockInfo = vi.fn();
const mockDebug = vi.fn();

vi.mock("@actions/core", () => ({
	getInput: (...args: unknown[]) => mockGetInput(...args),
	saveState: (...args: unknown[]) => mockSaveState(...args),
	setSecret: (...args: unknown[]) => mockSetSecret(...args),
	setOutput: (...args: unknown[]) => mockSetOutput(...args),
	setFailed: (...args: unknown[]) => mockSetFailed(...args),
	info: (...args: unknown[]) => mockInfo(...args),
	debug: (...args: unknown[]) => mockDebug(...args),
	getBooleanInput: vi.fn(() => false),
}));

// Mock auth module
const mockGenerateToken = vi.fn();
vi.mock("./lib/github/auth.js", () => ({
	generateInstallationToken: (...args: unknown[]) => mockGenerateToken(...args),
}));

import { Effect, LogLevel, Logger } from "effect";
import { program } from "./pre.js";

const runProgram = () => Effect.runPromise(program.pipe(Logger.withMinimumLogLevel(LogLevel.None)));

describe("pre.ts program", () => {
	it("generates token and saves state on success", async () => {
		mockGetInput.mockImplementation((key: string) => {
			if (key === "app-id") return "123";
			if (key === "app-private-key") return "private-key";
			return "";
		});

		mockGenerateToken.mockReturnValue(
			Effect.succeed({
				token: "ghs_test_token",
				expiresAt: "2024-01-01T01:00:00Z",
				installationId: 42,
				appSlug: "my-app",
			}),
		);

		await runProgram();

		expect(mockSetSecret).toHaveBeenCalledWith("ghs_test_token");
		expect(mockSaveState).toHaveBeenCalledWith("token", "ghs_test_token");
		expect(mockSaveState).toHaveBeenCalledWith("expiresAt", "2024-01-01T01:00:00Z");
		expect(mockSaveState).toHaveBeenCalledWith("installationId", "42");
		expect(mockSaveState).toHaveBeenCalledWith("appSlug", "my-app");
		expect(mockSetOutput).toHaveBeenCalledWith("token", "ghs_test_token");
	});

	it("saves startTime to state", async () => {
		mockGetInput.mockImplementation((key: string) => {
			if (key === "app-id") return "123";
			if (key === "app-private-key") return "key";
			return "";
		});

		mockGenerateToken.mockReturnValue(
			Effect.succeed({
				token: "tok",
				expiresAt: "2024-01-01T00:00:00Z",
				installationId: 1,
				appSlug: "app",
			}),
		);

		await runProgram();

		expect(mockSaveState).toHaveBeenCalledWith("startTime", expect.any(String));
	});

	it("calls setFailed when app-id is missing", async () => {
		mockGetInput.mockReturnValue("");

		await runProgram();

		expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining("Pre-action failed"));
	});

	it("calls setFailed when token generation fails", async () => {
		mockGetInput.mockImplementation((key: string) => {
			if (key === "app-id") return "123";
			if (key === "app-private-key") return "key";
			return "";
		});

		const { AuthenticationError } = await import("./lib/schemas/errors.js");
		mockGenerateToken.mockReturnValue(
			Effect.fail(new AuthenticationError({ reason: "Bad credentials", appId: "123" })),
		);

		await runProgram();

		expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining("Pre-action failed"));
	});
});
