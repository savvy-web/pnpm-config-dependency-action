/**
 * Core type definitions for pnpm-config-dependency-action.
 *
 * Re-exports schema-derived types for backward compatibility.
 * All types are now defined using Effect Schema in lib/schemas/index.ts.
 *
 * @module types
 */

// Re-export types still used by domain modules
export type {
	BranchResult,
	ChangedPackage,
	ChangesetFile,
	DependencyChange,
	DependencyUpdateResult,
	LockfileChange,
	PullRequestResult,
} from "../lib/schemas/index.js";
