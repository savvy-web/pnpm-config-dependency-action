# v0.5.0 Library Migration Design

## Goal

Replace custom implementations with services from
`@savvy-web/github-action-effects` v0.5.0, reducing boilerplate and fixing the
file deletion limitation.

## Architecture

Migrate module-by-module in dependency order. Each module gets its own commit
with updated tests. Custom pnpm-specific code (lockfile comparison, changeset
creation, workspace YAML formatting) stays as-is.

## Dependency Changes

| Action | Package | Reason |
| --- | --- | --- |
| Bump | `@savvy-web/github-action-effects` | `^0.4.0` to `^0.5.0` |
| Remove | `semver` | Bundled in library; use `SemverResolver` namespace |
| Remove | `@octokit/request` | No longer imported in source |
| Remove | `@octokit/rest` | No longer imported in source |
| Keep | `yaml` | Peer dep (optional), used by custom `format.ts` |
| Keep | `workspace-tools` | Deep package info needed by `regular.ts`, `compare.ts` |
| Keep | `@pnpm/*` packages | Lockfile comparison is pnpm-specific |

No new peer dependencies needed. All required peers already satisfied.

## Migration Order

### Task 1: upgrade.ts -- Replace semver with SemverResolver

Replace direct `semver` imports (`valid`, `prerelease`, `maxSatisfying`, `gt`)
with `SemverResolver` namespace functions (`parse`, `latestInRange`, `compare`).

`SemverResolver` methods return Effects, so `resolveLatestInRange` changes from
a pure function to an Effect. Pre-release filtering stays custom (filter array
before calling `latestInRange`). `parsePnpmVersion` and `formatPnpmVersion`
stay pure (string parsing, not semver operations).

Service requirements unchanged (still `CommandRunner` for `corepack use`).

### Task 2: config.ts -- Replace CommandRunner npm queries with NpmRegistry

Replace `CommandRunner.execCapture("sh", ["-c", "npm view ... --json"])` and
manual JSON parsing with `NpmRegistry.getPackageInfo(pkg)`. Returns
`{ version, integrity }` directly.

Service requirement changes from `CommandRunner` to `NpmRegistry`.

### Task 3: regular.ts -- Replace CommandRunner npm queries with NpmRegistry

Replace `CommandRunner.execCapture` npm dist-tags query with
`NpmRegistry.getLatestVersion(pkg)`. Keep `workspace-tools` for finding
workspace package.json files and dependency maps.

Service requirement changes from `CommandRunner` to `NpmRegistry`.

### Task 4: branch.ts -- Replace commitChanges with GitCommit.commitFiles

Replace 50-line `commitChanges` function (manual tree/commit/ref plumbing)
with `GitCommit.commitFiles(branch, message, fileChanges)`. Build `FileChange`
entries from `git status --porcelain`: `{ path, content }` for modified files,
`{ path, sha: null }` for deleted files.

Remove `pushBranch` (already a no-op). Removes `GitBranch` from
`commitChanges` service requirements (only needs `GitCommit` + `CommandRunner`).

File deletion now works correctly (resolves
`savvy-web/github-action-effects#11`).

### Task 5: main.ts -- Replace createOrUpdatePR with PullRequest service

Replace 110-line `createOrUpdatePR` function (Octokit type-casting hack) with
`PullRequest.getOrCreate({ head, base, title, body, autoMerge })`. Auto-merge
handled inline by the service, removing the separate `AutoMerge.enable()` call.

Rename `PullRequest` schema to `PullRequestResult` to avoid naming conflict
with the library's `PullRequest` service tag.

## Naming Conflict Resolution

Our `src/lib/schemas/index.ts` exports a `PullRequest` schema. The library
exports a `PullRequest` service tag. Rename our schema to `PullRequestResult`
since it represents the result of PR creation, not a PR entity. Affected files:
`schemas/index.ts`, `types/index.ts`, `main.ts`, `main.effect.test.ts`.

## Layer Composition

### Before

```typescript
const appLayer = Layer.mergeAll(
  ghClient,
  GitBranchLive.pipe(Layer.provide(ghClient)),
  GitCommitLive.pipe(Layer.provide(ghClient)),
  CheckRunLive.pipe(Layer.provide(ghClient)),
  GitHubGraphQLLive.pipe(Layer.provide(ghClient)),
  CommandRunnerLive,
  DryRunLive(dryRun),
);
```

### After

```typescript
const appLayer = Layer.mergeAll(
  ghClient,
  GitBranchLive.pipe(Layer.provide(ghClient)),
  GitCommitLive.pipe(Layer.provide(ghClient)),
  CheckRunLive.pipe(Layer.provide(ghClient)),
  PullRequestLive.pipe(Layer.provide(ghClient)),
  NpmRegistryLive,
  CommandRunnerLive,
  DryRunLive(dryRun),
);
```

Changes: add `PullRequestLive`, `NpmRegistryLive`; remove
`GitHubGraphQLLive`, `AutoMerge`.

## Service Dependency Map (After)

| Module | Services Required |
| --- | --- |
| `upgrade.ts` | `CommandRunner` (for `corepack use`) |
| `config.ts` | `NpmRegistry` |
| `regular.ts` | `NpmRegistry` |
| `branch.ts` (`commitChanges`) | `GitCommit` + `CommandRunner` |
| `branch.ts` (`manageBranch`) | `GitBranch` + `CommandRunner` |
| `main.ts` | `PullRequest` + all above + `CheckRun` + `ActionOutputs` |

## Test Strategy

| Module | Current Mock | New Test Layer |
| --- | --- | --- |
| `upgrade.test.ts` | Pure functions + mock `execCapture` | `SemverResolver` calls (namespace) + `CommandRunnerTest` |
| `config.test.ts` | `makeRunner()` with mock `execCapture` | `NpmRegistryTest` with preset package info |
| `regular.test.ts` | `makeRunner()` with mock `execCapture` | `NpmRegistryTest` with preset versions |
| `branch.test.ts` | Mock `GitBranch`/`GitCommit`/`CommandRunner` | Mock `GitCommit`/`CommandRunner` (commitFiles) |
| `main.effect.test.ts` | Mock `GitHubClient` with type casts | `PullRequestTest` with preset state |

## What Stays Custom

| File | Reason |
| --- | --- |
| `src/lib/pnpm/format.ts` | pnpm-workspace.yaml formatting rules |
| `src/lib/changeset/create.ts` | Custom changeset format, pnpm-lockfile-specific grouping |
| `src/lib/lockfile/compare.ts` | Deep pnpm lockfile/catalog parsing |
| `src/lib/schemas/errors.ts` | Domain-specific error types |
| `generatePRBody` / `generateSummary` | Custom markdown using `GithubMarkdown` helpers |

## Expected Impact

- ~150 lines removed (type-cast hack, manual npm JSON parsing, commit plumbing)
- ~50 lines added (new imports, layer wiring)
- 3 direct dependencies removed (`semver`, `@octokit/request`, `@octokit/rest`)
- File deletion via API commits now works correctly
- PR creation is type-safe (no Octokit casting)
