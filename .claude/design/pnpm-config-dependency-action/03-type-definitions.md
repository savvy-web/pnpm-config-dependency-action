# Type Definitions

[Back to index](./_index.md)

## Overview

Types are defined using Effect Schema in `src/schemas/domain.ts`. Error types use
`Schema.TaggedError` in `src/errors/errors.ts`. Module-level types (e.g.,
`PnpmUpgradeResult`) are defined in their respective service files.

No barrel re-exports exist. Import directly from the defining module.

## Domain Schemas (src/schemas/domain.ts)

```typescript
import { Schema } from "effect";

/** Branch management result. */
export const BranchResult = Schema.Struct({
 branch: NonEmptyString,
 created: Schema.Boolean,
 upToDate: Schema.Boolean,
 baseRef: Schema.String,
});

/** Dependency update result. */
export const DependencyUpdateResult = Schema.Struct({
 dependency: NonEmptyString,
 from: Schema.NullOr(Schema.String),
 to: NonEmptyString,
 type: Schema.Literal("config", "dependency", "devDependency", "peerDependency", "optionalDependency"),
 package: Schema.NullOr(Schema.String),
});

/** Single dependency change info. */
export const DependencyChange = Schema.Struct({
 dependency: NonEmptyString,
 from: Schema.NullOr(Schema.String),
 to: NonEmptyString,
});

/** Changed package information. */
export const ChangedPackage = Schema.Struct({
 name: NonEmptyString,
 path: Schema.String,
 version: Schema.String,
 changes: Schema.Array(DependencyChange),
});

/** Changeset file to create. */
export const ChangesetFile = Schema.Struct({
 id: NonEmptyString,
 packages: Schema.Array(Schema.String),
 type: Schema.Literal("patch", "minor", "major"),
 summary: NonEmptyString,
});

/** Pull request result. */
export const PullRequestResult = Schema.Struct({
 number: Schema.Number.pipe(Schema.positive()),
 url: Schema.String.pipe(Schema.startsWith("https://")),
 created: Schema.Boolean,
 nodeId: Schema.String,
});

/** Lockfile change detected during comparison. */
export const LockfileChange = Schema.Struct({
 type: Schema.Literal("config", "dependency", "devDependency", "peerDependency", "optionalDependency"),
 dependency: NonEmptyString,
 from: Schema.NullOr(Schema.String),
 to: NonEmptyString,
 affectedPackages: Schema.Array(Schema.String),
});
```

All schemas derive TypeScript types via `typeof Schema.Type`.

## Module-Level Types (src/services/pnpm-upgrade.ts)

```typescript
/** Result of a pnpm upgrade operation. */
export interface PnpmUpgradeResult {
 readonly from: string;
 readonly to: string;
 readonly packageManagerUpdated: boolean;
 readonly devEnginesUpdated: boolean;
}
```

## Pure Helper Types (src/utils/pnpm.ts)

```typescript
/** Parsed pnpm version info. */
export interface ParsedPnpmVersion {
 readonly version: string;
 readonly hasCaret: boolean;
 readonly hasSha: boolean;
}
```

## Effect Error Types (src/errors/errors.ts)

Uses Effect's `Schema.TaggedError` for typed error handling with rich metadata:

```typescript
import { Schema } from "effect";

/** Input validation error. */
export class InvalidInputError extends Schema.TaggedError<InvalidInputError>()(
 "InvalidInputError",
 { field: NonEmptyString, value: Schema.Unknown, reason: NonEmptyString },
) {}

/** GitHub API error. */
export class GitHubApiError extends Schema.TaggedError<GitHubApiError>()(
 "GitHubApiError",
 {
  operation: NonEmptyString,
  statusCode: Schema.optional(Schema.Number.pipe(Schema.between(100, 599))),
  message: NonEmptyString,
 },
) {
 get isRetryable(): boolean {
  return this.isRateLimited || this.isServerError;
 }
}

/** Git command execution error. */
export class GitError extends Schema.TaggedError<GitError>()(
 "GitError",
 {
  operation: Schema.Literal("status", "diff", "commit", "push", "rebase", "checkout", "fetch", "branch"),
  exitCode: Schema.Number.pipe(Schema.int()),
  stderr: Schema.String,
 },
) {}

/** pnpm command execution error. */
export class PnpmError extends Schema.TaggedError<PnpmError>()(
 "PnpmError",
 {
  command: NonEmptyString,
  dependency: Schema.optional(Schema.String),
  exitCode: Schema.Number.pipe(Schema.int()),
  stderr: Schema.String,
 },
) {}

/** Changeset creation error. */
export class ChangesetError extends Schema.TaggedError<ChangesetError>()(
 "ChangesetError",
 { reason: NonEmptyString, packages: Schema.optional(Schema.Array(Schema.String)) },
) {}

/** File system operation error. */
export class FileSystemError extends Schema.TaggedError<FileSystemError>()(
 "FileSystemError",
 {
  operation: Schema.Literal("read", "write", "delete", "exists"),
  path: NonEmptyString,
  reason: NonEmptyString,
 },
) {}

/** Lockfile parsing/comparison error. */
export class LockfileError extends Schema.TaggedError<LockfileError>()(
 "LockfileError",
 {
  operation: Schema.Literal("read", "parse", "compare"),
  reason: NonEmptyString,
 },
) {}

/** Aggregate error for collecting multiple dependency update failures. */
export class DependencyUpdateFailures extends Schema.TaggedError<DependencyUpdateFailures>()(
 "DependencyUpdateFailures",
 {
  failures: Schema.Array(Schema.Struct({
   dependency: NonEmptyString,
   error: Schema.Struct({ command: Schema.String, dependency: Schema.optional(Schema.String), exitCode: Schema.Number, stderr: Schema.String }),
  })),
  successful: Schema.Array(DependencyUpdateResult),
 },
) {}

/** Union type of all expected errors. */
export type ActionError =
 | InvalidInputError
 | GitHubApiError
 | GitError
 | PnpmError
 | ChangesetError
 | FileSystemError
 | LockfileError
 | DependencyUpdateFailures;
```
