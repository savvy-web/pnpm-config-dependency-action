import { describe, expect, it } from "vitest";

import {
	ChangesetError,
	FileSystemError,
	InvalidInputError,
	LockfileError,
	getErrorMessage,
} from "../../../src/errors/errors.js";

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

describe("getErrorMessage", () => {
	it("returns message for each error type", () => {
		expect(getErrorMessage(new InvalidInputError({ field: "f", value: "v", reason: "r" }))).toBe(
			'Invalid input for "f": r',
		);
		expect(getErrorMessage(new ChangesetError({ reason: "r" }))).toBe("Changeset error: r");
		expect(getErrorMessage(new FileSystemError({ operation: "write", path: "p", reason: "r" }))).toBe(
			'File write failed for "p": r',
		);
		expect(getErrorMessage(new LockfileError({ operation: "parse", reason: "r" }))).toBe("Lockfile parse failed: r");
	});
});

describe("the error surface itself", () => {
	/**
	 * Guards the deletion this suite shrank for. `GitHubApiError`, `GitError`,
	 * `PnpmError` and `DependencyUpdateFailures` were declared, exported and
	 * tested here while nothing in `src/` ever constructed them — the tests
	 * passed precisely because they were the only callers. Re-adding an error
	 * class without a construction site should fail something, so it fails this.
	 */
	it("exports no error class that `src/` never constructs", async () => {
		const errors = await import("../../../src/errors/errors.js");
		const exported = Object.keys(errors).filter((name) => name.endsWith("Error") || name.endsWith("Failures"));

		expect(exported.sort()).toEqual(["ChangesetError", "FileSystemError", "InvalidInputError", "LockfileError"]);
	});
});
