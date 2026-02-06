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
 * Check run status.
 */
export const CheckRunStatus = Schema.Literal("queued", "in_progress", "completed");

/**
 * Check run conclusion.
 */
export const CheckRunConclusion = Schema.Literal("success", "failure", "neutral", "cancelled", "skipped");

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
 * Action inputs from action.yml.
 */
export const ActionInputs = Schema.Struct({
	appId: NonEmptyString.annotations({
		identifier: "AppId",
		description: "GitHub App ID for authentication",
	}),
	appPrivateKey: NonEmptyString.annotations({
		identifier: "AppPrivateKey",
		description: "GitHub App private key in PEM format",
	}),
	branch: Schema.String.pipe(
		Schema.pattern(/^[a-zA-Z0-9/_-]+$/, {
			message: () => "Branch name must contain only alphanumeric characters, slashes, underscores, and hyphens",
		}),
	).annotations({
		identifier: "BranchName",
		description: "Branch name for dependency update PR",
	}),
	configDependencies: Schema.Array(Schema.String).annotations({
		description: "Config dependencies to update (exact match)",
	}),
	dependencies: Schema.Array(Schema.String).annotations({
		description: "Regular dependencies to update (supports globs)",
	}),
	run: Schema.Array(Schema.String).annotations({
		description: "Commands to run after dependency updates (one per line)",
	}),
}).annotations({
	identifier: "ActionInputs",
	title: "Action Inputs",
	description: "Parsed and validated action inputs from action.yml",
});

export type ActionInputs = typeof ActionInputs.Type;

/**
 * GitHub context for the action.
 */
export const GitHubContext = Schema.Struct({
	owner: NonEmptyString,
	repo: NonEmptyString,
	ref: Schema.String,
	sha: Schema.String.pipe(Schema.length(40)),
	defaultBranch: Schema.String,
}).annotations({
	identifier: "GitHubContext",
	title: "GitHub Context",
});

export type GitHubContext = typeof GitHubContext.Type;

/**
 * GitHub App installation token.
 */
export const InstallationToken = Schema.Struct({
	token: NonEmptyString.annotations({
		description: "The installation access token",
	}),
	expiresAt: Schema.String.annotations({
		description: "ISO 8601 timestamp when the token expires",
	}),
	installationId: Schema.Number.pipe(Schema.positive()),
	appSlug: Schema.String,
}).annotations({
	identifier: "InstallationToken",
	title: "Installation Token",
	description: "GitHub App installation token with expiration info",
});

export type InstallationToken = typeof InstallationToken.Type;

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
 * Check run information.
 */
export const CheckRun = Schema.Struct({
	id: Schema.Number.pipe(Schema.positive()),
	name: NonEmptyString,
	status: CheckRunStatus,
	conclusion: Schema.optional(CheckRunConclusion),
}).annotations({
	identifier: "CheckRun",
	title: "Check Run",
});

export type CheckRun = typeof CheckRun.Type;

/**
 * Pull request information.
 */
export const PullRequest = Schema.Struct({
	number: Schema.Number.pipe(Schema.positive()),
	url: Schema.String.pipe(Schema.startsWith("https://")),
	created: Schema.Boolean,
}).annotations({
	identifier: "PullRequest",
	title: "Pull Request",
});

export type PullRequest = typeof PullRequest.Type;

/**
 * Pull request creation data.
 */
export const PRData = Schema.Struct({
	title: NonEmptyString,
	body: Schema.String,
	head: NonEmptyString,
	base: NonEmptyString,
}).annotations({
	identifier: "PRData",
	title: "PR Data",
});

export type PRData = typeof PRData.Type;

/**
 * Git status result.
 */
export const GitStatus = Schema.Struct({
	hasChanges: Schema.Boolean,
	staged: Schema.Array(Schema.String),
	unstaged: Schema.Array(Schema.String),
	untracked: Schema.Array(Schema.String),
}).annotations({
	identifier: "GitStatus",
	title: "Git Status",
});

export type GitStatus = typeof GitStatus.Type;

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

/**
 * Complete action result.
 */
export const ActionResult = Schema.Struct({
	updates: Schema.Array(DependencyUpdateResult),
	changedPackages: Schema.Array(ChangedPackage),
	changesets: Schema.Array(ChangesetFile),
	branch: BranchResult,
	pr: Schema.NullOr(PullRequest),
	checkRun: CheckRun,
}).annotations({
	identifier: "ActionResult",
	title: "Action Result",
	description: "Complete result of the dependency update action",
});

export type ActionResult = typeof ActionResult.Type;

// ══════════════════════════════════════════════════════════════════════════════
// Decoder/Encoder Utilities
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Decode action inputs from raw GitHub Action input.
 */
export const decodeActionInputs = Schema.decodeUnknownSync(ActionInputs);

/**
 * Decode action inputs with Either result.
 */
export const decodeActionInputsEither = Schema.decodeUnknownEither(ActionInputs);
