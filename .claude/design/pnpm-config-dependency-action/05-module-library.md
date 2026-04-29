# Services and Utilities

[Back to index](./_index.md)

## Domain Services (src/services/)

All domain logic is wrapped as Effect services with `Context.Tag` + `Layer`,
or (for stateless concerns) exported as standalone helper functions. Each
service depends on library services from `@savvy-web/github-action-effects`
and/or the new `workspaces-effect` package.

### Workspace discovery (via workspaces-effect)

There is no local `Workspaces` wrapper service. Domain services consume the
upstream `WorkspaceDiscovery` Tag from `workspaces-effect` directly. The
local wrapper was removed (issue #38) once `workspaces-effect@0.5.1` exposed
`WorkspaceDiscovery.listPackages(cwd?)` and
`WorkspaceDiscovery.importerMap(cwd?)` accepting an optional cwd parameter.

The upstream service interface (relevant slice):

```typescript
import { WorkspaceDiscovery } from "workspaces-effect";

// WorkspaceDiscovery exposes (among others):
//   listPackages: (cwd?: string) =>
//     Effect.Effect<ReadonlyArray<WorkspacePackage>, ...>
//   importerMap: (cwd?: string) =>
//     Effect.Effect<ReadonlyMap<string, WorkspacePackage>, ...>
```

`importerMap` returns a map keyed by importer path relative to the workspace
root (`.` for the root workspace), used by `Lockfile.compare` to translate
importer ids into package names.

`WorkspaceDiscoveryLive` requires `WorkspaceRootLive` and `NodeContext.layer`
(FileSystem/Path). Both are wired in `makeAppLayer`; integration tests build
their own `discoveryLayer` from `NodeContext.layer` directly.

### src/services/changeset-config.ts - ChangesetConfig

Reads `.changeset/config.json` from the workspace root (with per-call,
layer-scoped caching) and exposes:

- `mode(workspaceRoot)` — returns `"silk" | "vanilla" | "none"`. `silk` when
  the configured `changelog` value (or its first array element) starts with
  `@savvy-web/changesets`; `vanilla` when changesets is configured otherwise;
  `none` when `.changeset/config.json` does not exist.
- `versionPrivate(workspaceRoot)` — returns whether
  `privatePackages.version === true`.

The cache is layer-scoped (each `ChangesetConfigLive` instance gets its own
`Map`), so tests that provide a fresh layer per case don't share state. In
production, each `.changeset/config.json` is read at most once per
`workspaceRoot` for the action's lifetime.

### src/services/publishability.ts - PublishabilityDetector overrides

Provides two `Layer` overrides for `workspaces-effect`'s
`PublishabilityDetector` Tag:

- **`SilkPublishabilityDetectorLive`** — applies silk rules
  (`publishConfig.targets`, shorthand expansion, access inheritance):
  - `pkg.private !== true` → publishable (one default target).
  - `pkg.private === true` + `publishConfig.access` set + no targets →
    publishable (one target).
  - `pkg.private === true` + `publishConfig.targets` non-empty → resolve each
    target; emit one `PublishTarget` per target that resolves to
    `public`/`restricted` access. Strings inherit parent access; objects may
    declare their own.
  - Otherwise → not publishable (`[]`).
  This is the chunk that will lift cleanly to `@savvy-web/silk-effects` later.

- **`PublishabilityDetectorAdaptiveLive`** — reads `ChangesetConfig.mode`
  per-call and dispatches:
  - `"silk"`    → silk rules (above).
  - `"vanilla"` → library default (`PublishabilityDetectorLive` from
    `workspaces-effect`).
  - `"none"`    → always returns `[]`.
  Implemented with `Layer.effect` and per-call dispatch via a yielded
  `ChangesetConfig` rather than `Layer.unwrapEffect`, so the mode is
  re-checked on every `detect` call. `makeAppLayer` wires the adaptive
  variant.

The versionable cascade (publishable OR `versionPrivate`) lives inline in
`Changesets.create` — it is silk-changesets-specific and short enough not to
need its own service.

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

**Branch Strategy:** Delete-and-recreate instead of rebase. When the branch
already exists, it is deleted and recreated from the default branch for a
fresh start.

**Commit via GitHub API:** `commitChanges` reads changed files from
`git status --porcelain` (handling `D`-marked deletions as `{ path, sha: null }`)
and calls `GitCommit.commitFiles(branch, message, fileChanges)` — the library's
single-call wrapper that creates the tree, the commit (without an explicit
author so GitHub verifies it), and updates the branch ref. After committing,
the working tree is synced via `git fetch origin <branch>` + `git reset --hard
origin/<branch>` because `git checkout` would refuse to overwrite the
just-committed working-copy state.

### src/services/workspace-yaml.ts - WorkspaceYaml

Format `pnpm-workspace.yaml` consistently to avoid lint-staged hook changes.

**Formatting Rules:**

1. Sort arrays alphabetically: `packages`, `onlyBuiltDependencies`, `publicHoistPattern`
2. Sort `configDependencies` object keys alphabetically
3. Sort top-level keys alphabetically, but keep `packages` first
4. YAML stringify: `indent: 2`, `lineWidth: 0`, `singleQuote: false`

**Exported helpers** (used directly by `program.ts` and `ConfigDeps`):

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

- Queries npm registry directly via `NpmRegistry` service.
- Enumerates workspace `package.json` files via `WorkspaceDiscovery` from
  `workspaces-effect` (consumed directly — no local wrapper service).
- Uses `matchesPattern` from `src/utils/deps.ts` for glob matching.
- Preserves specifier prefix (`^`, `~`, or exact) from `package.json`.
- Skips `catalog:` and `workspace:` specifiers.
- Iterates `dependencies`, `devDependencies`, and `optionalDependencies`
  via `DEP_SECTIONS` (a typed array of `{ field, type }` records).
  `peerDependencies` are intentionally excluded — peer ranges are managed
  by `syncPeers`, not by direct version bumps. Catalog-resolved deps in
  any section still flow through `compareCatalogs` independently.
- Each match carries its `field` and `type` through the pipeline. Dedup
  is per `(path, field)`, so a dep declared in both `dependencies` and
  `devDependencies` of one package emits two records, each with the
  accurate `type`.
- `updatePackageJson` accepts `Map<DepSectionField, Map<string, string>>`
  so each section is updated independently without cross-pollination.
- `DependencyUpdateResult.type` reflects the actual section (`dependency`
  / `devDependency` / `optionalDependency`) instead of being hardcoded.
- Gracefully handles npm query failures per-dependency.

### src/services/peer-sync.ts - PeerSync

Sync peerDependency ranges after devDependency updates based on `peer-lock`
and `peer-minor` input configuration. Uses `semver-effect` for version
parsing. **Has no `Context.Tag` of its own** — exported as standalone
functions and consumed directly from `program.ts`. Yields `WorkspaceDiscovery`
from `workspaces-effect` to resolve package paths.

**Exported functions:**

- `computePeerRange(params)` — Compute new peer range based on strategy
  (returns `Effect<string | null, never>`).
- `syncPeers(config, devUpdates, workspaceRoot?)` — Sync all peer ranges;
  signature is
  `Effect<readonly DependencyUpdateResult[], FileSystemError, WorkspaceDiscovery>`.

**Types:**

- `PeerStrategy` — `"lock" | "minor"`.
- `PeerSyncConfig` — `{ lock: ReadonlyArray<string>; minor: ReadonlyArray<string> }`.

**Strategies:**

- `lock`: Sync peer range on every version bump (patch and minor).
- `minor`: Sync peer range only on minor+ bumps, floor patch to `.0`.

**Algorithm:**

1. Build strategy lookup map from config.
2. Yield `WorkspaceDiscovery` and call `listPackages(workspaceRoot)` to
   resolve package paths.
3. For each devDep update matching a strategy:
   - Read the package.json.
   - Find the peerDependencies entry.
   - Compute new range using `computePeerRange`.
   - Write updated package.json.

### src/services/lockfile.ts - Lockfile

Compare lockfile snapshots before and after updates to detect changes.
Uses `@pnpm/lockfile.fs` and yields `WorkspaceDiscovery` from
`workspaces-effect`.

**Service interface:**

```typescript
export class Lockfile extends Context.Tag("Lockfile")<Lockfile, {
 readonly capture: (workspaceRoot?: string) =>
  Effect.Effect<LockfileObject | null, LockfileError>;
 readonly compare: (before, after, workspaceRoot?) =>
  Effect.Effect<ReadonlyArray<LockfileChange>, LockfileError, WorkspaceDiscovery>;
}>() {}
```

**Key behavior — `compareCatalogs`:** for each catalog change, the comparator
walks every importer that consumes the catalog entry and emits **one
`LockfileChange` record per (catalog change, consuming importer, dep
section) triple**. Each record carries the precise `type` field
(`dependency` / `devDependency` / `optionalDependency` / `peerDependency`),
so downstream `Changesets` gating can use `type` alone as the trigger
signal. Catalog refs in `devDependencies` are returned with `type:
"devDependency"` and treated by `Changesets` as informational only.

`compareImporters` handles non-catalog specifier changes (including
removals), reading dep section from the `after` snapshot to type each entry.

**Exported helpers** (used by `program.ts` and `Changesets`):

- `captureLockfileState(workspaceRoot?)` - Standalone capture function
- `compareLockfiles(before, after, workspaceRoot?)` - Standalone compare
  function (signature requires `WorkspaceDiscovery` in its environment)
- `groupChangesByPackage(changes)` - Group lockfile changes by affected package

### src/services/changesets.ts - Changesets

Create changeset files for affected packages after dependency updates.
Depends on `WorkspaceDiscovery` (from `workspaces-effect`),
`PublishabilityDetector` (from `workspaces-effect`), and `ChangesetConfig`.

**Service interface:**

```typescript
export class Changesets extends Context.Tag("Changesets")<Changesets, {
 readonly create: (
  workspaceRoot: string,
  lockfileChanges: ReadonlyArray<LockfileChange>,
  regularUpdates?: ReadonlyArray<DependencyUpdateResult>,
  peerUpdates?: ReadonlyArray<DependencyUpdateResult>,
 ) => Effect.Effect<ReadonlyArray<ChangesetFile>, ChangesetError | FileSystemError>;
}>() {}
```

Note that `workspaceRoot` is the **first** parameter (the previous signature
that took it last is no longer supported). The third parameter was renamed
from `devUpdates` to `regularUpdates` to reflect that it now carries
dependency/devDependency/optionalDependency updates from the multi-section
RegularDeps scan.

**Gating rules:**

- Skips entirely if no `.changeset/` directory exists at `workspaceRoot`.
- For each workspace package, builds per-package `triggerRows` and `devRows`:
  - `dependency`, `optionalDependency`, and `peerDependency` lockfile
    changes are **triggers**; `devDependency` lockfile changes are
    informational only.
  - Peer-sync `peerUpdates` are always triggers (with `type:
    "peerDependency"`).
  - `regularUpdates` are routed by `update.type` against the same
    `TRIGGER_TYPES` set used for lockfile changes:
    `dependency`/`optionalDependency`/`peerDependency` go to
    `triggerRows`; `devDependency` goes to `devRows`. RegularDeps does
    not currently emit `peerDependency`-typed records (peer ranges are
    managed by `syncPeers`), but the routing tolerates them so future
    expansion is safe. `updateToRow` honors `from === null` for the
    "added" action and uses `update.type` directly when no override is
    provided.
- A changeset is emitted for a package only when it has at least one
  trigger row AND the package is **versionable**:
  `versionable = publishable || versionPrivate`, where:
  - `publishable` = `PublishabilityDetector.detect(...)` returns at least
    one target (silk rules, vanilla rules, or none-mode noop, depending on
    `ChangesetConfig.mode`).
  - `versionPrivate` = `ChangesetConfig.versionPrivate(workspaceRoot)`
    (i.e. `.changeset/config.json` has `privatePackages.version: true`).
- Empty changesets are no longer written. The previous fallback path that
  wrote a generic patch on every run has been deleted.
- Each emitted changeset's body is a single Markdown table covering both
  trigger and informational rows, deduplicated by `(dependency, type)`.

**Exported helper:**

- `hasChangesets(workspaceRoot?)` — checks for the existence of
  `.changeset/` (used for early skip / no-op messaging).

### src/services/report.ts - Report

PR management and report generation. Depends on `PullRequest` library
service. Uses `GithubMarkdown` from the library to assemble PR bodies and
summaries.

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

**Key fix:** PR creation failures propagate through the Effect error channel
as `PullRequestError` instead of returning a sentinel `{ number: 0, url: "" }`.

## Layer Composition (src/layers/app.ts)

`makeAppLayer(dryRun)` wires all library and domain layers. Its only argument
is `dryRun`; the GitHub App token is bridged to `GitHubClientLive` via
`process.env.GITHUB_TOKEN` upstream in `program.ts`, not as a Layer parameter.

```typescript
export const makeAppLayer = (dryRun: boolean) => {
 const ghGraphql = GitHubGraphQLLive.pipe(Layer.provide(GitHubClientLive));
 const npmRegistry = NpmRegistryLive.pipe(Layer.provide(CommandRunnerLive));
 const gitBranch = GitBranchLive.pipe(Layer.provide(GitHubClientLive));
 const gitCommit = GitCommitLive.pipe(Layer.provide(GitHubClientLive));
 const prLayer = PullRequestLive.pipe(Layer.provide(Layer.merge(GitHubClientLive, ghGraphql)));

 // Platform layer (FileSystem, Path) for workspaces-effect's WorkspaceDiscovery.
 const platform = NodeContext.layer;
 const workspaceRoot = WorkspaceRootLive.pipe(Layer.provide(platform));
 const workspaceDiscovery = WorkspaceDiscoveryLive.pipe(
  Layer.provide(Layer.merge(workspaceRoot, platform)),
 );

 const changesetConfig = ChangesetConfigLive;
 // PublishabilityDetectorAdaptiveLive overrides PublishabilityDetector and
 // reads ChangesetConfig.mode per-call to dispatch to silk/vanilla/noop.
 const publishabilityDetector = PublishabilityDetectorAdaptiveLive.pipe(Layer.provide(changesetConfig));

 const libraryLayers = Layer.mergeAll(
  GitHubClientLive, gitBranch, gitCommit,
  CheckRunLive.pipe(Layer.provide(GitHubClientLive)),
  prLayer, npmRegistry, CommandRunnerLive, DryRunLive(dryRun),
 );

 const domainLayers = Layer.mergeAll(
  workspaceDiscovery,
  changesetConfig,
  publishabilityDetector,
  ChangesetsLive.pipe(Layer.provide(Layer.mergeAll(workspaceDiscovery, publishabilityDetector, changesetConfig))),
  BranchManagerLive.pipe(Layer.provide(Layer.mergeAll(gitBranch, gitCommit, CommandRunnerLive))),
  PnpmUpgradeLive.pipe(Layer.provide(CommandRunnerLive)),
  ConfigDepsLive.pipe(Layer.provide(npmRegistry)),
  RegularDepsLive.pipe(Layer.provide(Layer.merge(npmRegistry, workspaceDiscovery))),
  ReportLive.pipe(Layer.provide(prLayer)),
 );

 return Layer.provideMerge(domainLayers, libraryLayers);
};
```

`WorkspaceDiscoveryLive` and `WorkspaceRootLive` come from
`workspaces-effect`; `NodeContext.layer` (from `@effect/platform-node`)
satisfies their FileSystem/Path requirements. There is no local `Workspaces`
service Tag — domain services consume the upstream `WorkspaceDiscovery` Tag
directly.

## Pure Helpers (src/utils/)

### src/utils/deps.ts

- `parseConfigEntry(entry)` - Parse config dependency entry (version + optional hash)
- `matchesPattern(depName, pattern)` - Glob matching via `path.matchesGlob`
- `parseSpecifier(specifier)` - Parse version specifier; returns `null` for `catalog:`/`workspace:`

### src/utils/input.ts

- `parseMultiValueInput(raw)` — Normalize a multi-value GitHub Action input
  string. Accepts JSON arrays, newline-separated lists (with optional `*`
  bullets and `#` comments), or comma-separated values.

### src/utils/markdown.ts

- `npmUrl(packageName)` - Generate npmjs.com URL for a package
- `cleanVersion(version)` - Strip prefix characters from version string

### src/utils/pnpm.ts

- `parsePnpmVersion(raw, stripPnpmPrefix?)` - Parse version from `packageManager` or `devEngines`
- `formatPnpmVersion(version, hasCaret)` - Format version with optional caret
- `detectIndent(content)` - Detect JSON file indentation (reused by `RegularDeps` and `PeerSync`)

### src/utils/semver.ts

- `resolveLatestInRange(versions, current)` - Find highest stable version satisfying `^current`
