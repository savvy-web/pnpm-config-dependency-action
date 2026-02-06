import { describe, expect, it } from "vitest";

import {
	AuthenticationError,
	ChangesetError,
	DependencyUpdateFailures,
	FileSystemError,
	GitError,
	GitHubApiError,
	InvalidInputError,
	LockfileError,
	PnpmError,
	getErrorMessage,
	isRetryableError,
} from "./errors.js";

describe("InvalidInputError", () => {
	it("constructs with field, value, and reason", () => {
		const error = new InvalidInputError({ field: "branch", value: "invalid branch!", reason: "Invalid characters" });

		expect(error._tag).toBe("InvalidInputError");
		expect(error.field).toBe("branch");
		expect(error.value).toBe("invalid branch!");
		expect(error.reason).toBe("Invalid characters");
	});

	it("has a descriptive message", () => {
		const error = new InvalidInputError({ field: "appId", value: "", reason: "Must not be empty" });

		expect(error.message).toBe('Invalid input for "appId": Must not be empty');
	});
});

describe("AuthenticationError", () => {
	it("constructs with reason only", () => {
		const error = new AuthenticationError({ reason: "Token expired" });

		expect(error._tag).toBe("AuthenticationError");
		expect(error.reason).toBe("Token expired");
		expect(error.appId).toBeUndefined();
	});

	it("constructs with appId", () => {
		const error = new AuthenticationError({ reason: "Invalid key", appId: "12345" });

		expect(error.appId).toBe("12345");
		expect(error.message).toBe("Authentication failed (app: 12345): Invalid key");
	});

	it("message without appId omits app info", () => {
		const error = new AuthenticationError({ reason: "Token expired" });

		expect(error.message).toBe("Authentication failed: Token expired");
	});
});

describe("GitHubApiError", () => {
	it("constructs with operation and message", () => {
		const error = new GitHubApiError({ operation: "repos.getBranch", message: "Not found" });

		expect(error._tag).toBe("GitHubApiError");
		expect(error.operation).toBe("repos.getBranch");
		expect(error.message).toBe("Not found");
	});

	it("isRateLimited returns true for 429", () => {
		const error = new GitHubApiError({ operation: "test", statusCode: 429, message: "Rate limited" });
		expect(error.isRateLimited).toBe(true);
	});

	it("isRateLimited returns false for other codes", () => {
		const error = new GitHubApiError({ operation: "test", statusCode: 500, message: "Error" });
		expect(error.isRateLimited).toBe(false);
	});

	it("isServerError returns true for 5xx", () => {
		const error = new GitHubApiError({ operation: "test", statusCode: 503, message: "Unavailable" });
		expect(error.isServerError).toBe(true);
	});

	it("isServerError returns false for 4xx", () => {
		const error = new GitHubApiError({ operation: "test", statusCode: 404, message: "Not found" });
		expect(error.isServerError).toBe(false);
	});

	it("isRetryable returns true for rate limited or server errors", () => {
		expect(new GitHubApiError({ operation: "test", statusCode: 429, message: "Rate limited" }).isRetryable).toBe(true);
		expect(new GitHubApiError({ operation: "test", statusCode: 500, message: "Error" }).isRetryable).toBe(true);
	});

	it("isRetryable returns false for client errors", () => {
		expect(new GitHubApiError({ operation: "test", statusCode: 404, message: "Not found" }).isRetryable).toBe(false);
	});

	it("isServerError returns false when statusCode is undefined", () => {
		const error = new GitHubApiError({ operation: "test", message: "No code" });
		expect(error.isServerError).toBe(false);
	});
});

describe("GitError", () => {
	it("constructs with operation, exitCode, and stderr", () => {
		const error = new GitError({ operation: "checkout", exitCode: 1, stderr: "branch not found" });

		expect(error._tag).toBe("GitError");
		expect(error.operation).toBe("checkout");
		expect(error.exitCode).toBe(1);
		expect(error.stderr).toBe("branch not found");
	});

	it("has a descriptive message", () => {
		const error = new GitError({ operation: "push", exitCode: 128, stderr: "rejected" });

		expect(error.message).toBe("Git push failed (exit 128): rejected");
	});

	it("isRetryable returns true for fetch and push", () => {
		expect(new GitError({ operation: "fetch", exitCode: 1, stderr: "timeout" }).isRetryable).toBe(true);
		expect(new GitError({ operation: "push", exitCode: 1, stderr: "timeout" }).isRetryable).toBe(true);
	});

	it("isRetryable returns false for other operations", () => {
		expect(new GitError({ operation: "checkout", exitCode: 1, stderr: "err" }).isRetryable).toBe(false);
		expect(new GitError({ operation: "commit", exitCode: 1, stderr: "err" }).isRetryable).toBe(false);
		expect(new GitError({ operation: "rebase", exitCode: 1, stderr: "err" }).isRetryable).toBe(false);
	});
});

describe("PnpmError", () => {
	it("constructs with command and stderr", () => {
		const error = new PnpmError({ command: "install", exitCode: 1, stderr: "ENOENT" });

		expect(error._tag).toBe("PnpmError");
		expect(error.command).toBe("install");
		expect(error.dependency).toBeUndefined();
	});

	it("constructs with optional dependency", () => {
		const error = new PnpmError({
			command: "add --config",
			dependency: "typescript",
			exitCode: 1,
			stderr: "not found",
		});

		expect(error.dependency).toBe("typescript");
		expect(error.message).toBe('pnpm add --config for "typescript" failed (exit 1): not found');
	});

	it("message without dependency omits dep info", () => {
		const error = new PnpmError({ command: "install", exitCode: 1, stderr: "ENOENT" });

		expect(error.message).toBe("pnpm install failed (exit 1): ENOENT");
	});

	it("isRetryable returns true for install command", () => {
		expect(new PnpmError({ command: "install", exitCode: 1, stderr: "err" }).isRetryable).toBe(true);
	});

	it("isRetryable returns false for other commands", () => {
		expect(new PnpmError({ command: "add --config", exitCode: 1, stderr: "err" }).isRetryable).toBe(false);
		expect(new PnpmError({ command: "up --latest", exitCode: 1, stderr: "err" }).isRetryable).toBe(false);
	});
});

describe("ChangesetError", () => {
	it("constructs with reason only", () => {
		const error = new ChangesetError({ reason: "Could not write file" });

		expect(error._tag).toBe("ChangesetError");
		expect(error.reason).toBe("Could not write file");
		expect(error.packages).toBeUndefined();
	});

	it("constructs with packages", () => {
		const error = new ChangesetError({ reason: "Failed", packages: ["@savvy-web/core"] });

		expect(error.packages).toEqual(["@savvy-web/core"]);
		expect(error.message).toBe("Changeset error (packages: @savvy-web/core): Failed");
	});

	it("message without packages omits package info", () => {
		const error = new ChangesetError({ reason: "Failed" });
		expect(error.message).toBe("Changeset error: Failed");
	});
});

describe("FileSystemError", () => {
	it("constructs with operation, path, and reason", () => {
		const error = new FileSystemError({
			operation: "read",
			path: "/path/to/file",
			reason: "ENOENT",
		});

		expect(error._tag).toBe("FileSystemError");
		expect(error.message).toBe('File read failed for "/path/to/file": ENOENT');
	});
});

describe("LockfileError", () => {
	it("constructs with operation and reason", () => {
		const error = new LockfileError({
			operation: "read",
			reason: "Invalid lockfile format",
		});

		expect(error._tag).toBe("LockfileError");
		expect(error.message).toBe("Lockfile read failed: Invalid lockfile format");
	});
});

describe("DependencyUpdateFailures", () => {
	it("constructs with failures and successful", () => {
		const error = new DependencyUpdateFailures({
			failures: [
				{
					dependency: "typescript",
					error: { command: "add --config", exitCode: 1, stderr: "not found" },
				},
			],
			successful: [{ dependency: "effect", from: "3.0.0", to: "3.1.0", type: "regular", package: null }],
		});

		expect(error._tag).toBe("DependencyUpdateFailures");
		expect(error.failures).toHaveLength(1);
		expect(error.successful).toHaveLength(1);
	});

	it("has descriptive message", () => {
		const error = new DependencyUpdateFailures({
			failures: [
				{
					dependency: "typescript",
					error: { command: "add --config", exitCode: 1, stderr: "err" },
				},
				{
					dependency: "biome",
					error: { command: "add --config", exitCode: 1, stderr: "err" },
				},
			],
			successful: [{ dependency: "effect", from: null, to: "3.1.0", type: "regular", package: null }],
		});

		expect(error.message).toBe("Failed to update 2 dependencies: typescript, biome. 1 succeeded.");
	});

	it("partialSuccess returns true when some succeeded", () => {
		const error = new DependencyUpdateFailures({
			failures: [{ dependency: "ts", error: { command: "add", exitCode: 1, stderr: "" } }],
			successful: [{ dependency: "effect", from: null, to: "3.1.0", type: "regular", package: null }],
		});

		expect(error.partialSuccess).toBe(true);
	});

	it("partialSuccess returns false when none succeeded", () => {
		const error = new DependencyUpdateFailures({
			failures: [{ dependency: "ts", error: { command: "add", exitCode: 1, stderr: "" } }],
			successful: [],
		});

		expect(error.partialSuccess).toBe(false);
	});
});

describe("isRetryableError", () => {
	it("returns true for retryable GitHubApiError", () => {
		const error = new GitHubApiError({ operation: "test", statusCode: 429, message: "Rate limited" });
		expect(isRetryableError(error)).toBe(true);
	});

	it("returns true for retryable GitError", () => {
		const error = new GitError({ operation: "fetch", exitCode: 1, stderr: "timeout" });
		expect(isRetryableError(error)).toBe(true);
	});

	it("returns true for retryable PnpmError", () => {
		const error = new PnpmError({ command: "install", exitCode: 1, stderr: "timeout" });
		expect(isRetryableError(error)).toBe(true);
	});

	it("returns false for non-retryable errors", () => {
		expect(isRetryableError(new InvalidInputError({ field: "f", value: "v", reason: "r" }))).toBe(false);
		expect(isRetryableError(new AuthenticationError({ reason: "r" }))).toBe(false);
		expect(isRetryableError(new ChangesetError({ reason: "r" }))).toBe(false);
		expect(isRetryableError(new FileSystemError({ operation: "read", path: "p", reason: "r" }))).toBe(false);
		expect(isRetryableError(new LockfileError({ operation: "read", reason: "r" }))).toBe(false);
	});
});

describe("getErrorMessage", () => {
	it("returns message for each error type", () => {
		expect(getErrorMessage(new InvalidInputError({ field: "f", value: "v", reason: "r" }))).toBe(
			'Invalid input for "f": r',
		);
		expect(getErrorMessage(new AuthenticationError({ reason: "r" }))).toBe("Authentication failed: r");
		expect(getErrorMessage(new GitHubApiError({ operation: "op", message: "msg" }))).toBe("msg");
		expect(getErrorMessage(new GitError({ operation: "push", exitCode: 1, stderr: "err" }))).toBe(
			"Git push failed (exit 1): err",
		);
		expect(getErrorMessage(new PnpmError({ command: "install", exitCode: 1, stderr: "err" }))).toBe(
			"pnpm install failed (exit 1): err",
		);
		expect(getErrorMessage(new ChangesetError({ reason: "r" }))).toBe("Changeset error: r");
		expect(getErrorMessage(new FileSystemError({ operation: "write", path: "p", reason: "r" }))).toBe(
			'File write failed for "p": r',
		);
		expect(getErrorMessage(new LockfileError({ operation: "parse", reason: "r" }))).toBe("Lockfile parse failed: r");
	});
});
