/**
 * The action's domain schemas, and the `result` output contract built from them.
 *
 * Each schema derives its TypeScript type via `typeof Schema.Type`, so the type
 * and the validator cannot drift. {@link RunResultDocument} composes the same
 * schemas the run already produces rather than restating them in a parallel
 * reporting shape — two shapes would diverge, and the divergence would be
 * invisible because both would still serialize.
 *
 * **Every shared schema carries an explicit `identifier` annotation.** The
 * lowering hoists a sub-schema used in more than one place into `$defs` and
 * invents a *positional* name when there is none, so a second anonymous union
 * silently renames the first in a document published at a public `$id`. A
 * `$defs` key matching `Union_`/`Struct_` is a missing annotation here, not an
 * artifact to commit.
 *
 * The JSON Schema is generated from {@link RunResultDocument} by
 * `lib/scripts/generate-schema.ts` through `@effected/schemastore`'s
 * `SchemaPipeline` — lint, ajv strict-mode gate, write-if-content-changed.
 * Change the contract by editing these types and running `pnpm generate-schema`;
 * never by editing the emitted JSON.
 *
 * @module schema/domain
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
 * - "config" for config dependencies in pnpm-workspace.yaml — pnpm's
 *   `configDependencies`, and NOTHING else. It used to double as the tag for
 *   the package-manager self-upgrade, which meant this action rendered
 *   `| pnpm | config | … |` into consumers' pull requests, claiming pnpm was a
 *   config dependency (live: spencerbeggs/std-osc8#65)
 * - "dependency" for runtime dependencies detected in lockfile
 * - "devDependency" for dev dependencies updated by RegularDeps
 * - "peerDependency" for peer dependencies synced by PeerSync
 * - "optionalDependency" for optional dependencies
 * - "runtime" for devEngines.runtime engine bumps (node/deno/bun)
 * - "packageManager" for the package-manager self-upgrade (pnpm/bun/npm).
 *   Replaced a `type === "config" && dependency === "pnpm"` name match, which
 *   was wrong twice over: it mislabelled the row, and matching by NAME silently
 *   covered neither bun nor npm
 *
 * Every member must also be a member of `@savvy-web/silk-effects`'
 * `DependencyTableType`, or a row this action emits fails CSH005 in the
 * consumer's repository rather than here. That subset relation is asserted at
 * compile time in `__test__/unit/schema/domain.test.ts` — not restated as a
 * copied literal list, because a copy goes stale silently while an assertion
 * fails the build. Upstream's vocabulary also carries "workspace", which this
 * action never constructs and therefore deliberately does not declare.
 */
export const DependencyType = Schema.Literals([
	"config",
	"dependency",
	"devDependency",
	"peerDependency",
	"optionalDependency",
	"runtime",
	"packageManager",
]).annotate({
	identifier: "DependencyType",
	title: "Dependency Type",
});

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
 * One unsatisfied peer dependency in the installed graph.
 *
 * `found` is the version actually resolved for the peer, or `null` when nothing
 * resolved at all. **That null IS the "missing" case** — there is deliberately no
 * separate discriminant, because a second field encoding the same fact can
 * contradict the first, and a consumer would have no way to know which to trust.
 *
 * `optional` distinguishes a peer declared `peerDependenciesMeta.optional` from a
 * required one. Only required peers gate; optional ones are always reported and
 * never withhold auto-merge.
 *
 * `parents` names the packages that declared the peer, formatted `name@version`,
 * so a report can say who wants it rather than only what is missing.
 */
export const PeerIssue = Schema.Struct({
	importer: Schema.String,
	dependency: NonEmptyString,
	wanted: NonEmptyString,
	found: Schema.NullOr(Schema.String),
	optional: Schema.Boolean,
	parents: Schema.Array(Schema.String),
}).annotate({
	// Load-bearing: without an explicit identifier the JSON Schema lowering
	// invents a POSITIONAL name (`Struct_`), which a later anonymous struct
	// silently renumbers -- renaming a key consumers may $ref.
	identifier: "PeerIssue",
	title: "Peer Issue",
});

export type PeerIssue = typeof PeerIssue.Type;

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
	schemaVersion: Schema.Literal(2).annotate({
		description:
			"Document format version. Incremented only on a breaking change to this shape. " +
			"Bumped 1 -> 2 when `peerIssues` was added: this struct lowers to " +
			"`additionalProperties: false`, so a consumer validating a new document against " +
			"a pinned v1 schema rejects it. Adding a field is therefore breaking HERE in a way " +
			"it would not be for a permissive schema — the strictness is what makes it so.",
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
	peerIssues: Schema.Array(PeerIssue).annotate({
		description:
			"Unsatisfied peer dependencies found after the install, one entry per (importer, dependency). " +
			"Always an empty array when check-peers is false, which is indistinguishable from a clean graph " +
			"by design: the mode is reported separately rather than encoded as an absent field.",
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
