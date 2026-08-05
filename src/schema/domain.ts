/**
 * Effect Schema definitions for silk-update-action.
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
export const NonEmptyString = Schema.String.check(Schema.isMinLength(1, { message: "Value must not be empty" }));

/**
 * Dependency type discriminator.
 *
 * - "config" for config dependencies in pnpm-workspace.yaml
 * - "dependency" for runtime dependencies detected in lockfile
 * - "devDependency" for dev dependencies updated by RegularDeps
 * - "peerDependency" for peer dependencies synced by PeerSync
 * - "optionalDependency" for optional dependencies
 * - "runtime" for devEngines.runtime engine bumps (node/deno/bun)
 */
export const DependencyType = Schema.Literals([
	"config",
	"dependency",
	"devDependency",
	"peerDependency",
	"optionalDependency",
	"runtime",
]);

/**
 * File system operation type.
 */
export const FileSystemOperation = Schema.Literals(["read", "write", "delete", "exists"]);

/**
 * Lockfile operation type.
 */
export const LockfileOperation = Schema.Literals(["read", "parse", "compare"]);

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
}).annotate({
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
}).annotate({
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
}).annotate({
	identifier: "ChangedPackage",
	title: "Changed Package",
});

export type ChangedPackage = typeof ChangedPackage.Type;

/**
 * Changeset bump type.
 */
export const ChangesetBumpType = Schema.Literals(["patch", "minor", "major"]);

/**
 * Changeset file to create.
 */
export const ChangesetFile = Schema.Struct({
	id: NonEmptyString.annotate({
		description: "Unique changeset identifier",
	}),
	packages: Schema.Array(Schema.String).annotate({
		description: "Packages affected by this changeset",
	}),
	type: ChangesetBumpType,
	summary: NonEmptyString.annotate({
		description: "Human-readable summary of changes",
	}),
}).annotate({
	identifier: "ChangesetFile",
	title: "Changeset File",
});

export type ChangesetFile = typeof ChangesetFile.Type;

/**
 * Pull request information.
 */
export const PullRequestResult = Schema.Struct({
	number: Schema.Number.check(Schema.isGreaterThan(0)),
	url: Schema.String.check(Schema.isStartsWith("https://")),
	created: Schema.Boolean,
	nodeId: Schema.String,
}).annotate({
	identifier: "PullRequestResult",
	title: "Pull Request Result",
});

export type PullRequestResult = typeof PullRequestResult.Type;

/**
 * One catalog entry's fate in a compat-mode merge. Drives the PR's Catalog
 * Changes table — on a plugin bump this table is the actual payload of the run.
 */
export const CatalogDelta = Schema.Struct({
	catalog: NonEmptyString,
	dependency: NonEmptyString,
	from: Schema.NullOr(Schema.String),
	to: Schema.NullOr(Schema.String),
	action: Schema.Literals(["added", "updated", "removed", "kept"]),
}).annotate({
	identifier: "CatalogDelta",
	title: "Catalog Delta",
});

export type CatalogDelta = typeof CatalogDelta.Type;

/**
 * Lockfile change detected during comparison.
 */
export const LockfileChange = Schema.Struct({
	type: DependencyType,
	dependency: NonEmptyString,
	from: Schema.NullOr(Schema.String),
	to: NonEmptyString,
	affectedPackages: Schema.Array(Schema.String),
}).annotate({
	identifier: "LockfileChange",
	title: "Lockfile Change",
});

export type LockfileChange = typeof LockfileChange.Type;
