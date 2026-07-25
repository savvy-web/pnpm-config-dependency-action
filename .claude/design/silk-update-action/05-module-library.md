---
status: current
module: silk-update-action
category: architecture
created: 2026-02-20
updated: 2026-07-24
last-synced: 2026-07-24
completeness: 95
related:
  - ./_index.md
dependencies: []
implementation-plans: []
---

# Services and Utilities

[Back to index](./_index.md)

## Domain Services (src/services/)

All domain logic is wrapped as Effect services with `Context.Service` (v4; was
`Context.Tag`) + `Layer`, or (for stateless concerns) exported as standalone
helper functions. Each service depends on library services from
`@savvy-web/github-action-effects` and/or `@effected/workspaces`. The v4
`Context.Service` form is `class Foo extends Context.Service<Foo, Shape>()("Foo") {}`;
where a service value needs typing without being yielded, the library exposes a
companion `*Shape` interface (e.g. `NpmRegistryShape`).

### Workspace discovery (via @effected/workspaces)

Domain services consume the `WorkspaceDiscovery` service from
`@effected/workspaces` directly, via its **arg-less** `listPackages()` and
`importerMap()` methods. In Effect v4 the workspace root is bound when the layer
is built (`WorkspaceDiscovery.layer(opts?)`), so these methods no longer take a
`cwd` parameter.

The upstream service interface (relevant slice):

```typescript
import { WorkspaceDiscovery } from "@effected/workspaces";

// WorkspaceDiscovery exposes (among others):
//   listPackages: () =>
//     Effect.Effect<ReadonlyArray<WorkspacePackage>, ...>
//   importerMap: () =>
//     Effect.Effect<ReadonlyMap<string, WorkspacePackage>, ...>
// (companion WorkspaceDiscoveryShape types a resolved instance)
```

`importerMap` returns a map keyed by importer path relative to the workspace
root (`.` for the root workspace), used by `Lockfile.compare` to translate
importer ids into package names.

`WorkspaceDiscovery.layer()` requires `WorkspaceRoot.layer` and
`NodeServices.layer` (FileSystem/Path). Both are wired in `makeAppLayer`;
integration tests build their own `discoveryLayer` from `NodeServices.layer`
directly.

**Caching:** `WorkspaceDiscovery` caches `listPackages` per root for the layer
lifetime, and Effect memoizes layers by object reference, so every consumer
wired from the same layer shares one instance — an enumeration cached before
`ConfigDeps`/`RegularDeps` edit manifests stays stale for later readers unless
refreshed. DepsRegen refreshes at plan time (see the `Changesets` service
below), so the changeset step is not bitten by this.

### Changeset gating (via @savvy-web/silk-effects DepsRegen)

The dependency-changeset step delegates entirely to silk's `Changesets.DepsRegen` — see the `Changesets` service below. All gating (versionable-minus-ignored: publishable OR `privatePackages.version`, minus the changeset `ignore` list) lives **upstream inside DepsRegen**. The action no longer wraps `ChangesetConfig` or the `PublishabilityDetector` overrides: the former `services/changeset-config.ts` and `services/publishability.ts` re-export shims are deleted, and DepsRegen's batteries-included Layer (`DepsRegenDefault`) provides those services internally.

### src/services/branch.ts - BranchManager

Branch management and commit operations using `GitBranch`, `GitCommit`, and
`CommandRunner` library services.

**Service interface:**

```typescript
export class BranchManager extends Context.Service<BranchManager, {
 readonly manage: (branchName: string, defaultBranch?: string) =>
  Effect.Effect<BranchResult, GitBranchError | CommandRunnerError>;
 readonly commitChanges: (message: string, branchName: string) =>
  Effect.Effect<void, GitCommitError | CommandRunnerError>;
 readonly validateBranches: (source: string, target: string) =>
  Effect.Effect<void, GitBranchError | ActionInputError>;
 readonly ensureBaseHistory: (base: string) =>
  Effect.Effect<void, CommandRunnerError>;
}>()("BranchManager") {}
```

**Branch Strategy:** Delete-and-recreate instead of rebase. The update branch is
created from (and reset to) the configurable `source-branch` (default `main`,
passed as `manage`'s second argument). When the branch already exists, it is
deleted and recreated from the source branch for a fresh start.

**Pre-flight validation:** `validateBranches(source, target)` yields
`GitBranch.exists` for both refs and fails fast with `ActionInputError`
(`inputName` `"source-branch"` / `"target-branch"`) if either ref is missing
(the target check is skipped when `target === source`). `program.ts` calls it
inside `withCheckRun` **before** `manage`, so a typo'd ref aborts before the
destructive delete-and-recreate.

**Commit via GitHub API:** `commitChanges` reads changed files from
`git status --porcelain` (handling `D`-marked deletions as `{ path, sha: null }`)
and calls `GitCommit.commitFiles(branch, message, fileChanges)` — the library's
single-call wrapper that creates the tree, the commit (without an explicit
author so GitHub verifies it), and updates the branch ref. After committing,
the working tree is synced via `git fetch origin <branch>` + `git reset --hard
origin/<branch>` because `git checkout` would refuse to overwrite the
just-committed working-copy state.

**Base-history preflight:** `ensureBaseHistory(base)` probes
`git merge-base <base> HEAD`; if it resolves (the `fetch-depth: 0` case) it is
a no-op.
Otherwise it best-effort fetches the base ref, unshallows a shallow clone and
materializes a local `base` ref, then warns (non-fatal) if the merge-base is
still missing. `program.ts` calls it before the changeset step because silk's
`DepsRegen` diffs `merge-base(base) → worktree`, which a shallow checkout
cannot resolve.

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

Upgrade pnpm by editing the `packageManager` and `devEngines.packageManager` fields of the root `package.json` directly — **not** via `corepack use`. `corepack use` errors when both `packageManager` and `devEngines.packageManager` are present, so the service derives corepack's canonical hash itself and writes the fields; the subsequent `runInstall` performs the actual corepack switch. Depends on `NpmRegistry` (not `CommandRunner`): `NpmRegistryLive` routes every npm invocation through a runner-writable cache (`--cache $RUNNER_TEMP/silk-npm-cache`), sidestepping the partially root-owned `~/.npm` on GitHub macOS runners that made a raw `npm view` shell-out fail with EACCES (the pnpm upgrade was skipped with a warning while `ConfigDeps`/`RegularDeps`, already on `NpmRegistry`, succeeded).

**Service interface:**

```typescript
export class PnpmUpgrade extends Context.Service<PnpmUpgrade, {
 readonly upgrade: (mode: string, workspaceRoot?: string) =>
  Effect.Effect<PnpmUpgradeResult | null, FileSystemError>;
}>()("PnpmUpgrade") {}
```

`mode` is the parsed `upgrade-package-manager` value (`false` | `true` | `auto` | a semver
range). `false` returns `null` (skip).

**Algorithm:**

1. Read root `package.json` and parse the `packageManager` field
   (`pnpm@10.28.2`, `pnpm@^10.28.2+sha512...`) and the `devEngines.packageManager`
   field (name must be `pnpm`).
2. Pick a **reference** version favoring `devEngines.packageManager` over the
   `packageManager` field.
3. Choose a target range: `true`/`auto` use `^reference` (latest within the
   current major; skip with a warning if no reference exists); an explicit
   semver range is used verbatim (may cross majors).
4. Query available versions via `NpmRegistry.getVersions("pnpm")` and resolve via `resolveLatestSatisfying`. Skip if none satisfies or the resolved version equals the reference.
5. Derive the corepack-canonical `+sha512.<hex>` hash from the resolved version's npm registry integrity (`NpmRegistry.getPackageInfo("pnpm", resolved)` → `.integrity` → `corepackHashFromIntegrity`, best-effort with an `Effect.catch`); fall back to a bare version when integrity is unavailable.
6. Write `packageManager` = `pnpm@<v>+sha512.<hex>` (creating it in range mode
   when no pnpm field exists at all) and, when present,
   `devEngines.packageManager.version` = `<v>+sha512.<hex>`. The pinned hash is
   inherently exact, so no range operator is written. Returns
   `PnpmUpgradeResult` with `from: string | null` and `added: boolean`.

### src/services/release-age.ts - ReleaseAge

Mirror pnpm's `minimumReleaseAge` / `minimumReleaseAgeExclude` gate at resolution time so `ConfigDeps` and `RegularDeps` never propose a version pnpm would reject at install time (`ERR_PNPM_NO_MATURE_MATCHING_VERSION`). The gate vocabulary (`ReleaseAgeGate`, `PartialReleaseAgeGate`) lives upstream in `@effected/npm`; this module owns discovery, publish-time fetching and the service wiring.

**Service interface:**

```typescript
export class ReleaseAge extends Context.Service<ReleaseAge, {
 readonly gate: () => Effect.Effect<ReleaseAgeGate>;
 readonly filterVersions: (pkg: string, versions: ReadonlyArray<string>) =>
  Effect.Effect<ReadonlyArray<string>>;
}>()("ReleaseAge") {}
```

**Gate discovery (two sources, combined strictest-wins via `ReleaseAgeGate.combine`, assembled once and `Effect.cached` for the layer lifetime):**

- `readInlineReleaseAge(workspaceRoot?)` — reads `minimumReleaseAge` / `minimumReleaseAgeExclude` declared inline in `pnpm-workspace.yaml`.
- `replayHookReleaseAge(workspaceRoot?)` — replays the workspace's config-dependency pnpmfile `updateConfig` hooks in a **node subprocess** via `CommandRunner` (script passed via argv, `pnpmfile.mjs` first then `.cjs`, mirroring pnpm 11's loader order) and reads the release-age keys they inject. A subprocess because `pnpm config get` never sees hook-injected values, and the rspack bundle cannot host an in-process computed dynamic import (the `nativeDynamicImports` knot documented in `01-dependencies.md` and `action.config.ts`). Best-effort: any per-dependency or whole-replay failure degrades to no contribution with a warning.

**Filtering:** `filterVersions(pkg, versions)` is the identity when the gate is inert (`ageMinutes <= 0`), the package is excluded (`gate.isExcluded` — pnpm's flat-string `*` matcher, not minimatch), or publish times are unavailable. Otherwise `getPublishTimes(pkg)` shells `npm view <pkg> time --json` through the same runner-writable cache `NpmRegistryLive` uses and the upstream pure `gate.filterVersions` drops versions younger than the cutoff. The whole path **fails open** — the worst case of missing data is exactly the pre-gate behavior, and pnpm still enforces the gate at install time.

**Layers:** `ReleaseAgeLive(workspaceRoot?)` is a parameterized factory (root bound at build, mirroring the `@effected/workspaces` idiom; requires `CommandRunner`). `ReleaseAgeNoop` is the inert layer (zero gate, identity filtering) for unit tests and non-pnpm paths.

### src/services/config-deps.ts - ConfigDeps

Update config dependencies by querying npm via `NpmRegistry` and editing
`pnpm-workspace.yaml` in place. Avoids `pnpm add --config` catalog promotion.
Depends on `NpmRegistry` and `ReleaseAge`.

**Service interface:**

```typescript
export class ConfigDeps extends Context.Service<ConfigDeps, {
 readonly updateConfigDeps: (deps: ReadonlyArray<string>, workspaceRoot?: string) =>
  Effect.Effect<ReadonlyArray<DependencyUpdateResult>>;
}>()("ConfigDeps") {}
```

**Algorithm:**

1. Read `pnpm-workspace.yaml` via `readWorkspaceYaml()`
2. For each dep, parse its hash-pinned version, derive a conservative upgrade
   range from the major via `configDepUpgradeRange` (`src/utils/semver.ts`),
   query `NpmRegistry.getVersions`, filter the candidates through
   `ReleaseAge.filterVersions`, and resolve the highest in-range version via
   `resolveLatestSatisfying` — config deps carry no declared range, so the range
   is synthesized rather than reading npm's absolute latest
3. Compare current with the resolved version; skip if up-to-date, otherwise fetch
   the integrity for **that** resolved version via `getPackageInfo(dep, resolved)`
4. Write back via `sortContent()` + `stringify()`

The range keeps a `>=1.0.0` dep within its current major; a `<1.0.0` dep may
advance across `0.x` and adopt the first stable major but never crosses two
majors in one step.

### src/services/regular-deps.ts - RegularDeps

Update regular dependencies by querying npm via `NpmRegistry`. Avoids
`pnpm up --latest` which promotes deps to catalogs with `catalogMode: strict`.

**Service interface:**

```typescript
export class RegularDeps extends Context.Service<RegularDeps, {
 readonly updateRegularDeps: (patterns: ReadonlyArray<string>, workspaceRoot?: string) =>
  Effect.Effect<ReadonlyArray<DependencyUpdateResult>>;
}>()("RegularDeps") {}
```

**Key Design Decisions:**

- Queries every published version via `NpmRegistry.getVersions` and resolves the
  highest version **satisfying the current specifier treated as a range** via
  `resolveLatestSatisfying` — it does not read npm's absolute `latest` dist-tag.
  So `^4.0.0` stays within major 4, `~3.0.0` stays within the minor, `>=4.0.0`
  may advance across a major, and an exact pin (a one-version range) never bumps.
  The sole exception is caret-on-zero (`^0.y.z`): it is widened via
  `resolutionRangeForSpecifier` to the config-dep range (`>=version <2.0.0`) so a
  `^0.5.0` dep rolls forward across `0.x` and adopts the first stable `1.x`, with
  the caret still re-applied verbatim on write-back.
- Candidate versions are filtered through `ReleaseAge.filterVersions` between the registry query and `resolveLatestSatisfying`, so the written specifier floor always respects the workspace's pnpm `minimumReleaseAge` gate (see the `ReleaseAge` section above; fail-open).
- Enumerates workspace `package.json` files via `WorkspaceDiscovery` from
  `@effected/workspaces`.
- Uses `matchesPattern` from `src/utils/deps.ts` for glob matching.
- Preserves specifier prefix (`^`, `~`, or exact) from `package.json`, re-applied
  verbatim to the resolved version.
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
  / `devDependency` / `optionalDependency`).
- Gracefully handles npm query failures per-dependency.

### src/services/peer-sync.ts - PeerSync

Sync peerDependency ranges after devDependency updates based on `peer-lock`
and `peer-minor` input configuration. Uses `@effected/semver` for version
parsing. **Has no service tag of its own** — exported as standalone
functions and consumed directly from `program.ts`. Yields `WorkspaceDiscovery`
from `@effected/workspaces` to resolve package paths.

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
2. Yield `WorkspaceDiscovery` and call `listPackages()` to
   resolve package paths.
3. For each devDep update matching a strategy:
   - Read the package.json.
   - Find the peerDependencies entry.
   - Compute new range using `computePeerRange`.
   - Write updated package.json.

### src/services/lockfile.ts - Lockfile

Compare lockfile snapshots before and after updates to detect changes.
Parses lockfiles with `@effected/lockfiles`' pure `Lockfile.parse(content, { format })`
and yields `WorkspaceDiscovery` from `@effected/workspaces`. Package-manager
agnostic: normalizes `pnpm-lock.yaml`, `bun.lock` and `package-lock.json` into
one `Lockfile` model (the `@effected/lockfiles` `Lockfile` type; a decoded
`ImporterDependency.specifier` is read via `.specifier.raw`).

**Service interface:**

```typescript
export class Lockfile extends Context.Service<Lockfile, {
 readonly capture: (pm: SupportedPm, workspaceRoot?: string) =>
  Effect.Effect<Lockfile | null, LockfileError>;
 readonly compare: (before, after, workspaceRoot?) =>
  Effect.Effect<ReadonlyArray<LockfileChange>, LockfileError, WorkspaceDiscovery>;
}>()("Lockfile") {}
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

- `captureLockfileState(pm, workspaceRoot?)` - Standalone capture function
- `compareLockfiles(before, after, workspaceRoot?)` - Standalone compare
  function (signature requires `WorkspaceDiscovery` in its environment)
- `groupChangesByPackage(changes)` - Group lockfile changes by affected package

### src/services/changesets.ts - Changesets

A **thin adapter** over silk's `Changesets.DepsRegen` (from
`@savvy-web/silk-effects`), which is the source of truth for dependency
changesets. Depends only on `SilkChangesets.DepsRegen`. The bespoke changeset
writer and the local gating cascade this file used to carry are gone — see
`src/services/changesets.ts` for the adapter.

**Service interface:**

```typescript
export class Changesets extends Context.Service<Changesets, {
 readonly create: (
  workspaceRoot: string,
  base: string,
 ) => Effect.Effect<ReadonlyArray<ChangesetFile>, ChangesetError>;
}>()("Changesets") {}
```

`create(workspaceRoot, base)` calls `depsRegen.plan({ cwd: workspaceRoot, base })`
then `execute(plan)`, and maps `result.written` back to `ChangesetFile[]` for
reporting — reconstructing each `## Dependencies` table via
`SilkChangesets.serializeDependencyTableToMarkdown`. DepsRegen failures
(`GitError`, `WorkspaceDiscoveryError`, `ChangesetIOError`,
`PointInTimeReadError`) are collapsed into the local `ChangesetError` via
`Effect.mapError`. `base` is the resolved `target-branch` (the release
baseline) — the anchor for DepsRegen's `merge-base(base) → worktree` diff.

**Behavior (all upstream in DepsRegen):**

- The adapter short-circuits with an empty result when no `.changeset/`
  directory exists (`hasChangesets` guard).
- Content is DepsRegen's cumulative git diff (`merge-base(base) → worktree`,
  catalog-/workspace-aware). It writes one consolidated dependency changeset
  per in-scope package and deletes stale pure-dependency changesets, so
  re-firing converges to a single current table per package (idempotent).
  devDependency rows are dropped; mixed changesets (Dependencies table +
  prose) are left untouched.
- Gating is silk "versionable-minus-ignored" (publishable OR
  `privatePackages.version`, minus the changeset `ignore` list), applied
  inside DepsRegen. The action no longer re-implements the ignore gate,
  versionable cascade or trigger/informational classification.
- Specifiers on both sides of the diff resolve through `@effected/workspaces`' importer-scoped `WorkspaceStateSnapshot.resolveIn`, so a `catalog:` specifier whose catalog comes from a config-dependency pnpmfile hook (in neither `pnpm-workspace.yaml` nor the lockfile's `catalogs:` block) still yields a concrete version per side and a real movement emits a row. The workspace-wide `resolve` abstains when importers disagree on a version, so it cannot be used here.
- Cell text is emitted literally (only `|` and `\` escaped), so `~` specifiers and underscored package names reach the changeset unescaped.
- `plan` refreshes workspace discovery before its snapshots and gating reads (silk-effects; `@effected/workspaces`' `worktree()` also refreshes), so the diff sees manifests edited earlier in the same run. Without this the memoized discovery cache served pre-update manifests, the worktree snapshot equaled the merge-base snapshot and the step silently wrote 0 changesets.

**Exported helper:**

- `hasChangesets(workspaceRoot?)` — checks for the existence of
  `.changeset/` (used for early skip / no-op messaging).

### src/services/runtime-upgrade.ts - RuntimeUpgrade

Upgrade `devEngines.runtime` entries (node/deno/bun) in the root `package.json`
via `@effected/runtimes`. Depends on the `NodeResolver`, `DenoResolver`, and
`BunResolver` services from `@effected/runtimes`. Mirrors `PnpmUpgrade`; resolver
failures are caught and skipped per-runtime, never fatal.

**Service interface:**

```typescript
export class RuntimeUpgrade extends Context.Service<
 RuntimeUpgrade,
 {
  readonly upgrade: (
   config: RuntimeUpgradeConfig,
   workspaceRoot?: string,
  ) => Effect.Effect<readonly RuntimeUpgradeResult[], FileSystemError>;
 }
>()("RuntimeUpgrade") {}
```

**Types:**

- `RuntimeName` — `"node" | "deno" | "bun"`.
- `RuntimeUpgradeConfig` — `{ node: string; deno: string; bun: string }` where each field
  is `"false"`, `"auto"`, or an explicit semver range string.
- `RuntimeUpgradeResult` — `{ runtime: RuntimeName; from: string; to: string }`. `from` is the version the manifest already declared; `to` is always a bare, exact version.

**Resolution algorithm (per runtime):**

1. If the mode is `"false"`, return `null` (skip).
2. Look up the existing `devEngines.runtime` entry via `findRuntimeEntry`. **If none exists, skip
   with a warning** naming the runtime and the input — in *every* mode. These inputs upgrade a
   runtime the repo already declares; they never add one. (An explicit range used to add a missing
   entry, which grew an unwanted node entry in a bun-only repo.)
3. **`auto` mode:** if the entry is a static pin (`isStaticVersion`), skip. Otherwise the existing
   version string is the target range.
4. **Explicit range mode:** the user-typed value is the target range. It only selects *which line
   to resolve* — it never changes what shape is written.
5. Call `resolver.resolve({ range: targetRange })` and get `.latest`. On any error
   (`VersionNotFoundError` or network failure), log a warning and skip.
6. If `latest` equals the current version, skip (already current).
7. Assign `entry.version = latest` — the **bare, exact** resolved version, no operator re-attached.
   `findRuntimeEntry` returns the live object inside `devEngines`, so this rewrites the manifest in
   place and preserves the entry's other keys and the surrounding shape.
8. After processing all runtimes, write back `package.json` (preserving indentation via
   `detectIndent`) only if at least one update succeeded.

**Shape handling:**

- Existing array entry: version updated in place, all other fields preserved, array shape kept.
- Existing single-object entry: version updated in place, object shape kept.
- No entry (array missing the runtime, single object naming another runtime, absent
  `devEngines.runtime`, absent `devEngines`): skipped with a warning — nothing is ever added or
  promoted.

**Why exact:** `silk-runtime-action`, which consumes `devEngines.runtime` in the next pipeline
step, does not support range operators, so any operator written here is a latent downstream
failure. The range is a *resolution* input only.

**EOL note:** `@effected/runtimes`' bundled snapshot and live API both exclude end-of-life major lines.
A resolution targeting an EOL line returns `VersionNotFoundError` and is skipped with a warning.
This means `auto` on a `^20`-ranged entry (once Node 20 is EOL) will no-op.

### src/services/report.ts - Report

PR management and report generation. Depends on `PullRequest` library
service. Uses `GithubMarkdown` from the library to assemble PR bodies and
summaries.

**Service interface:**

```typescript
export class Report extends Context.Service<Report, {
 readonly createOrUpdatePR: (branch, base, updates, changesets, autoMerge?) =>
  Effect.Effect<PullRequestResult, PullRequestError>;
 readonly generatePRBody: (updates, changesets) => string;
 readonly generateSummary: (updates, changesets, pr, dryRun) => string;
 readonly generateCommitMessage: (updates, appSlug?) => string;
}>()("Report") {}
```

`base` is the resolved `target-branch` (the PR merge target), threaded in from
`program.ts`. PR creation failures propagate through the Effect error channel as
`PullRequestError` rather than returning a sentinel result.

Both the PR title (`createOrUpdatePR`) and the commit subject (the first line of `generateCommitMessage`) are derived from the run's contents via `buildUpdateSubject(updates)` (`src/utils/commit-subject.ts`) — no static `chore(deps): …` constant. `generateCommitMessage`'s body bullets and `Signed-off-by` footer are unchanged.

## Layer Composition (src/layers/app.ts)

`makeAppLayer(dryRun, { runtimeLive })` wires all library and domain layers.
`dryRun` controls the `DryRun` service; `runtimeLive` (default: `false`) selects
how the `NodeResolver`, `DenoResolver` and `BunResolver` services consumed by
`RuntimeUpgradeLive` are built (see `makeRuntimeResolvers` in `src/layers/app.ts`):
the offline path uses each resolver's `*.layerOffline` (bundled snapshot, no
network or auth), the live path uses `*.layer` over an HTTP client /
`@effected/runtimes`' `GitHubClient.layerDefault` (which pre-wires auth +
`FetchHttpClient`) and falls back to the bundled snapshot on any fetch failure.
The `GitHubClient` layer used by the rest of the action is built from
`GitHubToken.client()`, which reads the installation-token envelope the pre phase
persisted to `ActionState` — there is no bare `GitHubClientLive` and no
`process.env.GITHUB_TOKEN` bridge. `ActionState` is provided locally (backed by
`NodeServices.layer`'s FileSystem) so the layer is self-contained, and
`Layer.orDie` turns a missing/unreadable token into a fatal defect, keeping the
resulting `githubClient` at `R = never` for the `withCheckRun` callback. In
Effect v4 the workspace layers are **root-bound at build** (static `.layer` /
`.layer()` factories on the classes) and `NodeServices.layer` (from
`@effect/platform-node`) is the platform bundle (replacing `NodeContext.layer`).

```typescript
import { NodeServices } from "@effect/platform-node";
import { BunResolver, DenoResolver, NodeResolver } from "@effected/runtimes";
import { WorkspaceDiscovery, WorkspaceRoot } from "@effected/workspaces";
import { FetchHttpClient } from "effect/unstable/http";

export const makeAppLayer = (
 dryRun: boolean,
 options: { runtimeLive: boolean } = { runtimeLive: false },
) => {
 const actionState = ActionStateLive.pipe(Layer.provide(NodeServices.layer));
 const githubClient = GitHubToken.client().pipe(Layer.provide(actionState), Layer.orDie);

 const ghGraphql = GitHubGraphQLLive.pipe(Layer.provide(githubClient));
 const npmRegistry = NpmRegistryLive.pipe(Layer.provide(CommandRunnerLive));
 // Effective pnpm minimumReleaseAge gate, applied by ConfigDeps/RegularDeps
 // before version resolution. Inert when the workspace declares no gate.
 const releaseAge = ReleaseAgeLive().pipe(Layer.provide(CommandRunnerLive));
 const gitBranch = GitBranchLive.pipe(Layer.provide(githubClient));
 const gitCommit = GitCommitLive.pipe(Layer.provide(githubClient));
 const prLayer = PullRequestLive.pipe(Layer.provide(Layer.merge(githubClient, ghGraphql)));

 // Platform bundle (FileSystem, Path, …) for @effected/workspaces. The
 // workspace root is bound when the layer is built.
 const platform = NodeServices.layer;
 const workspaceRoot = WorkspaceRoot.layer.pipe(Layer.provide(platform));
 const workspaceDiscovery = WorkspaceDiscovery.layer().pipe(
  Layer.provide(Layer.merge(workspaceRoot, platform)),
 );

 // DepsRegen (silk-effects) is the source of truth for dependency changesets.
 // DepsRegenDefault is batteries-included — it bundles the point-in-time
 // workspace reader, ConfigInspector, WorkspaceDiscovery, the adaptive
 // PublishabilityDetector and ChangesetConfig internally, so it needs only
 // platform services (FileSystem/Path/CommandExecutor from NodeServices.layer).
 const depsRegen = SilkChangesets.DepsRegenDefault.pipe(Layer.provide(platform));

 const libraryLayers = Layer.mergeAll(
  githubClient, gitBranch, gitCommit,
  CheckRunLive.pipe(Layer.provide(githubClient)),
  prLayer, npmRegistry, CommandRunnerLive, DryRunLive(dryRun),
  FetchHttpClient.layer,
 );

 // NodeResolver/DenoResolver/BunResolver, built offline (*.layerOffline) or
 // live (*.layer over fetchers + GitHubClient.layerDefault). See
 // makeRuntimeResolvers for the live wiring.
 const runtimeResolvers = makeRuntimeResolvers(options.runtimeLive);

 const domainLayers = Layer.mergeAll(
  workspaceRoot,
  workspaceDiscovery,
  ChangesetsLive.pipe(Layer.provide(depsRegen)),
  BranchManagerLive.pipe(Layer.provide(Layer.mergeAll(gitBranch, gitCommit, CommandRunnerLive))),
  PnpmUpgradeLive.pipe(Layer.provide(npmRegistry)),
  ConfigDepsLive.pipe(Layer.provide(Layer.merge(npmRegistry, releaseAge))),
  RegularDepsLive.pipe(Layer.provide(Layer.mergeAll(npmRegistry, workspaceDiscovery, releaseAge))),
  ReportLive.pipe(Layer.provide(prLayer)),
  RuntimeUpgradeLive.pipe(Layer.provide(runtimeResolvers)),
 );

 return Layer.provideMerge(domainLayers, libraryLayers);
};
```

> Note: the actual `src/layers/app.ts` also wires `PackageManagerDetector.layer`
> and `LockfileReader.layer()` from `@effected/workspaces` plus the
> `CatalogConfigDeps` / `PackageManagerUpgrade` domain layers for multi-package-manager
> (pnpm/bun/npm) support. Those predate the Effect-v4 migration and are elided
> here to keep this composition example at the same abstraction as the rest of
> this section.

`WorkspaceDiscovery.layer()` and `WorkspaceRoot.layer` come from
`@effected/workspaces`; `NodeServices.layer` (from `@effect/platform-node`)
satisfies their FileSystem/Path requirements. The action still wires
`workspaceDiscovery` directly for `RegularDeps` — the changeset step no longer
consumes it, since `DepsRegenDefault` bundles its own discovery internally.

`Changesets.DepsRegenDefault` (from `@savvy-web/silk-effects`) is
FileSystem-based — it reads `.changeset/config.json`, package manifests and the
git worktree via core `effect`'s FileSystem/CommandExecutor rather than
`node:fs`, so `makeAppLayer` provides the same `platform` (`NodeServices.layer`)
and nothing else. The former hand-wired `changesetConfig` / `publishabilityDetector`
locals are gone.

## Pure Helpers (src/utils/)

### src/utils/branch.ts

- `resolveTargetBranch(rawTarget, source)` — Resolve the PR target branch. An empty (whitespace-only) `target-branch` input is the sentinel for "follow source-branch" (GitHub Actions input defaults cannot reference another input), so the fallback to `source` is resolved here in code.

### src/utils/commit-subject.ts

- `buildUpdateSubject(updates)` — Derive the full conventional PR title / commit subject (`chore(deps): …`) from the run's `DependencyUpdateResult[]`. First-match-wins over four buckets (pnpm self-upgrade, runtimes, config deps, regular deps): names a single change, summarizes runtime-only or config-only batches, scopes a single-workspace dependency batch and composes mixed runs. The regular-deps bucket is broken down by package.json section (dependencies / devDependencies / peerDependencies / optionalDependencies), counting distinct names per section in production-first order with field-name nouns (`update 1 config dependency and 4 devDependencies`); the elliptical coarse form (`update N config and M dependencies`) is kept when the regular deps are all plain `dependencies`, and the single-workspace variant gets the typed noun when the batch is one section (`update devDependencies in @scope/pkg`, mixed batches keep `update dependencies in <ws>`). The 72-char header budget is a progressive degradation ladder: typed breakdown → coarse phrasing → generic `chore(deps): update dependencies` fallback. Versions are shown clean (range operator and `+sha512` suffix stripped); runtime names are capitalized, pnpm stays lowercase. Consumed by `Report` for both the PR title and the commit subject.

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
- `corepackHashFromIntegrity(integrity)` - Convert an npm registry integrity (`sha512-<base64>`) to corepack's `packageManager` hash form (`sha512.<hex>`) — the exact string `corepack use` would write. Tolerates a JSON-quoted value; returns `null` when the value is missing or not a sha512 integrity.

### src/utils/runtime.ts

Pure helpers for reading and rewriting `devEngines.runtime` entries. No Effect
service dependencies — mirrors `src/utils/pnpm.ts`.

- `isStaticVersion(raw)` — True when `raw` is a static exact version (`X.Y.Z`, optionally with
  prerelease/build) and carries no range operator, wildcard (`x`/`*`), OR-set (`||`), or partial
  form. Used to make `auto` a no-op on pinned versions.
- `findRuntimeEntry(devEngines, runtime)` — Find the `devEngines.runtime` entry for `runtime`
  (accepts object or array shape), or `null` if absent. The entry returned is the **live object**
  inside `devEngines`, so assigning to its `version` rewrites the manifest in place — which is how
  `RuntimeUpgrade` writes, preserving both the array and single-object shapes.

There is no upsert/promote helper and no operator helper: the action never adds a runtime entry,
and always writes a bare exact version (`parseRuntimeOperator`, `redecorateVersion` and
`upsertRuntimeEntry` were removed with those behaviors).

### src/utils/semver.ts

- `resolveLatestSatisfying(versions, range)` - Find the highest stable version satisfying an arbitrary semver range (e.g. `^11`, `>=11`). Used by `RegularDeps` (current specifier as range) and `ConfigDeps` (synthesized range).
- `resolutionRangeForSpecifier(prefix, version)` - Decide the range `RegularDeps` resolves a specifier within: the config-dep range (`configDepUpgradeRange(version)`) for caret-on-zero (`^0.y.z`), the literal `prefix+version` otherwise. Falls back to the literal specifier when no numeric major is present.
- `resolveLatestInRange(versions, current)` - Find highest stable version satisfying `^current` (delegates to `resolveLatestSatisfying`).
- `configDepUpgradeRange(version)` - Synthesize a conservative upgrade range from a hash-pinned config-dep version's major: `>=version <(major+1).0.0` for `>=1.0.0`, `>=version <2.0.0` for `<1.0.0`. Returns `null` for a version with no numeric major. Used by `ConfigDeps`, which has no declared range to read.
