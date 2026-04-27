# Dependencies

[Back to index](./_index.md)

## Runtime Dependencies (bundled into action)

```json
{
 "dependencies": {
  "@effect/platform": "catalog:silk",
  "@effect/platform-node": "catalog:silk",
  "@pnpm/lockfile.fs": "^1001.1.32",
  "@pnpm/lockfile.types": "^1002.1.0",
  "@savvy-web/github-action-effects": "^0.11.12",
  "effect": "catalog:silk",
  "semver-effect": "^0.2.1",
  "workspaces-effect": "^0.4.1",
  "yaml": "^2.8.3"
 }
}
```

## Key Packages

- `@savvy-web/github-action-effects` (v0.11.12) - Effect-based services for GitHub Actions.
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
  (shell execution). `NodeContext.layer` is provided by the library's `Action.run()`
  pipeline at the platform level — domain layers do not pull it in directly.
- `effect` - Typed error handling, retry logic, resource management
- `semver-effect` (^0.2.1) - Effect-native semver parsing/comparison; used by
  `services/peer-sync.ts` (`SemVer.parse`) for bump-classification under the
  `peer-minor` strategy.
- `workspaces-effect` (^0.4.1) - Effect-native workspace + publishability layer.
  Replaces the previous `workspace-tools` (Microsoft) dependency. Provides:
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
