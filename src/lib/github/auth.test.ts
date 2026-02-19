import { describe, expect, it, vi } from "vitest";

// Mock @actions/core
vi.mock("@actions/core", () => ({
	debug: vi.fn(),
	info: vi.fn(),
	warning: vi.fn(),
	getInput: vi.fn(() => ""),
	getBooleanInput: vi.fn(() => false),
}));

// Mock @actions/github
vi.mock("@actions/github", () => ({
	context: {
		repo: { owner: "test-owner", repo: "test-repo" },
		sha: "abc123",
	},
}));

// Hoist mock variables so they're available in vi.mock factories
const { mockAuth, mockRequest } = vi.hoisted(() => ({
	mockAuth: vi.fn(),
	mockRequest: vi.fn(),
}));

// Mock @octokit/auth-app
vi.mock("@octokit/auth-app", () => ({
	createAppAuth: vi.fn(() => mockAuth),
}));

// Mock @octokit/request
vi.mock("@octokit/request", () => ({
	request: mockRequest,
}));

import { Effect, Either, LogLevel, Logger } from "effect";
import { generateInstallationToken, revokeInstallationToken } from "./auth.js";

const runEffect = <A, E>(effect: Effect.Effect<A, E>) =>
	Effect.runPromise(Effect.either(effect).pipe(Logger.withMinimumLogLevel(LogLevel.None)));

describe("generateInstallationToken", () => {
	it("generates token successfully", async () => {
		mockAuth
			.mockResolvedValueOnce({ token: "app-jwt-token" }) // app auth
			.mockResolvedValueOnce({
				token: "ghs_installation_token",
				expiresAt: "2024-01-01T01:00:00Z",
			}); // installation auth

		mockRequest
			.mockResolvedValueOnce({ data: { id: 12345 } }) // installation ID
			.mockResolvedValueOnce({ data: { slug: "my-test-app" } }); // app slug

		const result = await runEffect(generateInstallationToken("123", "private-key"));

		expect(Either.isRight(result)).toBe(true);
		if (Either.isRight(result)) {
			expect(result.right.token).toBe("ghs_installation_token");
			expect(result.right.installationId).toBe(12345);
			expect(result.right.appSlug).toBe("my-test-app");
		}
	});

	it("fails when app auth fails", async () => {
		mockAuth.mockRejectedValueOnce(new Error("Invalid private key"));

		const result = await runEffect(generateInstallationToken("123", "bad-key"));

		expect(Either.isLeft(result)).toBe(true);
		if (Either.isLeft(result)) {
			expect(result.left._tag).toBe("AuthenticationError");
		}
	});

	it("fails when installation ID fetch fails", async () => {
		mockAuth.mockResolvedValueOnce({ token: "app-jwt-token" });
		mockRequest.mockRejectedValueOnce(new Error("Not found"));

		const result = await runEffect(generateInstallationToken("123", "private-key"));

		expect(Either.isLeft(result)).toBe(true);
		if (Either.isLeft(result)) {
			expect(result.left._tag).toBe("AuthenticationError");
		}
	});

	it("fails when installation token generation fails", async () => {
		mockAuth
			.mockResolvedValueOnce({ token: "app-jwt-token" })
			.mockRejectedValueOnce(new Error("Token generation failed"));

		mockRequest.mockResolvedValueOnce({ data: { id: 12345 } });

		const result = await runEffect(generateInstallationToken("123", "private-key"));

		expect(Either.isLeft(result)).toBe(true);
		if (Either.isLeft(result)) {
			expect(result.left._tag).toBe("AuthenticationError");
		}
	});

	it("falls back to 'unknown' when app slug fetch fails", async () => {
		mockAuth.mockResolvedValueOnce({ token: "app-jwt-token" }).mockResolvedValueOnce({
			token: "ghs_token",
			expiresAt: "2024-01-01T01:00:00Z",
		});

		mockRequest
			.mockResolvedValueOnce({ data: { id: 12345 } }) // installation ID
			.mockRejectedValueOnce(new Error("Not found")); // app slug fails

		const result = await runEffect(generateInstallationToken("123", "private-key"));

		expect(Either.isRight(result)).toBe(true);
		if (Either.isRight(result)) {
			expect(result.right.appSlug).toBe("unknown");
		}
	});

	it("uses default expiresAt when not provided", async () => {
		mockAuth.mockResolvedValueOnce({ token: "app-jwt-token" }).mockResolvedValueOnce({
			token: "ghs_token",
			expiresAt: undefined,
		});

		mockRequest.mockResolvedValueOnce({ data: { id: 12345 } }).mockResolvedValueOnce({ data: { slug: "my-app" } });

		const result = await runEffect(generateInstallationToken("123", "private-key"));

		expect(Either.isRight(result)).toBe(true);
		if (Either.isRight(result)) {
			expect(result.right.expiresAt).toBeTruthy();
		}
	});
});

describe("revokeInstallationToken", () => {
	it("revokes token successfully", async () => {
		mockRequest.mockResolvedValueOnce(undefined);

		const result = await runEffect(revokeInstallationToken("ghs_token"));

		expect(Either.isRight(result)).toBe(true);
		expect(mockRequest).toHaveBeenCalledWith("DELETE /installation/token", {
			headers: { authorization: "Bearer ghs_token" },
		});
	});

	it("fails when revocation request fails", async () => {
		mockRequest.mockRejectedValueOnce(new Error("Network error"));

		const result = await runEffect(revokeInstallationToken("ghs_token"));

		expect(Either.isLeft(result)).toBe(true);
		if (Either.isLeft(result)) {
			expect(result.left._tag).toBe("AuthenticationError");
		}
	});
});
