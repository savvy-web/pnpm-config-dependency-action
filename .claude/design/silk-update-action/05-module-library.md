---
status: current
module: silk-update-action
category: architecture
created: 2026-02-20
updated: 2026-08-05
last-synced: 2026-08-05
completeness: 95
related:
  - ./_index.md
dependencies: []
implementation-plans: []
---

# Services and Utilities

[Back to index](./_index.md)

**Scope note.** This document covers the *reusable* layer: domain services
(`src/services/`), layer composition (`src/layers/app.ts`), the rendering surface
(`src/format.ts`) and the pure helpers (`src/utils/`). The **orchestration**
layer — `src/steps/`, one module per workflow unit — is documented in
@./04-module-entry-points.md alongside the composition that calls it. The split
follows the code: a service is a capability, a step is a decision about when to
use one.

## Domain Services (src/services/)

All domain logic is wrapped as Effect services with `Context.Service` + `Layer`,
or (for stateless concerns) exported as standalone helper functions. Each service
depends on kit services from `@effected/*` and/or `@savvy-web/silk-effects`. The
service form is
`class Foo extends Context.Service<Foo, Shape>()("Foo") {}`; where a service value
needs typing without being yielded, the kit exposes a companion `*Shape`
interface (e.g. `NpmRegistryShape`, `WorkspaceDiscoveryShape`, `GitBranchShape`,
`PullRequestShape`).

### Workspace discovery (via @effected/workspaces)

Domain services consume `WorkspaceDiscovery` directly, via its **arg-less**
`listPackages()` and `importerMap()` methods — the workspace root is bound when
`WorkspaceDiscovery.layer(opts?)` is built. `importerMap` is keyed by importer
path relative to the root (`.` for the root workspace), used by `Lockfile.compare`
to translate importer ids into package names.

**Caching:** `WorkspaceDiscovery` caches `listPackages` per root for the layer
lifetime, and Effect memoizes layers by object reference, so every consumer wired
from the same layer shares one instance — an enumeration cached before
`ConfigDeps`/`RegularDeps` edit manifests stays stale for later readers unless
refreshed. DepsRegen refreshes at plan time (see `Changesets` below), so the
changeset step is not bitten by this.

### src/services/package-manager.ts - detectPackageManager

Resolves the workspace root and package manager **once per run**; every dispatch
point in `innerProgram` reads that one value. Standalone function, no service tag.

```typescript
export const detectPackageManager = (
 cwd?: string,
) => Effect.Effect<DetectedPm, InvalidInputError, PackageManagerDetector | WorkspaceRoot>;
```

- Delegates to `@effected/workspaces`' `PackageManagerDetector`, which is also what
  `LockfileReader` and `PointInTimeWorkspace` consult internally — so the manager
  the action dispatches on is always the one those libraries parse for.
- **Yarn is rejected** with `InvalidInputError`: it is detected upstream, but
  nothing in the config-dep, install or upgrade paths is wired or tested for it.
- `WorkspaceRootNotFoundError` and `PackageManagerDetectionError` share the same
  `reason` / `searchPath` shape and are mapped to `InvalidInputError` through one
  handler. The kit has no `ActionInputError` successor, and this is not an
  input-parse failure anyway — the workspace on disk is the thing being rejected.

### src/services/branch.ts - BranchManager

Branch management and commit operations over `GitBranch` / `GitCommit` (from
`@effected/github`) for the API half, `@effected/git`'s `Git.status` for reading
the working tree, and `@effected/commands`' `Run` for the remaining local git
commands.

**Two subprocess mechanisms for git live in this one module, deliberately.** That
is the outcome the earlier "decline `@effected/git`" ruling was trying to avoid,
and it was accepted anyway — see the settled-decisions note in
@./09-project-status.md for why deleting a parser that had shipped three silent
wrong answers outweighs mechanism uniformity.

```typescript
export class BranchManager extends Context.Service<BranchManager, {
 readonly manage: (branchName: string, defaultBranch?: string) =>
  Effect.Effect<BranchResult, GitHubError | GitRunError, Repo>;
 readonly commitChanges: (message: string, branchName: string, workspaceRoot: string) =>
  Effect.Effect<void, GitHubError | GitRunError | GitServiceError, Repo>;
 readonly validateBranches: (source: string, target: string) =>
  Effect.Effect<void, GitHubError | InvalidInputError, Repo>;
 readonly ensureBaseHistory: (base: string, workspaceRoot: string) =>
  Effect.Effect<void, GitRunError>;
}>()("BranchManager") {
 // `static readonly layer`, declared IN the class body — see the layer note below.
}
```

**Both git-touching methods take the workspace root explicitly.** `commitChanges`
has for a while; `ensureBaseHistory` gained it in `6d101bc`. Neither defaults to
`process.cwd()`, because the action can be invoked from a subdirectory of the
workspace and git resolves everything — `--porcelain` paths, `merge-base`, the
recovery fetches — relative to the directory it actually ran in.

**`Repo` stays in `R`, deliberately.** The layer resolves the `ChildProcessSpawner`
once (ambient infrastructure) but does **not** resolve `Repo` — keeping it in each
method's requirements is what makes `Repo.provide(ref)` meaningful for a caller
targeting a different repository.

**Branch strategy — `GitBranch.upsert`.** `manage` reads the source branch SHA via
the API and calls `upsert(branchName, baseSha)`, which creates the branch when
absent and force-resets it when present, reporting which happened. This replaced
the exists/delete/create dance: same net effect, without racing anything that
reads the ref in between.

**Pre-flight validation.** `validateBranches(source, target)` checks both refs and
fails fast with `InvalidInputError` (`field` = `"source-branch"` /
`"target-branch"`); the target check is skipped when `target === source`.
`innerProgram` calls it before `manage`, so a typo'd ref aborts before the reset.

**Commit via GitHub API.** `commitChanges` reads changed files from
`git -c core.fileMode=false status --porcelain` and calls
`GitCommit.commitFiles({ branch, message, changes })` — one call that creates the
tree, the commit (without an explicit author, so GitHub verifies it) and updates
the ref. The kit models changes as tagged members: `FileDeletion.make({ path })`
and `FileContent.make({ path, content })`, replacing the old `{ path, sha: null }`
sentinel. Afterwards the working tree is synced with `git fetch origin <branch>` +
`git reset --hard origin/<branch>`, because `git checkout` refuses to overwrite the
just-committed working-copy state.

- `core.fileMode=false` is load-bearing: executable-bit-only flips (e.g. husky
  chmod-ing hooks during a `run` command) do not survive a content-based API
  commit at mode 100644, so counting them would create an empty commit and a
  spurious PR. **It is no longer a per-command flag**: `steps/configure-status.ts`
  writes it into the checkout's own git config once per run, before any status
  read. Two readers depend on it — this one and `steps/detect-changes.ts` — and
  one config write is a thing a reviewer can check, whereas two call sites
  carrying the same flag is a thing that drifts.
- **The status read goes through `Git.status(cwd)`**, which returns typed
  `StatusEntry` values rather than porcelain text. The local `gitRawIn` helper and
  the `Run.collect`-not-`Run.text` reasoning it existed for are **gone**: they
  were about reading column-aligned text safely, and this module no longer reads
  text. (`Run.text` still trims; that is now a fact about `@effected/commands`,
  not a constraint on this module.)
- **`parseStatusLine` is deleted.** The format is `XY PATH`, or `XY ORIG -> PATH`
  for a rename or copy, and **both** status columns are significant — which the
  original parser got wrong twice, reading `substring(3)` as the whole path and
  testing `substring(0, 2).trim() === "D"`. That produced two silent data-loss
  bugs: a rename yielded the unreadable path `"old.ts -> new.ts"`, so the file
  never reached the commit at all; and a deletion whose columns disagreed (`AD`,
  `RD`) was treated as a modification and dropped the same way.
  - `StatusEntry` models `x`, `y` and `origPath` separately, so **both defects
    become unrepresentable** rather than merely fixed. The mapping onto commit
    members stays here and is still tested: a rename emits a `FileDeletion` for
    the origin plus a `FileContent` at the destination — the commit is an
    explicit change set, not a diff, so a tree that only adds the new path leaves
    the old one behind — while a **copy** carries an origin that must *not* be
    deleted, which is why the two are distinguished rather than both treated as
    "has an origPath".
  - Quoting and git's octal `\NNN` form for non-ASCII bytes are the kit's
    problem now, not this repo's; `Git.status` reads `--porcelain -z`, which
    sidesteps the quoting layer entirely.

**Base-history preflight.** `ensureBaseHistory(base, workspaceRoot)` probes
`git merge-base <base> HEAD` (via `Run.succeeds`); if it resolves — the
`fetch-depth: 0` case — it is a no-op. Otherwise it best-effort fetches the base
ref, unshallows a shallow clone, materializes a local ref, and warns non-fatally
if the merge-base is still missing. Required because DepsRegen diffs
`merge-base(base) → worktree`.

Every command in it runs at `workspaceRoot` via a `gitRunIn(cwd, …)` helper.
Until `6d101bc` they ran at `process.cwd()`, which was **a silent wrong answer
rather than an error**: invoked from a subdirectory, the merge-base probe and
its recovery fetches resolved against the wrong directory, the preflight
concluded there was nothing to do, and the changeset step then diffed against a
base it could not see. Nothing failed — there were simply no changesets, which
looks identical to "no versionable changes." That is the same defect class as
the `commitChanges` cwd bug fixed earlier in the branch, and it had been
recorded here as a deferred fix before it was applied.

### src/services/workspace-yaml.ts - WorkspaceYaml

Format `pnpm-workspace.yaml` consistently to avoid lint-staged hook churn.

**Formatting rules:** sort `packages` / `onlyBuiltDependencies` /
`publicHoistPattern` arrays, sort `configDependencies` keys, sort top-level keys
alphabetically but keep `packages` first, and stringify with `indent: 2`,
`lineWidth: 0`, `singleQuote: false`.

**Exported helpers:** `formatWorkspaceYaml(workspaceRoot?)`,
`readWorkspaceYaml(workspaceRoot?)`, `sortContent(content)` and
`STRINGIFY_OPTIONS`. Parsing/stringifying goes through `@effected/yaml`, whose
`Yaml.parse` / `Yaml.stringify` return Effects, mapped into `FileSystemError`.

**There is no `WorkspaceYaml` tag or layer — both were deleted**, and the reason
generalizes. They were a pure pass-through to the same `*Impl` functions the
standalone helpers call, and **nothing in `src/` ever wired them**: the only code
that resolved the tag was this module's own test suite, so those tests passed
precisely because they were the sole callers. That is the same argument that
removed four unconstructed error classes from `errors/errors.ts`, and renaming
the layer to the kit's `static layer` convention would only have produced tidier
dead code. The suite now drives the standalone helpers, which is what
`ConfigDeps`, `ReleaseAge` and the config-dependency step actually call — so it
exercises the production path rather than a parallel one.

### src/services/package-manager-upgrade.ts - PackageManagerUpgrade

Self-upgrade of the **detected** package manager. Generalizes the former
pnpm-only `PnpmUpgrade` to every `SupportedPm`: all three are published on npm, so
the registry lookup and range logic are identical; only the write format differs.
Depends on `NpmRegistry` (an HTTP client — no `npm view` subprocess, so the
root-owned `~/.npm` EACCES class of failure on macOS runners is gone by
construction).

```typescript
export class PackageManagerUpgrade extends Context.Service<PackageManagerUpgrade, {
 readonly upgrade: (mode: string, pm: SupportedPm, workspaceRoot?: string) =>
  Effect.Effect<PackageManagerUpgradeOutcome, FileSystemError>;
}>()("PackageManagerUpgrade") {}
```

**Algorithm:**

1. Read root `package.json`; parse the `packageManager` field and the
   `devEngines.packageManager` entry. An entry naming a *different* manager than
   the one being upgraded is not a reference for this run and is ignored.
2. Pick a reference version favoring `devEngines.packageManager`.
3. Choose the target range: `true`/`auto` → `^reference` (latest within the
   current major); an explicit range is used verbatim and may cross majors.
4. Resolve via `NpmRegistry.versions(pm)` + `resolveLatestSatisfying`.
5. Write. **corepack-managed managers (pnpm, npm)** get a pinned
   `version+sha512.<hex>` (derived from the registry integrity via
   `corepackHashFromIntegrity`) in both `packageManager` and
   `devEngines.packageManager.version` — no `corepack use` is invoked, because it
   errors when both fields are present; the subsequent install performs the
   corepack switch. **bun is not corepack-managed** — it never consults
   `packageManager` — so it is written as a bare `bun@<version>` and the integrity
   fetch is skipped entirely.

**`upgrade()` never returns `null`.** It always resolves to a
`PackageManagerUpgradeOutcome` (see @./03-type-definitions.md) so the caller can
report *why* nothing happened. `disabled`, `no-reference` and `already-current`
are benign and log at info; **`unsatisfiable` logs at warning**, because it almost
always means the configured range was typed for a different package manager than
the one detected (a pnpm `^11.0.0` copy-pasted into a bun repo resolves against
bun's release list and, correctly, satisfies nothing). That must not read as
"already up to date".

### src/services/release-age.ts - ReleaseAge

Mirror pnpm's `minimumReleaseAge` / `minimumReleaseAgeExclude` gate at resolution
time so `ConfigDeps` and `RegularDeps` never propose a version pnpm would reject
at install (`ERR_PNPM_NO_MATURE_MATCHING_VERSION`). The gate vocabulary
(`ReleaseAgeGate`, `PartialReleaseAgeGate`) lives upstream in `@effected/npm`;
this module owns discovery and the service wiring.

```typescript
export class ReleaseAge extends Context.Service<ReleaseAge, {
 readonly gate: () => Effect.Effect<ReleaseAgeGate>;
 readonly filterVersions: (pkg: string, versions: ReadonlyArray<string>) =>
  Effect.Effect<ReadonlyArray<string>>;
}>()("ReleaseAge") {}
```

**Gate discovery belongs to `@effected/workspaces`.**
`WorkspaceCatalogs.releaseAgeGate()` combines the inline `pnpm-workspace.yaml`
keys with the replayed config-dependency `pnpmfile` hooks, strictest-wins, off
the same single read it uses for the catalog set. This module no longer reads
the workspace at all — `readInlineReleaseAge`, `replayHookReleaseAge`,
`REPLAY_SCRIPT`, `REPLAY_SENTINEL` and `extractReplayPayload` are **deleted**
(304 → 176 lines).

The layer must be **`layerWithConfigDependenciesSubprocess`**, not
`layerWithConfigDependencies`: the in-process variant loads each pnpmfile with a
computed dynamic `import()`, which rspack compiles into a context module and
breaks in the bundled `dist` (see @./01-dependencies.md). The subprocess variant
passes a static script via argv, so nothing computed enters the bundle graph —
which is precisely what blocked this adoption until `@effected/workspaces@0.10.0`.

**What stays local is the fail-open posture, and that is now the whole point of
the wrapper.** The kit fails **typed** (`CatalogAssemblyFailure` =
`CatalogAssemblyError | WorkspaceRootNotFoundError`), which is the right contract
for a library. This action instead degrades to "no gate" with a warning, because
pnpm re-enforces the gate at install, so missing data lands on exactly the
pre-gate behavior — whereas aborting a dependency-update run over one broken
plugin would be strictly worse. That `Effect.catch` lives at the single call site
in `ReleaseAge.layer`.

`release-age.int.test.ts` pins **both halves** of that split: that the kit's own
surface fails typed on a throwing pnpmfile, *and* that `ReleaseAge.layer` turns
that into the inert gate. Asserting only the outcome would still pass if someone
deleted the wrapper.

### Two bounds the subprocess layer imposes, and one known gap

`layerSubprocess` documents two bounds `layerLive` cannot have: the replay gets
**30 seconds** (a pnpmfile that loops fails typed rather than hanging the
memoized assemble pass — a subprocess is killable, an in-process synchronous
hook call is not), and the child's stdout is captured under `Run.jsonLine`'s
**16 MiB** ceiling, above which it fails typed as `tooLarge`.

**Known gap, verified here rather than assumed** (upstream
[spencerbeggs/effected#292](https://github.com/spencerbeggs/effected/issues/292))**:**
`Run.jsonLine` reads the
**last non-empty line** of stdout, so a hook that writes *after* the payload —
`process.on("exit", () => console.log(…))`, i.e. cleanup logging — makes the
parse fail, and our fail-open wrapper then degrades it to no gate. A hook that
logs *during* execution, which is the ordinary case and the one the shipped #9
bug was about, survives fine.

The evidence is a controlled pair in `release-age.int.test.ts`: the same fixture
helper, two hooks differing only in *when* they log. The deleted local
implementation handled both, because scanning from the end for a sentinel beats
last-line parsing exactly here. Reported upstream; the trade was accepted because
the ordinary case works and the alternative was keeping ~125 lines for one edge.

**Publish times** come from `NpmRegistry.publishTimes(pkg)` — the kit absorbed
this repo's former hand-rolled `npm view <pkg> time --json` shell-out —
normalized to a `version → ISO-8601` record via `getPublishTimes`.

**Filtering** is the identity when the gate is inert (`ageMinutes <= 0`), the
package is excluded (`gate.isExcluded`, pnpm's flat-string `*` matcher, not
minimatch), or publish times are unavailable. Otherwise the upstream pure
`gate.filterVersions` drops versions younger than the cutoff. The whole path
**fails open**: the worst case of missing data is exactly the pre-gate behavior,
and pnpm still enforces the gate at install.

**Layers:** `ReleaseAge.layer` — a `static readonly layer` on the class, not a
`ReleaseAgeLive()` factory, and **no longer parameterized by a workspace root**:
the root is bound when `WorkspaceCatalogs`' layer is built, so a root parameter
here could only be ignored. It requires `WorkspaceCatalogs` **and**
`NpmRegistry`; both are resolved once inside the layer so every member's `R` is
`never`, which is what keeps `filterVersions` callable from `ConfigDeps` /
`RegularDeps` without threading requirements. `ReleaseAge.layerNoop` is the inert
layer (zero gate, identity filtering) for unit tests and non-pnpm paths.

### src/services/config-deps.ts - ConfigDeps (pnpm)

Update pnpm config dependencies by querying npm and editing `pnpm-workspace.yaml`
in place (avoiding `pnpm add --config`, which promotes deps to the default catalog
under `catalogMode: strict`). Depends on `NpmRegistry` and `ReleaseAge`.

```typescript
export class ConfigDeps extends Context.Service<ConfigDeps, {
 readonly updateConfigDeps: (deps: ReadonlyArray<string>, workspaceRoot?: string) =>
  Effect.Effect<ReadonlyArray<DependencyUpdateResult>>;
}>()("ConfigDeps") {}
```

1. Read `pnpm-workspace.yaml` via `readWorkspaceYaml()`.
2. Per dep: parse the hash-pinned version, derive a conservative upgrade range
   from its major via `configDepUpgradeRange`, query `NpmRegistry.versions`, filter
   through `ReleaseAge.filterVersions`, then `resolveLatestSatisfying` — config
   deps carry no declared range, so it is synthesized rather than reading npm's
   absolute latest.
3. Skip if up-to-date; otherwise fetch the integrity for **that resolved version**.
4. Write back via `sortContent()` + `stringify()`.

The range keeps a `>=1.0.0` dep within its current major; a `<1.0.0` dep may
advance across `0.x` and adopt the first stable major but never crosses two majors.

### src/services/catalog-config-deps.ts - CatalogConfigDeps (bun)

Reproduce pnpm's config-dependency workflow for **bun**, which has no such
concept. The package named in `config-dependencies` is an ordinary dependency of
the root manifest, so this service fetches its module, reads its `catalogs`
export, and merges it into the manifest's own top-level `catalog` (default) and
`catalogs` (named) fields — siblings of `workspaces`, not nested inside it, which
is where bun reads them from. A nested `workspaces.catalog(s)` copy is still read
(a repo may have been written that way) and migrated to the top level on write.

```typescript
export class CatalogConfigDeps extends Context.Service<CatalogConfigDeps, {
 readonly update: (deps: ReadonlyArray<string>, workspaceRoot?: string) =>
  Effect.Effect<CatalogConfigDepsResult, FileSystemError>;
}>()("CatalogConfigDeps") {}
```

Requires `NpmRegistry`, `LockfileReader`, `HttpClient` and `ChildProcessSpawner`.
The layer captures its context once (`Effect.context<…>()`) and re-provides it, so
the method's `R` stays `never` without threading each service by hand.

**Why a three-way merge.** Because the merge is written to disk rather than
recomputed at each install, a later run cannot tell a deliberate user override
from an entry the action itself wrote. `threeWayMergeCatalogs(base, disk, next)`
separates them by diffing against the catalogs of the version that was **actually
installed** last run — which is what the lockfile records, hence the
`LockfileReader` dependency:

- Absent from the manifest → adopt what the new version ships (`added`).
- Diverged from what the previous version shipped → the user's; kept verbatim
  (`kept`). A `kept` delta therefore means exactly one thing: a user override or
  addition survived. An entry that is ours and simply did not move produces **no**
  delta, rather than a `kept` that would be indistinguishable from an override.
- Otherwise ours → follow the new version, including its removals (`updated` /
  `removed`).
- Only catalog names present in `base` or `next` are considered; a catalog no
  config dependency ships belongs to the consumer and is never touched.

When the base version's catalogs cannot be read (yanked/unpublished), it degrades
to `pluginWinsMerge`: `next` overwrites what it defines, disk-only keys survive,
nothing is removed — and the caller warns, because an override on a key the plugin
still ships is lost in that mode.

Nothing here is fatal except a manifest that cannot be read or written: a
per-dependency failure warns and skips that dependency.

### src/services/module-catalogs.ts - fetchModuleCatalogs

Reads a config dependency's `catalogs` export from its **published tarball**.
pnpm reads this out of the installed package, but this action's merge has to
happen *before* any install runs (its output feeds the manifest install then
reads). So `fetchModuleCatalogs` downloads the exact version being written,
extracts the tarball with `tar` (present on every runner image, so no new
dependency), and imports the extracted entry directly off disk — self-contained,
no `node_modules` required. Entry resolution follows `exports` (preferring
`import` over `default`, handling the conditions-vs-subpath distinction) and falls
back to `main`.

A standalone exported function, not a service — no state, one caller. Its
`import()` carries an inline `/* webpackIgnore: true */`; see the build note in
@./01-dependencies.md.

### src/services/regular-deps.ts - RegularDeps

Update regular dependencies by querying npm directly (avoiding `pnpm up --latest`,
which promotes deps to catalogs under `catalogMode: strict`). Depends on
`NpmRegistry`, `WorkspaceDiscovery` and `ReleaseAge`.

```typescript
export class RegularDeps extends Context.Service<RegularDeps, {
 readonly updateRegularDeps: (
  patterns: ReadonlyArray<string>,
  workspaceRoot?: string,
  exclude?: ReadonlySet<string>,
 ) => Effect.Effect<ReadonlyArray<DependencyUpdateResult>>;
}>()("RegularDeps") {}
```

**Key design decisions:**

- Resolves the highest published version **satisfying the current specifier
  treated as a range**, then re-applies the operator verbatim — never npm's
  absolute `latest`. `^4.0.0` stays within major 4, `~3.0.0` within the minor,
  `>=4.0.0` may cross a major, an exact pin never bumps. Caret-on-zero (`^0.y.z`)
  is the one exception, widened via `resolutionRangeForSpecifier` to the config-dep
  range (`>=version <2.0.0`) so a `^0.5.0` dep rolls forward across `0.x` and into
  the first stable `1.x`.
- Candidates pass through `ReleaseAge.filterVersions` between the registry query
  and resolution (fail-open).
- **`exclude`** is populated **only under bun**: `CatalogConfigDeps` owns the
  package.json range for a config dependency there and bumps it itself, so a
  `dependencies` glob matching the same name must not bump it a second time and
  race the same manifest write. Under pnpm the config deps live in
  `pnpm-workspace.yaml` and `ConfigDeps` never touches package.json; under npm they
  are skipped entirely — excluding them there would freeze the package.json range
  of a package that is both a config dependency and a devDependency, forever.
- Enumerates workspace manifests via `WorkspaceDiscovery`; glob matching via
  `matchesPattern`; skips `catalog:` and `workspace:` specifiers.
- Iterates `dependencies`, `devDependencies` and `optionalDependencies` via
  `DEP_SECTIONS`; `peerDependencies` are intentionally excluded (managed by
  `syncPeers`). Dedup is per `(path, field)`, so a dep declared in two sections of
  one package emits two records, each with the accurate `type`.
- A per-dependency registry failure yields an empty version list rather than
  aborting the batch.

### src/services/peer-sync.ts - PeerSync

Sync peerDependency ranges after devDependency updates, per the `peer-lock` /
`peer-minor` inputs. **No service tag** — standalone functions consumed directly
by `program.ts`. Yields `WorkspaceDiscovery` to resolve package paths and uses the
standalone `parseValidSemVer` from `@effected/semver`.

- `computePeerRange(params)` — compute the new range for a strategy.
- `syncPeers(config, devUpdates)` —
  `Effect<readonly DependencyUpdateResult[], FileSystemError, WorkspaceDiscovery>`.
  **No workspace root**, at either this level or `peerSyncStep`'s:
  `WorkspaceDiscovery` binds its root when the layer is built, so the parameter
  both used to take could only be ignored — and was, silently. A caller passing
  the wrong root saw no error and no effect, while a reader would reasonably
  conclude the root was honoured.
- `lock`: sync on every version bump. `minor`: sync only on minor+ bumps, flooring
  patch to `.0`.

### src/services/lockfile.ts - Lockfile

Compare lockfile snapshots before and after updates. Package-manager agnostic:
normalizes `pnpm-lock.yaml`, `bun.lock` and `package-lock.json` into one model via
`@effected/lockfiles`' pure `Lockfile.parse(content, { format })`.

```typescript
export class Lockfile extends Context.Service<Lockfile, {
 readonly capture: (pm: SupportedPm, workspaceRoot?: string) =>
  Effect.Effect<LockfileModel | null, LockfileError>;
 readonly compare: (before, after, workspaceRoot?) =>
  Effect.Effect<ReadonlyArray<LockfileChange>, LockfileError, WorkspaceDiscovery>;
}>()("Lockfile") {}
```

**`compareCatalogs`** walks every importer consuming a changed catalog entry and
emits **one `LockfileChange` per (catalog change, importer, dep section) triple**,
each carrying the precise `type`. `compareImporters` handles non-catalog specifier
changes (including removals), reading the section from the `after` snapshot.

**Exported helpers** used directly by `program.ts`: `LOCKFILE_NAMES` (the lockfile
each supported manager writes), `captureLockfileState(pm, workspaceRoot?)`,
`compareLockfiles(before, after, workspaceRoot?)` and
`groupChangesByPackage(changes)`.

### src/services/runtime-upgrade.ts - RuntimeUpgrade

Upgrade `devEngines.runtime` entries (node/deno/bun) in the root `package.json`
via `@effected/runtimes`' `NodeResolver` / `DenoResolver` / `BunResolver`. Resolver
failures are caught and skipped per-runtime, never fatal.

```typescript
export class RuntimeUpgrade extends Context.Service<RuntimeUpgrade, {
 readonly upgrade: (config: RuntimeUpgradeConfig, workspaceRoot?: string) =>
  Effect.Effect<readonly RuntimeUpgradeResult[], FileSystemError>;
}>()("RuntimeUpgrade") {}
```

**Per runtime:**

1. `"false"` → skip.
2. Look up the existing entry via `findRuntimeEntry`. **If none exists, skip with a
   warning** — in *every* mode. These inputs upgrade a runtime the repo already
   declares; they never add one. (An explicit range used to add a missing entry,
   which grew an unwanted node entry in a bun-only repo.)
3. `auto`: skip on a static pin (`isStaticVersion`); otherwise the existing version
   string is the target range.
4. Explicit range: the user-typed value is the target range — it only selects
   *which line to resolve*.
5. `resolver.resolve({ range })` → `.latest`; on any error (including
   `VersionNotFoundError` for an EOL line) warn and skip.
6. Skip if `latest` equals the current value.
7. Assign `entry.version = latest` — the **bare, exact** version, no operator
   re-attached. `findRuntimeEntry` returns the live object inside `devEngines`, so
   this rewrites in place, preserving the entry's other keys and the surrounding
   array/object shape.
8. Write back once, preserving indentation via `detectIndent`, only if at least one
   runtime updated.

**Why exact:** `silk-runtime-action`, the next pipeline step, does not support
range operators in `devEngines.runtime`, so any operator written here is a latent
downstream failure.

### src/services/changesets.ts - Changesets

A **thin adapter** over silk's `Changesets.DepsRegen`. Depends only on
`SilkChangesets.DepsRegen`.

```typescript
export class Changesets extends Context.Service<Changesets, {
 readonly create: (workspaceRoot: string, base: string) =>
  Effect.Effect<ReadonlyArray<ChangesetFile>, ChangesetError>;
}>()("Changesets") {}
```

`create(workspaceRoot, base)` calls `depsRegen.plan({ cwd: workspaceRoot, base })`
then `execute(plan)`, and maps `result.written` back to `ChangesetFile[]` for
reporting (reconstructing each `## Dependencies` table via
`SilkChangesets.serializeDependencyTableToMarkdown`). DepsRegen failures
(`GitError`, `WorkspaceDiscoveryError`, `ChangesetIOError`, `PointInTimeReadError`)
collapse into the local `ChangesetError`. `base` is the resolved `target-branch` —
the release baseline, which is what makes consolidation correct rather than
trimming.

**Behavior (all upstream in DepsRegen):** cumulative `merge-base(base) → worktree`
diff; one consolidated dependency changeset per in-scope package; stale
pure-dependency changesets deleted (idempotent across re-fires); devDependency rows
dropped; mixed changesets (table + prose) untouched; gating is silk
"versionable-minus-ignored"; specifiers resolve through the **importer-scoped**
`WorkspaceStateSnapshot.resolveIn`, so a `catalog:` specifier backed only by a
config-dependency pnpmfile hook still yields a concrete version per side; cell text
is literal (only `|` and `\` escaped); and `plan` refreshes workspace discovery
first, so the diff sees manifests edited earlier in the same run.

The adapter short-circuits with an empty result when no `.changeset/` directory
exists (`hasChangesets(workspaceRoot?)`, also exported for the skip messaging).

### src/services/report.ts - Report

PR management and report generation over the kit's `PullRequest` service, using
the kit's `GitHubMarkdown` writer (plus `bold` / `rule` from `utils/markdown.ts`,
the only two builders it does not ship).

```typescript
export class Report extends Context.Service<Report, {
 readonly createOrUpdatePR: (branch, base, updates, changesets, autoMerge?, deltas?) =>
  Effect.Effect<PullRequestResult, GitHubError, Repo>;
 readonly generatePRBody: (updates, changesets, deltas?) => string;
 readonly generateSummary: (updates, changesets, pr, dryRun, deltas?) => string;
 readonly generateCommitMessage: (updates, appSlug?) => string;
}>()("Report") {}
```

- `base` is the resolved `target-branch`. Creation/update goes through
  `PullRequest.upsert`.
- **Auto-merge is a separate call** in the kit (`setAutoMerge`, a GraphQL
  mutation) rather than a field on create. Its failure is deliberately swallowed
  to a warning: the repository may simply not have auto-merge enabled, and that
  must not fail a run whose PR was created successfully.
- `deltas` (the bun catalog deltas) are threaded into the PR body and summary — on
  a plugin bump that Catalog Changes table is the actual payload of the run.
- Both the PR title and the commit subject come from `buildUpdateSubject(updates)`
  (`src/utils/commit-subject.ts`) — there is no static `chore(deps): …` constant.

## Layer Composition (src/layers/app.ts)

`makeAppLayer(dryRun, { runtimeLive })` wires every kit and domain layer. The
whole function body is `/* v8 ignore */`-d as pure wiring, exercised indirectly.

**Every domain layer is a `static layer` on its service class** — `Report.layer`,
`Changesets.layer`, `ConfigDeps.layer` and the rest — matching the kit's own
convention. No `*Live` constant survives. Each is declared *in* the class body,
which is load-bearing: a member attached by post-class assignment is tree-shaken
out of the bundled `dist`, and that fails only in production because vitest runs
the source. The sketch below is illustrative, not a transcript — read
`src/layers/app.ts` for the current wiring.

```typescript
import { NodeServices } from "@effect/platform-node";
import { Git } from "@effected/git";
import { CheckRun, GitBranch, GitCommit, PullRequest, Repo } from "@effected/github";
import { DryRun, GitHubToken } from "@effected/github-actions";
import { NpmRegistry } from "@effected/npm";
import { BunResolver, DenoResolver, NodeResolver, GitHubClient as RuntimesGitHubClient } from "@effected/runtimes";
import { LockfileReader, PackageManagerDetector, WorkspaceDiscovery, WorkspaceRoot } from "@effected/workspaces";
import { Changesets as SilkChangesets } from "@savvy-web/silk-effects";
import { Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

export const makeAppLayer = (dryRun: boolean, options: { runtimeLive: boolean } = { runtimeLive: false }) => {
 // The token is provisioned in `pre` and persisted to ActionState.
 // clientLayer() reads it back. ActionState comes from ActionRuntime via
 // Action.run, so it is NOT rebuilt here. orDie makes a missing/expired token
 // a fatal defect, keeping R = never for the withCheckRun callback.
 const githubClient = GitHubToken.clientLayer().pipe(Layer.orDie);
 // Repo is required per call rather than captured, so it is a layer like any
 // other; GITHUB_REPOSITORY is read through the ambient ConfigProvider.
 const repo = Repo.layerFromConfig().pipe(Layer.orDie);

 // GraphQL is a member of GitHubClient in the kit — no separate service.
 const npmRegistry = NpmRegistry.layer.pipe(Layer.provide(FetchHttpClient.layer));
 // ReleaseAge.layer, not a factory: the root is bound by WorkspaceCatalogs.
 const releaseAge = ReleaseAge.layer.pipe(Layer.provide(Layer.merge(workspaceCatalogs, npmRegistry)));
 const gitBranch = GitBranch.layer.pipe(Layer.provide(githubClient));
 const gitCommit = GitCommit.layer.pipe(Layer.provide(githubClient));
 const prLayer = PullRequest.layer.pipe(Layer.provide(githubClient));

 // Platform layer: FileSystem, Path, ChildProcessSpawner.
 const platform = NodeServices.layer;
 const workspaceRoot = WorkspaceRoot.layer.pipe(Layer.provide(platform));
 const workspaceDiscovery = WorkspaceDiscovery.layer().pipe(Layer.provide(Layer.merge(workspaceRoot, platform)));
 const packageManagerDetector = PackageManagerDetector.layer.pipe(Layer.provide(platform));
 // The lockfile records which config-dependency version is actually installed —
 // the merge base for CatalogConfigDeps' three-way catalog merge.
 const lockfileReader = LockfileReader.layer().pipe(
  Layer.provide(Layer.mergeAll(workspaceRoot, packageManagerDetector, workspaceDiscovery, platform)),
 );

 const depsRegen = SilkChangesets.DepsRegenDefault.pipe(Layer.provide(platform));

 const libraryLayers = Layer.mergeAll(
  githubClient, repo, gitBranch, gitCommit,
  CheckRun.layer.pipe(Layer.provide(githubClient)),
  prLayer, npmRegistry,
  NodeServices.layer,
  // Read-mostly: status for the change verdict and commit file list, configSet
  // once for the core.fileMode pin. History still moves through the API.
  Git.layer,
  DryRun.layerFrom(dryRun),
  FetchHttpClient.layer,
 );

 const domainLayers = Layer.mergeAll(
  workspaceRoot, workspaceDiscovery, packageManagerDetector,
  Changesets.layer.pipe(Layer.provide(depsRegen)),
  BranchManager.layer.pipe(Layer.provide(Layer.mergeAll(gitBranch, gitCommit, Git.layer))),
  PackageManagerUpgrade.layer.pipe(Layer.provide(npmRegistry)),
  ConfigDeps.layer.pipe(Layer.provide(Layer.merge(npmRegistry, releaseAge))),
  CatalogConfigDeps.layer.pipe(
   Layer.provide(Layer.mergeAll(npmRegistry, lockfileReader, FetchHttpClient.layer, NodeServices.layer)),
  ),
  RegularDeps.layer.pipe(Layer.provide(Layer.mergeAll(npmRegistry, workspaceDiscovery, releaseAge))),
  Report.layer.pipe(Layer.provide(prLayer)),
  RuntimeUpgrade.layer.pipe(Layer.provide(makeRuntimeResolvers(options.runtimeLive))),
 );

 return Layer.provideMerge(domainLayers, libraryLayers);
};
```

`makeRuntimeResolvers(live)` returns either the three `*Resolver.layerOffline`
layers (bundled snapshot, no IO, no requirements) or the live `*.layer` layers —
`NodeResolver` over `FetchHttpClient.layer` (nodejs.org, unauthenticated) and
Deno/Bun over `@effected/runtimes`' `GitHubClient.layerDefault`, which pre-wires
auth + `FetchHttpClient` so the live graph is self-contained (`E = never`). Each
live resolver falls back to the bundled snapshot on a fetch failure, logging a
warning.

## The Rendering Surface (src/format.ts)

Every human-readable string the run produces that is not a step's own inline skip
reason is built in `src/format.ts`. It is **pure and service-free** — every
function takes data and returns a string (or an array of them), so every line is
testable without a runtime.

| export | purpose |
| --- | --- |
| `runContextLines(context)` | the opening Run-context block, header included |
| `resultLines(result)` | the closing Result block, including the skipped-summary |
| `groupCatalogDeltas(deltas)` | per-catalog tally of a merge's delta actions |
| `formatCatalogCounts(counts)` | verbose tally, for the config-dependencies step log |
| `formatCatalogCountsCompact(counts)` | compact `+/~/-` tally, for the Result block |
| `INSTALL_LABEL` | the command line each package manager's install runs, for logging |
| `describePmEvidence(detected)` | best-effort re-derivation of the detection signal |

The rule the module exists to enforce is that **the same fact must not be worded
two different ways in two different places.** `formatCatalogCounts` and
`formatCatalogCountsCompact` are the same tally rendered for two audiences, and
they sit side by side precisely so that stays visible.

Both block builders **return lines rather than logging**, so the module stays
pure and the caller emits them in order. The Run-context block includes its own
`"Run context"` header for the same reason a commit is an explicit change set:
the block is emitted as one unit and cannot drift apart.

`describePmEvidence` is explicitly **not a source of truth** and says so in its
own doc comment. `DetectedPm` does not carry the detector's reasoning — upstream
logs it internally at debug level, on one branch only, and does not return it —
so this is a cheap re-check of the same signals in the same priority order, for
one log line. Any read failure degrades to `null`; it never invents an answer.

### The boundary with `services/report.ts` — settled

**`format.ts` renders the run's log output; `report.ts` renders the PR's.** Two
named rendering modules, split by sink:

| | `format.ts` | `services/report.ts` |
| --- | --- | --- |
| sink | the runner log / decision record | the PR body, job summary, commit message |
| lifetime | written once, scrolls | upserted and re-rendered across runs |
| shape | pure functions, no services | a `Context.Service` over `PullRequest` |

The single-rendering-surface rule exists to stop rendering being scattered
through step bodies — which it is not. Merging the two would drag a service
dependency into a pure module, or strand `Report`'s statics. Two named modules
with a clear split satisfies the rule rather than violating it. See the
settled-decisions section of @./09-project-status.md.

**On authority over exact wording:** `program.inner.test.ts` asserts on the
literal log text and is authoritative over it; `format.test.ts` asserts the
*shape* of the decision record. That division matters — a wording change should
fail one suite, not both, and the one it fails should be the one that models the
log as a contract.

## Pure Helpers (src/utils/)

### src/utils/branch.ts

- `resolveTargetBranch(rawTarget, source)` — an empty (whitespace-only)
  `target-branch` is the sentinel for "follow source-branch" (Actions input
  defaults cannot reference another input), so the fallback is resolved in code.

### src/utils/catalogs.ts

Pure catalog-map helpers behind `CatalogConfigDeps`:

- `CatalogMap` — catalog name → (dependency → specifier).
- `normalizeCatalogs(value)` — coerce an arbitrary module export into a
  `CatalogMap`, or `null`.
- `readManifestCatalogs(pkgJson)` — read top-level `catalog` / `catalogs`, also
  picking up a nested `workspaces.catalog(s)` copy.
- `writeManifestCatalogs(pkgJson, catalogs)` — write back at the **top level**
  (migrating a nested copy), which is where bun reads them.
- `threeWayMergeCatalogs(base, disk, next)` — see `CatalogConfigDeps` above.

### src/utils/commit-subject.ts

- `buildUpdateSubject(updates)` — derive the full conventional PR title / commit
  subject (`chore(deps): …`) from the run's `DependencyUpdateResult[]`.
  First-match-wins over four buckets (package-manager self-upgrade, runtimes,
  config deps, regular deps): names a single change, summarizes runtime-only or
  config-only batches, scopes a single-workspace dependency batch and composes
  mixed runs. Regular deps are broken down by package.json section with field-name
  nouns (`update 1 config dependency and 4 devDependencies`); the elliptical coarse
  form (`update N config and M dependencies`) is kept when the regular deps are all
  plain `dependencies`. The 72-char header budget is a progressive degradation
  ladder: typed breakdown → coarse phrasing → generic
  `chore(deps): update dependencies`. Versions are shown clean (operator and
  `+sha512` suffix stripped); runtime names are capitalized, package-manager names
  stay lowercase.

### src/utils/deps.ts

- `parseConfigEntry(entry)` — parse a config dependency entry (version + optional
  hash).
- `matchesPattern(depName, pattern)` — glob matching via `path.matchesGlob`.
- `parseSpecifier(specifier)` — parse a version specifier; `null` for
  `catalog:`/`workspace:`.

### src/utils/github-markdown.ts — DELETED

The GFM writer is **`GitHubMarkdown` from `@effected/github-actions`** (note the
capital H). `Report` imports it directly and destructures its statics, which are
self-contained (no `this`), so destructuring is safe.

**This module existed on a misreading, and the misreading is worth recording so
it is not repeated.** The router skill's absence list says the kit ships "no
report-shaping construct — report shaping is consumer policy," and that was read
here as "no markdown writer," which became settled fact in five documents. The
kit does ship the writer; only the *arrangement* of a report is consumer policy.
`GithubMarkdown` → `GitHubMarkdown` is a **rename**, not a removal.

The kit's writer is also strictly better than what it replaced: it renders
through `@effected/markdown`'s node classes and serializer rather than string
joining, so a cell cannot corrupt the table around it.

**Verified output-identical before the swap.** A full PR body and job summary
were rendered with both writers over fixtures carrying pipes, backslashes,
underscores, tildes, embedded fences and multi-package grouping. The documents
were byte-for-byte identical except one cell: a literal backslash, which the old
builder double-escaped (`a\\b`) and the kit escapes minimally (`a\b`). The kit is
correct, and a backslash in a dependency name or version is not reachable in
practice.

Two behavioral notes carried over from the old module:

- `codeBlock` still grows its fence past any backtick run in the content
  (verified identical).
- **`table` no longer returns `""` for zero rows** — the kit renders a
  headers-only table. Every call site is inside a loop over a non-empty map, so
  zero rows is unreachable today; a future caller that can pass an empty row set
  must guard it itself.

`bold` and `rule` are the only two builders the kit does not ship. They live in
`src/utils/markdown.ts` as literal one-liners with no escaping and no structure —
deliberately not a second writer.

### src/utils/input.ts — DELETED

`parseMultiValueInput` and its module are gone. `ActionInput.list` from
`@effected/github-actions` owns that grammar now (see @./04-module-entry-points.md);
the five call sites read `ActionInput.list(name).pipe(Config.withDefault([]))`. The
grammar itself is still pinned locally by `INPUT_*`-keyed tests, now in
`__test__/unit/schema/inputs.test.ts` (the suite moved with `readInputs` into
`src/schema/inputs.ts`).

### src/utils/markdown.ts

- `npmUrl(packageName)` — npmjs.com URL for a package.
- `cleanVersion(version)` — strip prefix characters from a version string.

### src/utils/pnpm.ts

- `parsePnpmVersion(raw, stripPnpmPrefix?)`, `formatPnpmVersion(version, hasCaret)`
- `detectIndent(content)` — detect JSON indentation (reused by `RegularDeps`,
  `PeerSync`, `RuntimeUpgrade`, `PackageManagerUpgrade`, `CatalogConfigDeps`).
- `corepackHashFromIntegrity(integrity)` — convert an npm registry integrity
  (`sha512-<base64>`) to corepack's `packageManager` hash form (`sha512.<hex>`) —
  the exact string `corepack use` would write. Tolerates a JSON-quoted value;
  returns `null` when missing or not a sha512 integrity.

### src/utils/runtime.ts

- `isStaticVersion(raw)` — true when `raw` is a static exact version with no range
  operator, wildcard, OR-set or partial form. Makes `auto` a no-op on pins.
- `findRuntimeEntry(devEngines, runtime)` — find the entry (object or array shape),
  or `null`. Returns the **live object**, so assigning `version` rewrites the
  manifest in place. There is no upsert/promote helper and no operator helper: the
  action never adds an entry and always writes a bare exact version.

### src/utils/semver.ts

- `resolveLatestSatisfying(versions, range)` — highest stable version satisfying an
  arbitrary range. Used by `RegularDeps`, `ConfigDeps`, `CatalogConfigDeps` and
  `PackageManagerUpgrade`.
- `resolutionRangeForSpecifier(prefix, version)` — the range `RegularDeps` resolves
  a specifier within: the config-dep range for caret-on-zero (`^0.y.z`), the literal
  `prefix+version` otherwise.
- `resolveLatestInRange(versions, current)` — highest stable version satisfying
  `^current`.
- `configDepUpgradeRange(version)` — synthesize a conservative range from a pinned
  config-dep version's major: `>=version <(major+1).0.0` for `>=1.0.0`,
  `>=version <2.0.0` for `<1.0.0`; `null` when there is no numeric major.
