/**
 * Application layer composition.
 *
 * Wires library layers and domain service layers together.
 *
 * @module layers/app
 */

import {
	CheckRunLive,
	CommandRunnerLive,
	DryRunLive,
	GitBranchLive,
	GitCommitLive,
	GitHubClientLive,
	GitHubGraphQLLive,
	NpmRegistryLive,
	PullRequestLive,
} from "@savvy-web/github-action-effects";
import { Layer } from "effect";

import { BranchManagerLive } from "../services/branch.js";
import { ChangesetConfigLive } from "../services/changeset-config.js";
import { ChangesetsLive } from "../services/changesets.js";
import { ConfigDepsLive } from "../services/config-deps.js";
import { PnpmUpgradeLive } from "../services/pnpm-upgrade.js";
import { PublishabilityDetectorAdaptiveLive } from "../services/publishability.js";
import { RegularDepsLive } from "../services/regular-deps.js";
import { ReportLive } from "../services/report.js";
import { WorkspacesLive } from "../services/workspaces.js";

/* v8 ignore start - pure Layer wiring, tested indirectly via service integration tests */
export const makeAppLayer = (dryRun: boolean) => {
	const ghGraphql = GitHubGraphQLLive.pipe(Layer.provide(GitHubClientLive));
	const npmRegistry = NpmRegistryLive.pipe(Layer.provide(CommandRunnerLive));
	const gitBranch = GitBranchLive.pipe(Layer.provide(GitHubClientLive));
	const gitCommit = GitCommitLive.pipe(Layer.provide(GitHubClientLive));
	const prLayer = PullRequestLive.pipe(Layer.provide(Layer.merge(GitHubClientLive, ghGraphql)));

	const workspaces = WorkspacesLive;
	const changesetConfig = ChangesetConfigLive;
	// PublishabilityDetectorAdaptiveLive overrides PublishabilityDetector and
	// reads ChangesetConfig.mode per-call to dispatch to silk/vanilla/noop.
	const publishabilityDetector = PublishabilityDetectorAdaptiveLive.pipe(Layer.provide(changesetConfig));

	const libraryLayers = Layer.mergeAll(
		GitHubClientLive,
		gitBranch,
		gitCommit,
		CheckRunLive.pipe(Layer.provide(GitHubClientLive)),
		prLayer,
		npmRegistry,
		CommandRunnerLive,
		DryRunLive(dryRun),
	);

	const domainLayers = Layer.mergeAll(
		workspaces,
		changesetConfig,
		publishabilityDetector,
		ChangesetsLive.pipe(Layer.provide(Layer.mergeAll(workspaces, publishabilityDetector, changesetConfig))),
		BranchManagerLive.pipe(Layer.provide(Layer.mergeAll(gitBranch, gitCommit, CommandRunnerLive))),
		PnpmUpgradeLive.pipe(Layer.provide(CommandRunnerLive)),
		ConfigDepsLive.pipe(Layer.provide(npmRegistry)),
		RegularDepsLive.pipe(Layer.provide(Layer.merge(npmRegistry, workspaces))),
		ReportLive.pipe(Layer.provide(prLayer)),
	);

	return Layer.provideMerge(domainLayers, libraryLayers);
};
/* v8 ignore stop */
