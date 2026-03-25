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
import { ConfigDepsLive } from "../services/config-deps.js";
import { PnpmUpgradeLive } from "../services/pnpm-upgrade.js";
import { RegularDepsLive } from "../services/regular-deps.js";
import { ReportLive } from "../services/report.js";

export const makeAppLayer = (dryRun: boolean) => {
	const ghGraphql = GitHubGraphQLLive.pipe(Layer.provide(GitHubClientLive));
	const npmRegistry = NpmRegistryLive.pipe(Layer.provide(CommandRunnerLive));
	const gitBranch = GitBranchLive.pipe(Layer.provide(GitHubClientLive));
	const gitCommit = GitCommitLive.pipe(Layer.provide(GitHubClientLive));
	const prLayer = PullRequestLive.pipe(Layer.provide(Layer.merge(GitHubClientLive, ghGraphql)));

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
		BranchManagerLive.pipe(Layer.provide(Layer.mergeAll(gitBranch, gitCommit, CommandRunnerLive))),
		PnpmUpgradeLive.pipe(Layer.provide(CommandRunnerLive)),
		ConfigDepsLive.pipe(Layer.provide(npmRegistry)),
		RegularDepsLive.pipe(Layer.provide(npmRegistry)),
		ReportLive.pipe(Layer.provide(prLayer)),
	);

	return Layer.provideMerge(domainLayers, libraryLayers);
};
