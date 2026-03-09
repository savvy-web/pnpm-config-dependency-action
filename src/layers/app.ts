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

export const makeAppLayer = (token: string, dryRun: boolean) => {
	const ghClient = GitHubClientLive(token);
	const ghGraphql = GitHubGraphQLLive.pipe(Layer.provide(ghClient));
	const npmRegistry = NpmRegistryLive.pipe(Layer.provide(CommandRunnerLive));
	const gitBranch = GitBranchLive.pipe(Layer.provide(ghClient));
	const gitCommit = GitCommitLive.pipe(Layer.provide(ghClient));
	const prLayer = PullRequestLive.pipe(Layer.provide(Layer.merge(ghClient, ghGraphql)));

	const libraryLayers = Layer.mergeAll(
		ghClient,
		gitBranch,
		gitCommit,
		CheckRunLive.pipe(Layer.provide(ghClient)),
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
