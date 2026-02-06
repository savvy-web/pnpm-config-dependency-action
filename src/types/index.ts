/**
 * Core type definitions for pnpm-config-dependency-action.
 *
 * Re-exports schema-derived types for backward compatibility.
 * All types are now defined using Effect Schema in lib/schemas/index.ts.
 *
 * @module types
 */

import type { Octokit } from "@octokit/rest";

// Re-export all types from schemas
export type {
	ActionInputs,
	ActionResult,
	BranchResult,
	ChangedPackage,
	ChangesetFile,
	CheckRun,
	DependencyChange,
	DependencyUpdateResult,
	GitHubContext,
	GitStatus,
	InstallationToken,
	LockfileChange,
	PRData,
	PullRequest,
} from "../lib/schemas/index.js";

/**
 * Authenticated Octokit client with installation info.
 */
export interface AuthenticatedClient {
	readonly octokit: Octokit;
	readonly installationId: number;
}
