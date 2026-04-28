# Dependencies

[Back to index](./_index.md)

## Runtime Dependencies (bundled into action)

```json
{
 "dependencies": {
  "@effect/platform": "catalog:silk",
  "@effect/platform-node": "catalog:silk",
  "@pnpm/lockfile.fs": "^1100.0.3",
  "@pnpm/lockfile.types": "^1100.0.2",
  "@savvy-web/github-action-effects": "^0.11.14",
  "effect": "catalog:silk",
  "semver-effect": "^0.2.1",
  "workspaces-effect": "^0.5.1",
  "yaml": "^2.8.3"
 }
}
```

## Key Packages

- `@savvy-web/github-action-effects` (v0.11.14) - Effect-based services for GitHub Actions.
  Replaces `@actions/*` with a native ESM implementation. Provides:
  - **Action plumbing:** `ActionOutputs`, `ActionEnvironment`, `ActionLogger`,
    `ActionState`, `Action.run()`, `GitHubApp.withToken()`, `CheckRun.withCheckRun()`,
    `AutoMerge.enable()`
  - **Config API:** `Config.*` from Effect for typed input parsing (replaces `Action.parseInputs()`)
  - **Domain services:** `CommandRunner`, `GitBranch`, `GitCommit`, `GitHubClient`,
    `GitHubGraphQL`, `NpmRegistry`, `PullRequest`, `DryRun`, `GithubMarkdown`
  - **Live layers:** `GitHubAppLive` (requires `OctokitAuthAppLive`), `GitHubClientLive`,
    `GitBranchLive`, `GitCommitLive`, `CheckRunLive`, `CommandRunnerLive`, `DryRunLive`,
    `GitHubGraphQLLive`, `OctokitAuthAppLive`
- `@effect/platform` / `@effect/platform-node` - Effect platform layer for `Command`
  (shell execution) and FileSystem/Path. `NodeContext.layer` is provided by the
  library's `Action.run()` pipeline at the platform level. `makeAppLayer` also
  pulls `NodeContext.layer` in directly to satisfy `WorkspaceDiscoveryLive` and
  `WorkspaceRootLive` from `workspaces-effect`, which require FileSystem/Path
  to read workspace manifests.
- `effect` - Typed error handling, retry logic, resource management
- `semver-effect` (^0.2.1) - Effect-native semver parsing/comparison; used by
  `services/peer-sync.ts` (`SemVer.parse`) for bump-classification under the
  `peer-minor` strategy.
- `workspaces-effect` (^0.5.1) - Effect-native workspace + publishability layer.
  Replaces the previous `workspace-tools` (Microsoft) dependency. Consumed
  directly by domain services (`RegularDeps`, `PeerSync`, `Lockfile`,
  `Changesets`) via the upstream `WorkspaceDiscovery` Tag — the local
  `Workspaces` wrapper service has been removed (issue #38). Provides:
  - `WorkspaceDiscovery` Tag + `WorkspaceDiscoveryLive` Layer with
    `listPackages(cwd?)` and `importerMap(cwd?)` methods accepting an
    optional cwd parameter (added in v0.5.x).
  - `WorkspaceRoot` Tag + `WorkspaceRootLive` Layer for resolving the
    workspace root from a cwd.
  - `getWorkspacePackagesSync(workspaceRoot)` - synchronously enumerate workspace
    packages (including the root workspace package, unlike workspace-tools'
    package-pattern-only discovery).
  - `WorkspacePackage`, `PublishTarget`, `PublishConfig` value classes.
  - `PublishabilityDetector` Tag + `PublishabilityDetectorLive` (vanilla rules).
    The action overrides this Tag via `services/publishability.ts` with either
    silk rules or an adaptive dispatcher driven by `ChangesetConfig.mode`.
- `yaml` - Parse and stringify `pnpm-workspace.yaml` with consistent formatting

## pnpm Official Packages (for lockfile/workspace analysis)

- `@pnpm/lockfile.fs` - Read/write `pnpm-lock.yaml`
  - `readWantedLockfile(pkgPath, opts)` - Read lockfile, get `LockfileObject`
  - Returns catalogs, packages, importers for diff comparison
- `@pnpm/lockfile.types` - TypeScript types for lockfile structures
  - `LockfileObject`, `CatalogSnapshots`, `ResolvedCatalogEntry`, `ProjectSnapshot`
