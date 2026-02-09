/**
 * Shared test fixtures for unit tests.
 *
 * @module __test__/fixtures
 */

import type { ChangesetFile, DependencyUpdateResult, LockfileChange, PullRequest } from "../../types/index.js";

// ══════════════════════════════════════════════════════════════════════════════
// DependencyUpdateResult fixtures
// ══════════════════════════════════════════════════════════════════════════════

export const pnpmUpgradeUpdate: DependencyUpdateResult = {
	dependency: "pnpm",
	from: "10.28.2",
	to: "10.29.0",
	type: "config",
	package: null,
};

export const configUpdate: DependencyUpdateResult = {
	dependency: "typescript",
	from: "5.3.3",
	to: "5.4.0",
	type: "config",
	package: null,
};

export const configUpdateNew: DependencyUpdateResult = {
	dependency: "@biomejs/biome",
	from: null,
	to: "1.6.1",
	type: "config",
	package: null,
};

export const configUpdateNoOp: DependencyUpdateResult = {
	dependency: "@savvy-web/pnpm-plugin-silk",
	from: "0.4.1",
	to: "0.4.1",
	type: "config",
	package: null,
};

export const regularUpdate: DependencyUpdateResult = {
	dependency: "effect",
	from: "3.0.0",
	to: "3.1.0",
	type: "regular",
	package: "@savvy-web/core",
};

export const regularUpdateGlob: DependencyUpdateResult = {
	dependency: "@effect/*",
	from: null,
	to: "latest",
	type: "regular",
	package: null,
};

export const configUpdates: ReadonlyArray<DependencyUpdateResult> = [configUpdate, configUpdateNew];

export const regularUpdates: ReadonlyArray<DependencyUpdateResult> = [regularUpdate, regularUpdateGlob];

export const mixedUpdates: ReadonlyArray<DependencyUpdateResult> = [
	configUpdate,
	configUpdateNew,
	regularUpdate,
	regularUpdateGlob,
];

// ══════════════════════════════════════════════════════════════════════════════
// LockfileChange fixtures
// ══════════════════════════════════════════════════════════════════════════════

export const configLockfileChange: LockfileChange = {
	type: "config",
	dependency: "typescript",
	from: "5.3.3",
	to: "5.4.0",
	affectedPackages: [],
};

export const regularLockfileChange: LockfileChange = {
	type: "regular",
	dependency: "effect",
	from: "3.0.0",
	to: "3.1.0",
	affectedPackages: ["@savvy-web/core"],
};

export const multiPackageLockfileChange: LockfileChange = {
	type: "regular",
	dependency: "@effect/schema",
	from: "0.60.0",
	to: "0.61.0",
	affectedPackages: ["@savvy-web/core", "@savvy-web/utils"],
};

// ══════════════════════════════════════════════════════════════════════════════
// ChangesetFile fixtures
// ══════════════════════════════════════════════════════════════════════════════

export const packageChangeset: ChangesetFile = {
	id: "brave-apple-abc123",
	packages: ["@savvy-web/core"],
	type: "patch",
	summary: "Update dependencies:\n\n**Dependencies:**\n- effect: 3.0.0 → 3.1.0",
};

export const rootChangeset: ChangesetFile = {
	id: "calm-beach-def456",
	packages: [],
	type: "patch",
	summary: "Update dependencies:\n\n**Config dependencies:**\n- typescript: 5.3.3 → 5.4.0",
};

// ══════════════════════════════════════════════════════════════════════════════
// PullRequest fixtures
// ══════════════════════════════════════════════════════════════════════════════

export const pullRequest: PullRequest = {
	number: 42,
	url: "https://github.com/savvy-web/repo/pull/42",
	created: true,
	nodeId: "PR_kwDOTest42",
};
