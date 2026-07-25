/**
 * Shared test fixtures for unit tests.
 *
 * @module utils/fixtures.test
 */

import { PullRequest, PullRequestInfo } from "@effected/github";
import { DEFAULT_REGISTRY, NpmRegistry } from "@effected/npm";
import type { Layer } from "effect";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import type { ChangesetFile, DependencyUpdateResult, LockfileChange, PullRequestResult } from "../schemas/domain.js";

describe("fixtures", () => {
	it("exports valid fixture types", () => {
		expect(configUpdate.type).toBe("config");
		expect(regularUpdate.type).toBe("devDependency");
	});
});

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
	type: "devDependency",
	package: "@savvy-web/core",
};

export const regularUpdateGlob: DependencyUpdateResult = {
	dependency: "@effect/*",
	from: null,
	to: "latest",
	type: "devDependency",
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
	type: "dependency",
	dependency: "effect",
	from: "3.0.0",
	to: "3.1.0",
	affectedPackages: ["@savvy-web/core"],
};

export const multiPackageLockfileChange: LockfileChange = {
	type: "dependency",
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
// PullRequestResult fixtures
// ══════════════════════════════════════════════════════════════════════════════

export const pullRequest: PullRequestResult = {
	number: 42,
	url: "https://github.com/savvy-web/repo/pull/42",
	created: true,
	nodeId: "PR_kwDOTest42",
};

// ══════════════════════════════════════════════════════════════════════════════
// PullRequest test double
// ══════════════════════════════════════════════════════════════════════════════

/**
 * A recording state for {@link pullRequestTestLayer}.
 *
 * Replaces the deleted `PullRequestTest` from
 * `@savvy-web/github-action-effects`. The kit ships per-service
 * `makeTest`/`layerTest` doubles whose unstubbed members die, so this stubs
 * exactly the two members `Report.createOrUpdatePR` calls — `upsert` and
 * `setAutoMerge` — and any other member reached by a test dies naming itself.
 */
export interface FakePullRequest {
	number: number;
	url: string;
	nodeId: string;
	title: string;
	state: "open" | "closed";
	head: string;
	base: string;
	draft: boolean;
	merged: boolean;
	autoMerge: "merge" | "squash" | "rebase" | undefined;
	body: string;
}

export interface PullRequestTestState {
	prs: Array<FakePullRequest>;
	nextNumber: number;
}

/** A fresh, empty recording state. */
export const emptyPullRequestState = (): PullRequestTestState => ({ prs: [], nextNumber: 1 });

const toInfo = (pr: FakePullRequest): PullRequestInfo =>
	PullRequestInfo.make({
		number: pr.number,
		nodeId: pr.nodeId,
		url: pr.url,
		title: pr.title,
		state: pr.state,
		head: pr.head,
		base: pr.base,
		draft: pr.draft,
		merged: pr.merged,
		mergedAt: Option.none(),
		body: pr.body,
	});

/**
 * A `PullRequest` layer backed by `state`.
 *
 * `upsert` matches an existing PR on its head branch — the same key the real
 * implementation uses — refreshing its title, body and base, and otherwise
 * appends a new one numbered from `state.nextNumber`.
 */
export const pullRequestTestLayer = (state: PullRequestTestState): Layer.Layer<PullRequest> =>
	PullRequest.layerTest({
		upsert: (input) =>
			Effect.sync(() => {
				const existing = state.prs.find((pr) => pr.head === input.head && pr.state === "open");
				if (existing) {
					existing.title = input.title;
					existing.body = input.body ?? "";
					existing.base = input.base;
					return { pullRequest: toInfo(existing), created: false };
				}
				const created: FakePullRequest = {
					number: state.nextNumber,
					url: `https://github.com/test/pull/${state.nextNumber}`,
					nodeId: `PR_kwDO${state.nextNumber}`,
					title: input.title,
					state: "open",
					head: input.head,
					base: input.base,
					draft: input.draft ?? false,
					merged: false,
					autoMerge: undefined,
					body: input.body ?? "",
				};
				state.nextNumber += 1;
				state.prs.push(created);
				return { pullRequest: toInfo(created), created: true };
			}),
		setAutoMerge: (pullRequest, method) =>
			Effect.sync(() => {
				const found = state.prs.find((pr) => pr.number === pullRequest.number);
				if (found) {
					found.autoMerge = method === "off" ? undefined : method;
				}
			}),
	});

// ══════════════════════════════════════════════════════════════════════════════
// NpmRegistry seeding
// ══════════════════════════════════════════════════════════════════════════════

/** The per-package shape the suites describe a fake registry with. */
export interface SeededPackage {
	readonly version: string;
	readonly integrity?: string | undefined;
	readonly versions?: ReadonlyArray<string> | undefined;
	readonly tarball?: string | undefined;
	/** Per-version overrides, for a test that needs two versions to differ. */
	readonly perVersion?: Record<string, { integrity?: string | undefined; tarball?: string | undefined }> | undefined;
}

/**
 * A working `NpmRegistry` over `packages`.
 *
 * Replaces the deleted `NpmRegistryTest`. The kit's seed is keyed by
 * `(registry, name, version)` rather than by package alone, which is what lets
 * two versions of one package carry distinct tarballs and integrities — the
 * exact limitation that made `catalog-config-deps.test.ts` hand-roll its own
 * `Layer.succeed(NpmRegistry, …)` before this.
 */
export const seededRegistry = (packages: Record<string, SeededPackage>): Layer.Layer<NpmRegistry> => {
	const byName: Record<string, Record<string, { integrity?: string | undefined; tarball?: string | undefined }>> = {};
	const distTags: Record<string, Record<string, string>> = {};

	for (const [name, info] of Object.entries(packages)) {
		const versions = info.versions ?? [info.version];
		const entries: Record<string, { integrity?: string | undefined; tarball?: string | undefined }> = {};
		for (const version of versions) {
			const override = info.perVersion?.[version];
			entries[version] = {
				...(override?.integrity !== undefined || info.integrity !== undefined
					? { integrity: override?.integrity ?? info.integrity }
					: {}),
				...(override?.tarball !== undefined || info.tarball !== undefined
					? { tarball: override?.tarball ?? info.tarball }
					: {}),
			};
		}
		byName[name] = entries;
		distTags[name] = { latest: info.version };
	}

	return NpmRegistry.layerSeeded({ registries: { [DEFAULT_REGISTRY]: byName }, distTags });
};
