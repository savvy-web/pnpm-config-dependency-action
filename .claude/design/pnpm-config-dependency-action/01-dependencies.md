# Dependencies

[Back to index](./_index.md)

## Runtime Dependencies (bundled into action)

```json
{
 "dependencies": {
  "@effect/platform": "catalog:silk",
  "@effect/platform-node": "catalog:silk",
  "@pnpm/lockfile.fs": "^1001.1.29",
  "@pnpm/lockfile.types": "^1002.1.0",
  "@savvy-web/github-action-effects": "^0.11.12",
  "effect": "catalog:silk",
  "workspace-tools": "^0.41.0",
  "yaml": "^2.8.2"
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
    `GitHubGraphQL`, `NpmRegistry`, `PullRequest`, `DryRun`
  - **Live layers:** `GitHubAppLive`, `GitHubClientLive`, `GitBranchLive`, `GitCommitLive`,
    `CheckRunLive`, `CommandRunnerLive`, `DryRunLive`, `GitHubGraphQLLive`
- `@effect/platform` / `@effect/platform-node` - Effect platform layer for `Command`
  (shell execution). `NodeContext.layer` is provided automatically by `Action.run()`.
- `effect` - Typed error handling, retry logic, resource management
- `yaml` - Parse and stringify `pnpm-workspace.yaml` with consistent formatting

## pnpm Official Packages (for lockfile/workspace analysis)

- `@pnpm/lockfile.fs` - Read/write `pnpm-lock.yaml`
  - `readWantedLockfile(pkgPath, opts)` - Read lockfile, get `LockfileObject`
  - Returns catalogs, packages, importers for diff comparison
- `@pnpm/lockfile.types` - TypeScript types for lockfile structures
  - `LockfileObject`, `CatalogSnapshots`, `ProjectSnapshot`

## workspace-tools (Microsoft)

- `getWorkspaceManagerAndRoot(cwd)` - Detect pnpm/yarn/npm and workspace root
- `getWorkspaceInfos(cwd)` / `getWorkspaceInfosAsync(cwd)` - Get all package info
- `getWorkspacePackagePaths(cwd)` - Get paths to all workspace packages
- `getCatalogs(root, manager)` - Get catalogs for pnpm/yarn
