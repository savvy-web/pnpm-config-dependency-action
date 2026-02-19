import { describe, expect, it, vi } from "vitest";

// Mock @effect/platform-node to prevent NodeRuntime.runMain from executing
vi.mock("@effect/platform-node", () => ({
	NodeRuntime: { runMain: vi.fn() },
}));

// Mock @actions/core
const mockGetInput = vi.fn(() => "");
const mockGetState = vi.fn(() => "");
const mockInfo = vi.fn();
const mockWarning = vi.fn();

vi.mock("@actions/core", () => ({
	getInput: (...args: unknown[]) => mockGetInput(...args),
	getState: (...args: unknown[]) => mockGetState(...args),
	info: (...args: unknown[]) => mockInfo(...args),
	warning: (...args: unknown[]) => mockWarning(...args),
	debug: vi.fn(),
	getBooleanInput: vi.fn(() => false),
}));

// Mock auth module
const mockRevokeToken = vi.fn();
vi.mock("./lib/github/auth.js", () => ({
	revokeInstallationToken: (...args: unknown[]) => mockRevokeToken(...args),
}));

import { Effect, LogLevel, Logger } from "effect";
import { program } from "./post.js";

const runProgram = () => Effect.runPromise(program.pipe(Logger.withMinimumLogLevel(LogLevel.None)));

describe("post.ts program", () => {
	it("skips revocation when skip-token-revoke is true", async () => {
		mockGetInput.mockImplementation((key: string) => {
			if (key === "skip-token-revoke") return "true";
			return "";
		});

		await runProgram();

		expect(mockRevokeToken).not.toHaveBeenCalled();
		expect(mockInfo).toHaveBeenCalledWith("Token revocation skipped");
	});

	it("warns when no token in state", async () => {
		mockGetInput.mockReturnValue("");
		mockGetState.mockReturnValue("");

		await runProgram();

		expect(mockWarning).toHaveBeenCalledWith("No token to revoke");
		expect(mockRevokeToken).not.toHaveBeenCalled();
	});

	it("revokes token successfully", async () => {
		mockGetInput.mockReturnValue("");
		mockGetState.mockImplementation((key: string) => {
			if (key === "token") return "ghs_test_token";
			return "";
		});
		mockRevokeToken.mockReturnValue(Effect.void);

		await runProgram();

		expect(mockRevokeToken).toHaveBeenCalledWith("ghs_test_token");
		expect(mockInfo).toHaveBeenCalledWith("Post-action cleanup complete");
	});

	it("logs warning but does not fail when revocation fails", async () => {
		mockGetInput.mockReturnValue("");
		mockGetState.mockImplementation((key: string) => {
			if (key === "token") return "ghs_test_token";
			return "";
		});

		const { AuthenticationError } = await import("./lib/schemas/errors.js");
		mockRevokeToken.mockReturnValue(Effect.fail(new AuthenticationError({ reason: "Network error" })));

		await runProgram();

		expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining("Failed to revoke token"));
	});
});
