# Dependencies

[Back to index](./_index.md)

## Runtime Dependencies (bundled into action)

```json
{
 "dependencies": {
  "@actions/cache": "^4.1.0",
  "@actions/core": "^3.0.0",
  "@actions/exec": "^3.0.0",
  "@actions/github": "^9.0.0",
  "@actions/io": "^3.0.2",
  "@effect/platform": "^0.94.4",
  "@effect/platform-node": "^0.104.1",
  "@octokit/auth-app": "^8.2.0",
  "@octokit/request": "^10.0.7",
  "@octokit/rest": "^22.0.1",
  "@pnpm/catalogs.config": "^1000.0.5",
  "@pnpm/catalogs.protocol-parser": "^1001.0.0",
  "@pnpm/lockfile.fs": "^1001.1.29",
  "@pnpm/lockfile.types": "^1002.0.9",
  "@pnpm/workspace.read-manifest": "^1000.2.10",
  "@savvy-web/github-action-effects": "^0.4.0",
  "effect": "^3.19.16",
  "semver": "^7.7.4",
  "workspace-tools": "^0.41.0",
  "yaml": "^2.8.2"
 }
}
```

## Key Packages

- `@savvy-web/github-action-effects` (v0.4.0) - Effect-based services for GitHub Actions.
  Provides two tiers of services:
  - **Action plumbing:** `ActionOutputs`, `Action.run()`, `Action.parseInputs()`,
    `GitHubApp.withToken()`, `CheckRun.withCheckRun()`, `AutoMerge.enable()`
  - **Domain services:** `CommandRunner`, `GitBranch`, `GitCommit`, `GitHubClient`,
    `GitHubGraphQL`, `DryRun`
  - **Live layers:** `GitHubAppLive`, `GitHubClientLive`, `GitBranchLive`, `GitCommitLive`,
    `CheckRunLive`, `CommandRunnerLive`, `DryRunLive`, `GitHubGraphQLLive`
- `@actions/core` - Transitive dependency (used internally by `@savvy-web/github-action-effects`).
  **No longer imported directly** by any source file.
- `@actions/github` - GitHub context (`context.sha`). Used only in `src/main.ts` for
  the head SHA when creating check runs.
- `@effect/platform` / `@effect/platform-node` - Effect platform layer for `Command`
  (shell execution). `NodeContext.layer` is provided automatically by `Action.run()`.
- `@octokit/auth-app` - GitHub App JWT and installation token generation (used internally
  by `GitHubApp.withToken()`)
- `effect` - Typed error handling, retry logic, resource management
- `yaml` - Parse and stringify `pnpm-workspace.yaml` with consistent formatting
- `semver` - Semantic version parsing, comparison, and range resolution for pnpm self-upgrade

## pnpm Official Packages (for lockfile/workspace analysis)

- `@pnpm/lockfile.fs` - Read/write `pnpm-lock.yaml`
  - `readWantedLockfile(pkgPath, opts)` - Read lockfile, get `LockfileObject`
  - Returns catalogs, packages, importers for diff comparison
- `@pnpm/lockfile.types` - TypeScript types for lockfile structures
  - `LockfileObject`, `CatalogSnapshots`, `ProjectSnapshot`
- `@pnpm/catalogs.config` - Extract catalogs from workspace manifest
  - `getCatalogsFromWorkspaceManifest(manifest)`
- `@pnpm/catalogs.protocol-parser` - Parse `catalog:` protocol references
  - `parseCatalogProtocol(version)` - Returns catalog name or null
- `@pnpm/workspace.read-manifest` - Read `pnpm-workspace.yaml`
  - `readWorkspaceManifest(workspaceRoot)`

## workspace-tools (Microsoft)

- `getWorkspaceManagerAndRoot(cwd)` - Detect pnpm/yarn/npm and workspace root
- `getWorkspaceInfos(cwd)` / `getWorkspaceInfosAsync(cwd)` - Get all package info
- `getWorkspacePackagePaths(cwd)` - Get paths to all workspace packages
- `getCatalogs(root, manager)` - Get catalogs for pnpm/yarn
