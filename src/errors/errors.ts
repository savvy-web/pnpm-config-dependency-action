/**
 * The action's typed error union.
 *
 * Every member is a `Schema.TaggedError` carrying the metadata its handler
 * needs, and every member has a construction site in `src/` — an error class
 * with no producer is a claim the type system carries indefinitely and no test
 * can falsify, which is why four of them were deleted and why
 * `__test__/unit/errors/errors.test.ts` pins the exported set.
 *
 * @module errors/errors
 */

import { Schema } from "effect";

import { FileSystemOperation, LockfileOperation, NonEmptyString } from "../schema/domain.js";

// ══════════════════════════════════════════════════════════════════════════════
// Error Schemas
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Input validation error.
 */
export class InvalidInputError extends Schema.TaggedError<InvalidInputError>()("InvalidInputError", {
	field: NonEmptyString.annotate({
		description: "The input field that failed validation",
	}),
	value: Schema.Unknown.annotate({
		description: "The invalid value that was provided",
	}),
	reason: NonEmptyString.annotate({
		description: "Human-readable explanation of why validation failed",
	}),
}) {
	get message() {
		return `Invalid input for "${this.field}": ${this.reason}`;
	}
}

/**
 * Changeset creation error.
 */
export class ChangesetError extends Schema.TaggedError<ChangesetError>()("ChangesetError", {
	reason: NonEmptyString.annotate({
		description: "Why changeset creation failed",
	}),
	packages: Schema.optional(Schema.Array(Schema.String)).annotate({
		description: "Packages that were affected",
	}),
}) {
	get message() {
		const pkgInfo = this.packages?.length ? ` (packages: ${this.packages.join(", ")})` : "";
		return `Changeset error${pkgInfo}: ${this.reason}`;
	}
}

/**
 * File system operation error.
 */
export class FileSystemError extends Schema.TaggedError<FileSystemError>()("FileSystemError", {
	operation: FileSystemOperation.annotate({
		description: "The file operation that failed",
	}),
	path: NonEmptyString.annotate({
		description: "The file path that was being operated on",
	}),
	reason: NonEmptyString.annotate({
		description: "Why the operation failed",
	}),
}) {
	get message() {
		return `File ${this.operation} failed for "${this.path}": ${this.reason}`;
	}
}

/**
 * Lockfile parsing/comparison error.
 */
export class LockfileError extends Schema.TaggedError<LockfileError>()("LockfileError", {
	operation: LockfileOperation.annotate({
		description: "The lockfile operation that failed",
	}),
	reason: NonEmptyString.annotate({
		description: "Why the operation failed",
	}),
}) {
	get message() {
		return `Lockfile ${this.operation} failed: ${this.reason}`;
	}
}

// ══════════════════════════════════════════════════════════════════════════════
// Union Types
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Union of every error this action actually raises.
 *
 * Each member has at least one construction site in `src/`. `GitHubApiError`,
 * `GitError`, `PnpmError` and `DependencyUpdateFailures` used to sit here and
 * were removed: nothing constructed them. GitHub failures arrive as the kit's
 * single `GitHubError` (discriminated with `hasKind`) and subprocess failures
 * as `@effected/commands`' `CommandFailedError` / `CommandOutputError`, so
 * neither the API nor the subprocess members had a reachable failure path.
 * `isRetryableError` went with them — it dispatched only on those three tags
 * and had no caller in `src/`.
 *
 * Keep it that way: an error channel with no construction site is a claim the
 * type system will happily carry and no test can falsify.
 */
export type ActionError = InvalidInputError | ChangesetError | FileSystemError | LockfileError;

// ══════════════════════════════════════════════════════════════════════════════
// Error Utilities
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Get a human-readable error message for any action error.
 */
export const getErrorMessage = (error: ActionError): string => {
	return error.message;
};
