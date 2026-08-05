/**
 * Application layer composition.
 *
 * Wires library layers and domain service layers together.
 *
 * @module layers/app
 */

import { CheckRun, GitBranch, GitCommit, PullRequest, Repo } from "@effected/github";
import { DryRun, GitHubToken } from "@effected/github-actions";
import { NpmRegistry } from "@effected/npm";
import { BunResolver, DenoResolver, NodeResolver, GitHubClient as RuntimesGitHubClient } from "@effected/runtimes";
import {
	LockfileReader,
	PackageManagerDetector,
	WorkspaceCatalogs,
	WorkspaceDiscovery,
	WorkspaceRoot,
} from "@effected/workspaces";
import { Changesets as SilkChangesets } from "@savvy-web/silk-effects";
import { Layer } from "effect";

import { BranchManagerLive } from "../services/branch.js";
import { CatalogConfigDepsLive } from "../services/catalog-config-deps.js";
import { ChangesetsLive } from "../services/changesets.js";
import { ConfigDepsLive } from "../services/config-deps.js";
import { PackageManagerUpgradeLive } from "../services/package-manager-upgrade.js";
import { RegularDepsLive } from "../services/regular-deps.js";
import { ReleaseAgeLive } from "../services/release-age.js";
import { ReportLive } from "../services/report.js";
import { RuntimeUpgradeLive } from "../services/runtime-upgrade.js";

/* v8 ignore start - pure Layer wiring, tested indirectly via service integration tests */

/** Build the three @effected/runtimes resolver services, offline (bundled snapshot) or live (feed, falls back to snapshot). */
const makeRuntimeResolvers = (live: boolean) => {
	if (!live) {
		// The bundled offline snapshot: no IO, no requirements.
		return Layer.mergeAll(NodeResolver.layerOffline, DenoResolver.layerOffline, BunResolver.layerOffline);
	}
	// Live path: NodeResolver reads nodejs.org (unauthenticated, needs only an
	// HttpClient); Bun/Deno read GitHub releases through the authenticated seam.
	// GitHubClient.layerDefault pre-wires GitHubAuth.layerConfig + FetchHttpClient,
	// so the live graph is self-contained (E = never). Each resolver's `.layer`
	// falls back to the bundled snapshot on any fetch failure (logging a warning).
	const github = RuntimesGitHubClient.layerDefault;
	// NodeResolver.layer needs only `HttpClient.HttpClient`, which ActionServices
	// already provides — so it stays in the requirement channel rather than
	// getting a private FetchHttpClient. (GitHubClient.layerDefault is genuinely
	// self-contained, so Deno/Bun keep their provide.)
	return Layer.mergeAll(
		NodeResolver.layer,
		DenoResolver.layer.pipe(Layer.provide(github)),
		BunResolver.layer.pipe(Layer.provide(github)),
	);
};

export const makeAppLayer = (dryRun: boolean, options: { runtimeLive: boolean } = { runtimeLive: false }) => {
	// The GitHub App installation token is provisioned in the pre phase and
	// persisted to ActionState. GitHubToken.clientLayer() reads it back and
	// builds a GitHubClient — no process.env.GITHUB_TOKEN bridge. ActionState
	// comes from ActionRuntime via Action.run, so it is NOT rebuilt here.
	// Layer.orDie turns a missing/expired token into a fatal defect.
	const githubClient = GitHubToken.clientLayer().pipe(Layer.orDie);

	// The repository every resource call resolves against. Repo is required per
	// call rather than captured, so this is a layer like any other; reading it
	// from GITHUB_REPOSITORY goes through the ambient ConfigProvider.
	const repo = Repo.layerFromConfig().pipe(Layer.orDie);

	// GraphQL is a member of GitHubClient in the kit — there is no separate
	// GitHubGraphQL service to wire.
	//
	// NpmRegistry needs an HttpClient and the workspace layers need
	// FileSystem/Path/ChildProcessSpawner. NEITHER is built here: both are members
	// of `ActionServices`, which `Action.run`'s `ActionRuntime.layer` already
	// provides, so they stay in this layer's REQUIREMENT channel and are satisfied
	// at the boundary. Building them here instead meant the action shipped a second
	// copy of the Node platform and the fetch client in its bundle, and forced a
	// direct `@effect/platform-node` dependency the program has no business naming.
	const npmRegistry = NpmRegistry.layer;
	const gitBranch = GitBranch.layer.pipe(Layer.provide(githubClient));
	const gitCommit = GitCommit.layer.pipe(Layer.provide(githubClient));
	const prLayer = PullRequest.layer.pipe(Layer.provide(githubClient));

	const workspaceRoot = WorkspaceRoot.layer;
	const workspaceDiscovery = WorkspaceDiscovery.layer().pipe(Layer.provide(workspaceRoot));
	const packageManagerDetector = PackageManagerDetector.layer;
	// The lockfile is the record of which config-dependency version is actually
	// installed — the merge base for CatalogConfigDeps' three-way catalog merge.
	// @effected/workspaces' LockfileReader also depends on WorkspaceDiscovery.
	const lockfileReader = LockfileReader.layer().pipe(
		Layer.provide(Layer.mergeAll(workspaceRoot, packageManagerDetector, workspaceDiscovery)),
	);

	// Effective pnpm minimumReleaseAge gate (inline pnpm-workspace.yaml keys +
	// config-dependency hook replay), applied by ConfigDeps/RegularDeps before
	// version resolution. Inert when the workspace declares no gate.
	//
	// `layerWithConfigDependenciesSubprocess`, NOT `layerWithConfigDependencies`:
	// the in-process variant loads each config dependency's pnpmfile with a
	// computed dynamic `import()`, which rspack compiles into a context module and
	// breaks in the bundled dist (see the action.config.ts note on
	// `nativeDynamicImports`). The subprocess variant passes a static script via
	// argv, so nothing computed enters the bundle graph — which is the whole
	// reason this adoption was blocked until effected#288 shipped.
	const workspaceCatalogs = WorkspaceCatalogs.layerWithConfigDependenciesSubprocess().pipe(
		Layer.provide(Layer.mergeAll(workspaceRoot, lockfileReader)),
	);
	const releaseAge = ReleaseAgeLive().pipe(Layer.provide(Layer.merge(npmRegistry, workspaceCatalogs)));
	// DepsRegen (from @savvy-web/silk-effects) is the source of truth for
	// dependency changesets. DepsRegenDefault is the batteries-included layer: it
	// bundles the point-in-time workspace reader, ConfigInspector, WorkspaceDiscovery,
	// silk's adaptive PublishabilityDetector, and ChangesetConfig internally, so its
	// gating is silk "versionable-minus-ignored" and the only residual requirements
	// are the platform services (FileSystem/Path/CommandExecutor from NodeContext).
	const depsRegen = SilkChangesets.DepsRegenDefault;

	const libraryLayers = Layer.mergeAll(
		githubClient,
		repo,
		gitBranch,
		gitCommit,
		CheckRun.layer.pipe(Layer.provide(githubClient)),
		prLayer,
		npmRegistry,
		DryRun.layerFrom(dryRun),
	);

	const domainLayers = Layer.mergeAll(
		workspaceRoot,
		workspaceDiscovery,
		packageManagerDetector,
		ChangesetsLive.pipe(Layer.provide(depsRegen)),
		BranchManagerLive.pipe(Layer.provide(Layer.merge(gitBranch, gitCommit))),
		PackageManagerUpgradeLive.pipe(Layer.provide(npmRegistry)),
		ConfigDepsLive.pipe(Layer.provide(Layer.merge(npmRegistry, releaseAge))),
		CatalogConfigDepsLive.pipe(Layer.provide(Layer.merge(npmRegistry, lockfileReader))),
		RegularDepsLive.pipe(Layer.provide(Layer.mergeAll(npmRegistry, workspaceDiscovery, releaseAge))),
		ReportLive.pipe(Layer.provide(prLayer)),
		RuntimeUpgradeLive.pipe(Layer.provide(makeRuntimeResolvers(options.runtimeLive))),
	);

	return Layer.provideMerge(domainLayers, libraryLayers);
};
/* v8 ignore stop */
