# Type Definitions

[Back to index](./_index.md)

## Core Interfaces

```typescript
import type { Effect } from "effect";
import type { Octokit } from "@octokit/rest";

/**
 * Parsed action inputs from action.yml (9 fields, defined via Effect Schema).
 */
export interface ActionInputs {
 readonly appId: string;           // NonEmptyString
 readonly appPrivateKey: string;   // NonEmptyString
 readonly branch: string;          // Pattern validated: /^[a-zA-Z0-9/_-]+$/
 readonly configDependencies: ReadonlyArray<string>;
 readonly dependencies: ReadonlyArray<string>;
 readonly run: ReadonlyArray<string>;
 readonly updatePnpm: boolean;     // default: true
 readonly autoMerge: "" | "merge" | "squash" | "rebase"; // default: ""
 readonly changesets: boolean;     // default: true, controls whether changesets are created for dependency updates
}

/**
 * GitHub context for the action
 */
export interface GitHubContext {
 readonly owner: string;
 readonly repo: string;
 readonly ref: string;
 readonly sha: string;
 readonly defaultBranch: string; // usually "main"
}

/**
 * GitHub App installation token
 */
export interface InstallationToken {
 readonly token: string;
 readonly expiresAt: Date;
 readonly permissions: Record<string, string>;
 readonly repositories?: ReadonlyArray<{ id: number; name: string }>;
}

/**
 * Authenticated Octokit client
 */
export interface AuthenticatedClient {
 readonly octokit: Octokit;
 readonly installationId: number;
}

/**
 * Branch management result
 */
export interface BranchResult {
 readonly branch: string;
 readonly created: boolean; // true if newly created, false if rebased
 readonly upToDate: boolean; // true if no rebase was needed
 readonly baseRef: string; // ref branch was created from or rebased onto
}

/**
 * Dependency update result
 */
export interface DependencyUpdateResult {
 readonly dependency: string;
 readonly from: string | null; // null if newly added
 readonly to: string;
 readonly type: "config" | "regular";
 readonly package: string | null; // null for config dependencies
}

/**
 * Changed package information
 */
export interface ChangedPackage {
 readonly name: string;
 readonly path: string;
 readonly version: string;
 readonly dependencies: ReadonlyArray<DependencyUpdateResult>;
}

/**
 * Changeset file to create
 */
export interface ChangesetFile {
 readonly packages: ReadonlyArray<string>; // package names
 readonly type: "patch"; // always patch for dependency updates
 readonly summary: string;
}

/**
 * Check run information
 */
export interface CheckRun {
 readonly id: number;
 readonly name: string;
 readonly status: "queued" | "in_progress" | "completed";
 readonly conclusion?: "success" | "failure" | "neutral" | "cancelled" | "skipped";
}

/**
 * Pull request information
 */
export interface PullRequest {
 readonly number: number;
 readonly url: string;
 readonly created: boolean; // true if newly created, false if updated
 readonly nodeId: string;
}

/**
 * Complete action result
 */
export interface ActionResult {
 readonly updates: ReadonlyArray<DependencyUpdateResult>;
 readonly changedPackages: ReadonlyArray<ChangedPackage>;
 readonly changesets: ReadonlyArray<ChangesetFile>;
 readonly branch: BranchResult;
 readonly pr: PullRequest;
 readonly checkRun: CheckRun;
}

/**
 * Result of a pnpm upgrade operation (from src/lib/pnpm/upgrade.ts).
 */
export interface PnpmUpgradeResult {
 readonly from: string;
 readonly to: string;
 readonly packageManagerUpdated: boolean;
 readonly devEnginesUpdated: boolean;
}

/**
 * Parsed pnpm version info (from src/lib/pnpm/upgrade.ts).
 */
export interface ParsedPnpmVersion {
 readonly version: string;
 readonly hasCaret: boolean;
 readonly hasSha: boolean;
}
```

## Effect Error Types

Using Effect's `Data.TaggedError` for typed error handling:

```typescript
import { Data } from "effect";

/**
 * Input validation errors
 */
export class InvalidInputError extends Data.TaggedError("InvalidInputError")<{
 readonly field: string;
 readonly value: unknown;
 readonly reason: string;
}> {}

/**
 * GitHub authentication errors
 */
export class AuthenticationError extends Data.TaggedError("AuthenticationError")<{
 readonly reason: string;
 readonly appId?: string;
}> {}

/**
 * GitHub API errors
 */
export class GitHubApiError extends Data.TaggedError("GitHubApiError")<{
 readonly operation: string;
 readonly statusCode: number;
 readonly message: string;
}> {}

/**
 * Git operation errors
 */
export class GitError extends Data.TaggedError("GitError")<{
 readonly operation: "status" | "diff" | "commit" | "push" | "rebase" | "checkout";
 readonly exitCode: number;
 readonly stderr: string;
}> {}

/**
 * pnpm command errors
 */
export class PnpmError extends Data.TaggedError("PnpmError")<{
 readonly command: string;
 readonly dependency?: string;
 readonly exitCode: number;
 readonly stderr: string;
}> {}

/**
 * Changeset creation errors
 */
export class ChangesetError extends Data.TaggedError("ChangesetError")<{
 readonly reason: string;
 readonly packages?: ReadonlyArray<string>;
}> {}

/**
 * File system errors
 */
export class FileSystemError extends Data.TaggedError("FileSystemError")<{
 readonly operation: "read" | "write" | "delete" | "exists";
 readonly path: string;
 readonly reason: string;
}> {}

/**
 * Aggregate error for collecting multiple failures
 */
export class DependencyUpdateFailures extends Data.TaggedError("DependencyUpdateFailures")<{
 readonly failures: ReadonlyArray<{
  readonly dependency: string;
  readonly error: PnpmError;
 }>;
 readonly successful: ReadonlyArray<DependencyUpdateResult>;
}> {}
```
