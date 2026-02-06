/**
 * Typed error definitions using Effect Schema TaggedError.
 *
 * Re-exports schema-based errors for backward compatibility.
 * All errors are now defined using Effect Schema in lib/schemas/errors.ts.
 *
 * @module errors
 */

export type { ActionError, DependencyFailure } from "../schemas/errors.js";
// Re-export all errors from schemas
export {
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
} from "../schemas/errors.js";
