/**
 * Effect Schema definitions for pnpm-config-dependency-action.
 *
 * Uses Schema for type inference, validation, and encoding/decoding.
 * Types are derived from schemas, eliminating duplication.
 *
 * @module schemas
 */

import { Schema } from "effect";

// ══════════════════════════════════════════════════════════════════════════════
// Primitive Schemas
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Non-empty string with validation.
 */
export const NonEmptyString = Schema.String.pipe(Schema.minLength(1, { message: () => "Value must not be empty" }));

/**
 * Dependency type (config or regular).
 */
export const DependencyType = Schema.Literal("config", "regular");

/**
 * Git operation type.
 */
export const GitOperation = Schema.Literal("status", "diff", "commit", "push", "rebase", "checkout", "fetch", "branch");

/**
 * File system operation type.
 */
export const FileSystemOperation = Schema.Literal("read", "write", "delete", "exists");

/**
 * Lockfile operation type.
 */
export const LockfileOperation = Schema.Literal("read", "parse", "compare");

// ══════════════════════════════════════════════════════════════════════════════
// Domain Schemas
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Branch management result.
 */
export const BranchResult = Schema.Struct({
	branch: NonEmptyString,
	created: Schema.Boolean,
	upToDate: Schema.Boolean,
	baseRef: Schema.String,
}).annotations({
	identifier: "BranchResult",
	title: "Branch Result",
});

export type BranchResult = typeof BranchResult.Type;

/**
 * Single dependency change info.
 */
export const DependencyChange = Schema.Struct({
	dependency: NonEmptyString,
	from: Schema.NullOr(Schema.String),
	to: NonEmptyString,
});

export type DependencyChange = typeof DependencyChange.Type;

/**
 * Dependency update result.
 */
export const DependencyUpdateResult = Schema.Struct({
	dependency: NonEmptyString,
	from: Schema.NullOr(Schema.String),
	to: NonEmptyString,
	type: DependencyType,
	package: Schema.NullOr(Schema.String),
}).annotations({
	identifier: "DependencyUpdateResult",
	title: "Dependency Update Result",
});

export type DependencyUpdateResult = typeof DependencyUpdateResult.Type;

/**
 * Changed package information.
 */
export const ChangedPackage = Schema.Struct({
	name: NonEmptyString,
	path: Schema.String,
	version: Schema.String,
	changes: Schema.Array(DependencyChange),
}).annotations({
	identifier: "ChangedPackage",
	title: "Changed Package",
});

export type ChangedPackage = typeof ChangedPackage.Type;

/**
 * Changeset bump type.
 */
export const ChangesetBumpType = Schema.Literal("patch", "minor", "major");

/**
 * Changeset file to create.
 */
export const ChangesetFile = Schema.Struct({
	id: NonEmptyString.annotations({
		description: "Unique changeset identifier",
	}),
	packages: Schema.Array(Schema.String).annotations({
		description: "Packages affected by this changeset",
	}),
	type: ChangesetBumpType,
	summary: NonEmptyString.annotations({
		description: "Human-readable summary of changes",
	}),
}).annotations({
	identifier: "ChangesetFile",
	title: "Changeset File",
});

export type ChangesetFile = typeof ChangesetFile.Type;

/**
 * Pull request information.
 */
export const PullRequest = Schema.Struct({
	number: Schema.Number.pipe(Schema.positive()),
	url: Schema.String.pipe(Schema.startsWith("https://")),
	created: Schema.Boolean,
	nodeId: Schema.String,
}).annotations({
	identifier: "PullRequest",
	title: "Pull Request",
});

export type PullRequest = typeof PullRequest.Type;

/**
 * Lockfile change detected during comparison.
 */
export const LockfileChange = Schema.Struct({
	type: DependencyType,
	dependency: NonEmptyString,
	from: Schema.NullOr(Schema.String),
	to: NonEmptyString,
	affectedPackages: Schema.Array(Schema.String),
}).annotations({
	identifier: "LockfileChange",
	title: "Lockfile Change",
});

export type LockfileChange = typeof LockfileChange.Type;
