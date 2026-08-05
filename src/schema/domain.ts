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
	number: Schema.Int.check(Schema.isGreaterThan(0)),
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

// ══════════════════════════════════════════════════════════════════════════════
// The structured `result` output
// ══════════════════════════════════════════════════════════════════════════════

/**
 * The whole run, as one machine-readable document.
 *
 * Published as the `result` action output alongside — never instead of — the
 * four scalar outputs, which stay byte-for-byte what they were. This is
 * **additive**: a workflow reading `has-changes` keeps working untouched.
 *
 * @remarks
 * Composed entirely from the schemas the run already produces, rather than a
 * parallel reporting shape: {@link DependencyUpdateResult}, {@link CatalogDelta},
 * {@link LockfileChange}, {@link ChangesetFile} and {@link PullRequestResult}.
 * That is deliberate — a second shape would drift from the first, and the drift
 * would be invisible because both would still serialize.
 *
 * Every field is required and non-nullable except `pullRequest`, which is
 * genuinely absent on a dry run or after a degraded PR failure. Arrays are empty
 * rather than omitted, so a consumer can index without guarding.
 */
export const RunResultDocument = Schema.Struct({
	schemaVersion: Schema.Literal(1).annotate({
		description: "Document format version. Incremented only on a breaking change to this shape.",
	}),
	hasChanges: Schema.Boolean.annotate({
		description: "Whether the run produced any committable change.",
	}),
	dryRun: Schema.Boolean.annotate({
		description: "Whether the run was a rehearsal that skipped commit, push and PR.",
	}),
	packageManager: Schema.NullOr(Schema.Literals(["pnpm", "bun", "npm"])).annotate({
		description:
			"The package manager detected for this run, or null when the run ended before detection. " +
			"Null rather than a placeholder: a value that decodes and is false is worse than an absent one, " +
			"because a consumer branching on it has no way to know it is branching on a lie.",
	}),
	workspaceRoot: Schema.String.annotate({
		description: "Absolute path of the workspace root every step read and wrote at.",
	}),
	branch: Schema.String.annotate({ description: "The update branch this run wrote to." }),
	targetBranch: Schema.String.annotate({ description: "The branch the pull request targets." }),
	updates: Schema.Array(DependencyUpdateResult).annotate({
		description: "Every dependency, runtime and package-manager change, one entry per (path, dependency, section).",
	}),
	catalogDeltas: Schema.Array(CatalogDelta).annotate({
		description: "Per-catalog merge outcomes. Non-empty only under bun's compat-catalog mode.",
	}),
	lockfileChanges: Schema.Array(LockfileChange).annotate({
		description: "Resolved-version movements observed between the before and after lockfile snapshots.",
	}),
	changesets: Schema.Array(ChangesetFile).annotate({
		description: "Changesets written by the changeset step.",
	}),
	pullRequest: Schema.NullOr(PullRequestResult).annotate({
		description: "The pull request opened or updated, or null on a dry run or a degraded PR failure.",
	}),
}).annotate({
	identifier: "RunResultDocument",
	title: "Silk Update Action Run Result",
	description: "The complete outcome of one silk-update-action run, published as the `result` output.",
});

/** The decoded {@link RunResultDocument} type. */
export type RunResultDocument = typeof RunResultDocument.Type;
