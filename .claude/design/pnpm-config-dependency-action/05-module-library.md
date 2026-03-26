# Services and Utilities

[Back to index](./_index.md)

## Domain Services (src/services/)

All domain logic is wrapped as Effect services with `Context.Tag` + `Layer`.
Each service depends on library services from `@savvy-web/github-action-effects`.

### src/services/branch.ts - BranchManager

Branch management and commit operations using `GitBranch`, `GitCommit`, and
`CommandRunner` library services.

**Service interface:**

```typescript
export class BranchManager extends Context.Tag("BranchManager")<BranchManager, {
 readonly manage: (branchName: string, defaultBranch?: string) =>
  Effect.Effect<BranchResult, GitBranchError | CommandRunnerError>;
 readonly commitChanges: (message: string, branchName: string) =>
  Effect.Effect<void, GitCommitError | CommandRunnerError>;
}>() {}
```

**Branch Strategy:** Delete-and-recreate instead of rebase. When the branch already
exists, it is deleted and recreated from the default branch for a fresh start.

**Commit via GitHub API:** `commitChanges` reads changed files from `git status --porcelain`,
builds a tree via `GitCommit.createTree()`, creates a commit via `GitCommit.createCommit()`
(without author parameter for verification), and updates the branch ref.

### src/services/workspace-yaml.ts - WorkspaceYaml

Format `pnpm-workspace.yaml` consistently to avoid lint-staged hook changes.

**Formatting Rules:**

1. Sort arrays alphabetically: `packages`, `onlyBuiltDependencies`, `publicHoistPattern`
2. Sort `configDependencies` object keys alphabetically
3. Sort top-level keys alphabetically, but keep `packages` first
4. YAML stringify: `indent: 2`, `lineWidth: 0`, `singleQuote: false`

**Exported helpers** (used directly by `main.ts` and `ConfigDeps`):

- `formatWorkspaceYaml(workspaceRoot?)` - Read, sort, and write back
- `readWorkspaceYaml(workspaceRoot?)` - Read and parse workspace YAML
- `sortContent(content)` - Sort workspace content
- `STRINGIFY_OPTIONS` - Consistent YAML stringify options

### src/services/pnpm-upgrade.ts - PnpmUpgrade

Upgrade pnpm to the latest version within `^` semver range via `corepack use`.
Depends on `CommandRunner`.

**Service interface:**

```typescript
export class PnpmUpgrade extends Context.Tag("PnpmUpgrade")<PnpmUpgrade, {
 readonly upgrade: (workspaceRoot?: string) =>
  Effect.Effect<PnpmUpgradeResult | null, FileSystemError>;
}>() {}
```

**Algorithm:**

1. Read root `package.json`
2. Parse `packageManager` field (format: `pnpm@10.28.2`, `pnpm@^10.28.2+sha512...`)
3. Parse `devEngines.packageManager` field (name must be `pnpm`)
4. Query pnpm versions via `npm view pnpm versions --json`
5. Resolve latest in `^` range, run `corepack use pnpm@<version>`
6. Update `devEngines.packageManager.version` if present

### src/services/config-deps.ts - ConfigDeps

Update config dependencies by querying npm via `NpmRegistry` and editing
`pnpm-workspace.yaml` in place. Avoids `pnpm add --config` catalog promotion.

**Service interface:**

```typescript
export class ConfigDeps extends Context.Tag("ConfigDeps")<ConfigDeps, {
 readonly updateConfigDeps: (deps: ReadonlyArray<string>, workspaceRoot?: string) =>
  Effect.Effect<ReadonlyArray<DependencyUpdateResult>>;
}>() {}
```

**Algorithm:**

1. Read `pnpm-workspace.yaml` via `readWorkspaceYaml()`
2. For each dep, query `NpmRegistry` for latest version + integrity
3. Compare current with latest; skip if up-to-date
4. Write back via `sortContent()` + `stringify()`

### src/services/regular-deps.ts - RegularDeps

Update regular dependencies by querying npm via `NpmRegistry`. Avoids
`pnpm up --latest` which promotes deps to catalogs with `catalogMode: strict`.

**Service interface:**

```typescript
export class RegularDeps extends Context.Tag("RegularDeps")<RegularDeps, {
 readonly updateRegularDeps: (patterns: ReadonlyArray<string>, workspaceRoot?: string) =>
  Effect.Effect<ReadonlyArray<DependencyUpdateResult>>;
}>() {}
```

**Key Design Decisions:**

- Queries npm registry directly via `NpmRegistry` service
- Uses `matchesPattern` from `src/utils/deps.ts` for glob matching
- Preserves specifier prefix (`^`, `~`, or exact) from `package.json`
- Skips `catalog:` and `workspace:` specifiers
- Deduplicates per path+dep to avoid duplicate PR table rows
- Gracefully handles npm query failures per-dependency

### src/services/peer-sync.ts - PeerSync

Sync peerDependency ranges after devDependency updates based on `peer-lock` and
`peer-minor` input configuration. Uses semver-effect for version parsing.

**Exported functions:**

- `computePeerRange(params)` - Compute new peer range based on strategy (returns Effect)
- `syncPeers(config, devUpdates, workspaceRoot?)` - Sync all peer ranges

**Types:**

- `PeerStrategy` - `"lock" | "minor"`
- `PeerSyncConfig` - `{ lock: ReadonlyArray<string>; minor: ReadonlyArray<string> }`

**Strategies:**

- `lock`: Sync peer range on every version bump (patch and minor)
- `minor`: Sync peer range only on minor+ bumps, floor patch to `.0`

**Algorithm:**

1. Build strategy lookup map from config
2. Get workspace package info for path resolution
3. For each devDep update matching a strategy:
   - Read the package.json
   - Find the peerDependencies entry
   - Compute new range using `computePeerRange`
   - Write updated package.json

### src/services/lockfile.ts - Lockfile

Compare lockfile snapshots before and after updates to detect changes.
Uses `@pnpm/lockfile.fs` and `workspace-tools`.

**Service interface:**

```typescript
export class Lockfile extends Context.Tag("Lockfile")<Lockfile, {
 readonly capture: (workspaceRoot?: string) =>
  Effect.Effect<LockfileObject | null, LockfileError>;
 readonly compare: (before, after, workspaceRoot?) =>
  Effect.Effect<ReadonlyArray<LockfileChange>, LockfileError>;
}>() {}
```

**Exported helpers** (used by `main.ts` and `Changesets`):

- `captureLockfileState(workspaceRoot?)` - Standalone capture function
- `compareLockfiles(before, after, workspaceRoot?)` - Standalone compare function
- `groupChangesByPackage(changes)` - Group lockfile changes by affected package

### src/services/changesets.ts - Changesets

Create changeset files for affected packages after dependency updates.

**Service interface:**

```typescript
export class Changesets extends Context.Tag("Changesets")<Changesets, {
 readonly create: (changes: ReadonlyArray<LockfileChange>, workspaceRoot?: string) =>
  Effect.Effect<ReadonlyArray<ChangesetFile>, ChangesetError | FileSystemError>;
}>() {}
```

**Exported helper:**

- `createChangesets(changes)` - Standalone function for creating changesets

### src/services/report.ts - Report

PR management and report generation. Depends on `PullRequest` library service.

**Service interface:**

```typescript
export class Report extends Context.Tag("Report")<Report, {
 readonly createOrUpdatePR: (branch, updates, changesets, autoMerge?) =>
  Effect.Effect<PullRequestResult, PullRequestError>;
 readonly generatePRBody: (updates, changesets) => string;
 readonly generateSummary: (updates, changesets, pr, dryRun) => string;
 readonly generateCommitMessage: (updates, appSlug?) => string;
}>() {}
```

**Key fix:** PR creation failures now propagate through the Effect error channel
as `PullRequestError` instead of returning a sentinel `{ number: 0, url: "" }`.

## Layer Composition (src/layers/app.ts)

`makeAppLayer(token, dryRun)` wires all library and domain layers:

```typescript
export const makeAppLayer = (token: string, dryRun: boolean) => {
 const ghClient = GitHubClientLive(token);
 const npmRegistry = NpmRegistryLive.pipe(Layer.provide(CommandRunnerLive));
 const prLayer = PullRequestLive.pipe(Layer.provide(Layer.merge(ghClient, ghGraphql)));

 const libraryLayers = Layer.mergeAll(
  ghClient, gitBranch, gitCommit, CheckRunLive, prLayer,
  npmRegistry, CommandRunnerLive, DryRunLive(dryRun),
 );

 const domainLayers = Layer.mergeAll(
  BranchManagerLive, PnpmUpgradeLive, ConfigDepsLive,
  RegularDepsLive, ReportLive,
 );

 return Layer.provideMerge(domainLayers, libraryLayers);
};
```

## Pure Helpers (src/utils/)

### src/utils/deps.ts

- `parseConfigEntry(entry)` - Parse config dependency entry (version + optional hash)
- `matchesPattern(depName, pattern)` - Glob matching via `path.matchesGlob`
- `parseSpecifier(specifier)` - Parse version specifier; returns `null` for `catalog:`/`workspace:`

### src/utils/markdown.ts

- `npmUrl(packageName)` - Generate npmjs.com URL for a package
- `cleanVersion(version)` - Strip prefix characters from version string

### src/utils/pnpm.ts

- `parsePnpmVersion(raw, stripPnpmPrefix?)` - Parse version from `packageManager` or `devEngines`
- `formatPnpmVersion(version, hasCaret)` - Format version with optional caret
- `detectIndent(content)` - Detect JSON file indentation (reused by `RegularDeps`)

### src/utils/semver.ts

- `resolveLatestInRange(versions, current)` - Find highest stable version satisfying `^current`
