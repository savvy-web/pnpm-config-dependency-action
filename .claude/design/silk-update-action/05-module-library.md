---
status: current
module: silk-update-action
category: architecture
created: 2026-02-20
updated: 2026-08-23
last-synced: 2026-08-23
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

**The workspace root is a required parameter everywhere it appears — every
service method AND every standalone helper.** There is no `process.cwd()` default
left anywhere in `src/`.

This is the branch's most-repeated bug closed structurally rather than one site
at a time. Four separate instances were found — `commitChanges`,
`ensureBaseHistory`, `steps/detect-changes.ts` and `steps/custom-commands.ts` —
in four separate rounds, three of them by reviewers rather than by us. **Every
one entered through a parameter that quietly defaulted to `process.cwd()`.** The
action can legitimately be invoked from a subdirectory, so the default does not
fail: it reads a different tree, succeeds, and reports a confident wrong answer.

While the defaults existed the same bug could reappear at any new call site with
nothing to say so. Required parameters turn every future instance into a compile
error, which is the whole point — it converts a class of silent wrong-directory
reads into something the type checker refuses.

Worth recording what the change actually cost: **`src/` needed no edits at all.**
Every production caller already passed a root explicitly, so the defaults were
pure hazard providing nothing. Three test call sites were relying on them, each
silently reading the runner's cwd — and two of those were `chdir`-ing the test
process into a temp directory *specifically to reach the default*, which is
global mutable state in a test suite. They now pass the root, which is both what
production does and the stronger assertion.

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
construction) **and `PackageJsonFile`** from `@effected/package-json`, both
resolved in the layer body so `upgrade`'s `R` stays `never`.

> **Wiring note, because omitting it is not a type error.** This service's
> `PackageJsonFile` requirement was added without `makeAppLayer` providing it,
> which typechecked and killed every run in v4.6.0. `makeAppLayer` now provides
> it here *and* to `RuntimeUpgrade`, and
> `__test__/unit/layers/app.test.ts` fails the build if a future layer resolves
> something the app layer does not supply. See @./09-project-status.md.

```typescript
export class PackageManagerUpgrade extends Context.Service<PackageManagerUpgrade, {
 readonly upgrade: (mode: string, pm: SupportedPm, workspaceRoot: string) =>
  Effect.Effect<PackageManagerUpgradeOutcome, FileSystemError>;
}>()("PackageManagerUpgrade") {}
```

**Algorithm:**

1. Read root `package.json`; parse the `packageManager` field and the
   `devEngines.packageManager` entry through `@effected/npm`'s
   `PackageManagerPin.parseResult`. An entry naming a *different* manager than
   the one being upgraded is not a reference for this run and is ignored.
2. Pick a reference version favoring `devEngines.packageManager`.
3. Choose the target range: `true`/`auto` → `^reference` (latest within the
   current major); an explicit range is used verbatim and may cross majors.
4. Resolve via `NpmRegistry.versions(pm)` + `resolveLatestSatisfying`.
5. Write. **corepack-managed managers (pnpm, npm)** get a pinned
   `version+sha512.<hex>` (derived from the registry integrity via
   `CorepackIntegrityHash.fromSri`) in both `packageManager` and
   `devEngines.packageManager.version` — no `corepack use` is invoked, because it
   errors when both fields are present; the subsequent install performs the
   corepack switch. **bun is not corepack-managed** — it never consults
   `packageManager` — so it is written as a bare `bun@<version>` and the integrity
   fetch is skipped entirely.

**The write is a surgical edit, not a re-serialize.** Nothing is mutated on the
parsed object: the steps above *collect* `PackageFieldEdit`s (`["packageManager"]`,
`["devEngines", "packageManager", "version"]`) and hand them to
`PackageJsonFile.modify` in one call, which rewrites only those spans and leaves
key order, indentation and line endings exactly as the consumer had them. This
manifest is committed to someone else's repository, so a whole-file
`JSON.stringify` — the previous approach, formatting guessed by `detectIndent` —
made the diff unreviewable whenever the guess was wrong.

**Both halves of the pin grammar are `@effected/npm`'s now (issue #290), and
the two swaps are not the same trade.**

- **`CorepackIntegrityHash.fromSri`** replaced a local converter that this
  repo's copy had motivated upstream (effected#281 cites it as the consumer
  evidence). It is **stricter, on purpose**: the local one base64-decoded
  whatever followed `sha512-` and emitted the hex, so non-canonical base64 and a
  wrong-length digest both produced a pin that *looked* well-formed and that
  corepack rejects at install time — in the consumer's repository, after this
  action reported success. Those fail typed now and take the same
  bare-version write an absent integrity already took. Pinned by a test that
  fails against the old converter with `pnpm@11.13.0+sha512.deadbeef`.
- **`PackageManagerPin.parseResult`** replaced the module-private
  `parsePmVersion`, whose version check was `/^\d+\.\d+\.\d+/` against the tail
  — a *prefix* match, so `pnpm@11.12.0garbage` was accepted as a reference and
  the synthesized `^11.12.0garbage` range then reported `unsatisfiable`, which is
  this service's diagnosis for "the range names a different package manager".
  A parse failure now reports `no-reference`, which is what actually happened.

  The **one** local concession is a leading `^`/`~` stripped from
  `devEngines.packageManager.version` before parsing. A range is illegal in a
  corepack pin and `PackageManagerPin` says so correctly; `devEngines` is
  specified to accept one and repos write `^11.0.0` there. Handing that straight
  to the pin grammar would report "no reference" and silently stop upgrading a
  manager the repo plainly declares. It is dropped rather than resolved because
  the reference is only ever the anchor for a synthesized range.

The **read** of the manifest is still `readFileSync` + `JSON.parse`,
deliberately: the kit's
`Package.decode` rejects a private workspace root, and the lenient
`PackageManifest` that `0.9.0` added is unadopted because the parse only feeds a
decision. **Only `modify` was adopted** — the prior ruling against this package
was narrowed to that one decode-free member, not overturned, and its central
objection still governs this read. See the settled decision in
@./09-project-status.md.

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

### One memo, two moments — the `WorkspaceCatalogs.refresh()` boundary

`WorkspaceCatalogs` memoizes its assembly (one workspace read + one hook
replay) for the layer lifetime, and **this run mutates the workspace between
its two readers**. Release-age discovery triggers the assembly first, *before*
anything installs — and deliberately wants that before-state, since the gate
governs what this run may propose. `steps/peer-check.ts` reads
`peerDependencyRules()` *after* the install — and needs the after-state, since
the run may have bumped the very config dependency whose hooks supply the
rules. One infinite memo cannot serve both, so the step calls
`catalogs.refresh()` (new in `@effected/workspaces@0.17.0`, whose TSDoc names
exactly this tool shape as its reason to exist) before the rules read. The
cost is explicit and accepted: an enabled `check-peers` run replays the
config-dependency hook subprocess **twice**, once per moment.

This was found live, not reasoned out: spencerbeggs/pnpm-module-template#84
reported a `required` unsatisfied peer on a row that the freshly bumped
`@effected/pnpm-plugin-effect@0.5.0`'s `allowedVersions` suppress — the step
was judging the after-install lockfile under the pre-install plugins' rules —
and #85 auto-merged after the fix. A measured fact worth keeping from that
diagnosis: **pnpm ignores the parent *version* in an `allowedVersions` key**
(`parent@1.0.0>peer` suppresses the mismatch under any parent version), and
the kit replicates that deliberately (its `PeerDependencyRules` TSDoc names
both key spellings) — it is why 0.5.0's rc.109-keyed rules suppress an
rc.111-parented drift row rather than silently matching nothing.

The ordering is pinned by a test that discriminates
(`__test__/unit/steps/peer-check.test.ts`): its double answers the rules read
only after `refresh()` has run, so a step that skips the call *or* orders it
after the read goes red. *Falsified if* `refresh()` stops being called before
`peerDependencyRules()` in `steps/peer-check.ts` — or, more quietly, if
release-age discovery ever moves to *after* the install, at which point the
refresh becomes a harmless no-op and the before/after split this section
describes no longer exists.

### src/services/config-deps.ts - ConfigDeps (pnpm)

Update pnpm config dependencies by querying npm and editing `pnpm-workspace.yaml`
in place (avoiding `pnpm add --config`, which promotes deps to the default catalog
under `catalogMode: strict`). Depends on `NpmRegistry` and `ReleaseAge`.

```typescript
export class ConfigDeps extends Context.Service<ConfigDeps, {
 readonly updateConfigDeps: (deps: ReadonlyArray<string>, workspaceRoot: string) =>
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
 readonly update: (deps: ReadonlyArray<string>, workspaceRoot: string) =>
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

**What happens when the base cannot be read turns on WHY, and collapsing the
routes shipped a defect.** Every base failure used to arrive as one `null` and
take `pluginWinsMerge`, so an integrity mismatch was handled as a missing merge
base and silently discarded a user's override. The four routes now:

| base outcome | route | why |
| --- | --- | --- |
| read | `threeWayMergeCatalogs` against it | the normal case |
| `notFound` | `pluginWinsMerge` | the artifact is genuinely gone (yanked, unpublished). `next` overwrites what it defines, disk-only keys survive, nothing is removed — and the caller warns, because an override on a key the plugin still ships is lost in that mode |
| `noCatalogsExport` | `threeWayMergeCatalogs` against **`{}`** | the base loaded fine and simply ships none — a first adoption |
| anything else | **skip the dependency** | something that exists could not be read faithfully, so we do not know which entries are ours |

**The asymmetry between the middle two rows is the subtle part, and it is not
about the merge.** Against an empty base *every* manifest entry diverges and is
therefore `kept`. For a first adoption that is exactly right: those entries
predate the plugin and are the user's by definition. For a *yanked* base the
same routing would freeze every existing entry and the plugin could never move
again — which is why `notFound` takes the lossy-but-progressing path instead.
So empty-base is correct for one row and paralysing one row over, and the two
cases must not be merged on the grounds that both "have no base".

The `kept` delta is what makes this testable rather than merely arguable: an
empty-base merge *reports* the surviving override as `kept`, where plugin-wins
reports it as `updated` and overwrites the value. A test asserting the delta
therefore discriminates between the two routes. (An assertion that the entry is
simply *absent* from the deltas does not — that was wrong on the first attempt
here, and the suite caught it.)

The skip leaves the declared range unbumped too, for the same reason the
`next`-side skip does: writing a version whose catalogs were never merged would
leave the manifest describing a release it never saw.

Nothing here is fatal except a manifest that cannot be read or written: a
per-dependency failure warns and skips that dependency.

### src/services/module-catalogs.ts - fetchModuleCatalogs

Reads a config dependency's `catalogs` export from its **published tarball**.
pnpm reads this out of the installed package, but this action's merge has to
happen *before* any install runs (its output feeds the manifest install then
reads).

**Most of this module moved upstream** (effected#282) and it is now 198 lines,
down from 326. Fetching, integrity-verifying and extracting the tarball is
`@effected/npm`'s `PackageTarball.extract` — **scoped**, so the temp directory
is removed when the calling scope closes and this module owns no cleanup at
all. Entry resolution is `@effected/package-json`'s `resolveEntryPoint`.

What stayed is the half that is genuinely local: **loading** the resolved entry
with `import()`, and deciding what a missing or malformed `catalogs` export
means. The loader deliberately did not go upstream — a kit-level `import()` of
a computed path would hand every bundling consumer the context-module problem
with no seam to fix it. That call site keeps its inline
`/* webpackIgnore: true */`; see the build note in @./01-dependencies.md.

A standalone exported function, not a service — no state, one caller.

#### The outcome is discriminated, and that is a bug fix rather than tidying

`fetchModuleCatalogs` returns a `ModuleCatalogs` outcome —
`{ _tag: "Catalogs", catalogs }` or `{ _tag: "Unavailable", reason }` — where
`reason` carries `TarballError`'s four members verbatim (`notFound`, `http`,
`integrityMismatch`, `extractFailed`) plus this module's own post-extract
stages (`unresolvedEntryPoint`, `notImportable`, `noCatalogsExport`,
`malformedCatalogs`).

It used to return `CatalogMap | null` with `E = never`, and **the collapse was
reachable as a live defect**, not merely imprecise. `CatalogConfigDeps` reads
the *base* version's result to decide whether it has a merge base, and read
every `null` as "there is no base", which routes to the lossy `pluginWinsMerge`.
So an integrity mismatch on the base tarball — bytes that are not what the
registry vouched for — discarded a user's catalog override, in a consumer's
repository, on a run that reported success. The routing table and the
asymmetry it turns on are under `CatalogConfigDeps` above.

*Falsified if* the reason ever stops being read at the call site: the
discrimination is load-bearing only because something branches on it, and a
future refactor that collapses the branches makes the union decoration again.
The mutant that proves it discriminates is in @./08-testing.md.

**Note the direction of travel.** The kit's `TarballError` does **not** carry a
`noCatalogsExport` member and deliberately should not: `extract` stops at the
extracted directory, so reading a catalogs export, finding it absent, and
deciding what an absent one means are all consumer policy. A tarball error
asserting something about this action's file format would be the wrong
boundary.

### src/services/regular-deps.ts - RegularDeps

Update regular dependencies by querying npm directly (avoiding `pnpm up --latest`,
which promotes deps to catalogs under `catalogMode: strict`). Depends on
`NpmRegistry`, `WorkspaceDiscovery` and `ReleaseAge`.

```typescript
export class RegularDeps extends Context.Service<RegularDeps, {
 readonly updateRegularDeps: (
  patterns: ReadonlyArray<string>,
  workspaceRoot: string,
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
 readonly capture: (pm: SupportedPm, workspaceRoot: string) =>
  Effect.Effect<LockfileModel | null, LockfileError>;
 readonly compare: (before, after, workspaceRoot) =>
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
failures are caught and skipped per-runtime, never fatal. Also requires
**`PackageJsonFile`** (`@effected/package-json`), resolved in the layer body
alongside the three resolvers so `upgrade`'s `R` stays `never`.

```typescript
export class RuntimeUpgrade extends Context.Service<RuntimeUpgrade, {
 readonly upgrade: (config: RuntimeUpgradeConfig, workspaceRoot: string) =>
  Effect.Effect<readonly RuntimeUpgradeResult[], FileSystemError>;
}>()("RuntimeUpgrade") {}
```

**Per runtime:**

1. `"false"` → skip.
2. Look up the existing entry via `locateRuntimeEntry`. **If none exists, skip
   with a warning** — in *every* mode. These inputs upgrade a runtime the repo
   already declares; they never add one. (An explicit range used to add a missing
   entry, which grew an unwanted node entry in a bun-only repo.)
3. `auto`: skip on a static pin (`isStaticVersion`); otherwise the existing version
   string is the target range.
4. Explicit range: the user-typed value is the target range — it only selects
   *which line to resolve*.
5. `resolver.resolve({ range })` → `.latest`; on any error (including
   `VersionNotFoundError` for an EOL line) warn and skip.
6. Skip if `latest` equals the current value.
7. Record a planned edit: the **bare, exact** version, no operator re-attached,
   at the `versionPath` the locator returned. **Nothing is mutated here** — the
   parsed manifest is read only to decide.
8. If at least one runtime moved, one `PackageJsonFile.modify` call applies every
   planned edit in a single read/edit/write pass, and skips the write entirely
   when the result would be byte-identical.

**Why a path and not a live object — the inversion is deliberate.** This module
used to call `findRuntimeEntry`, whose stated virtue was returning the *live*
object inside `devEngines` so that `entry.version = latest` rewrote the parsed
tree in place; the manifest was then re-serialized wholesale with an indent
guessed by `detectIndent`. That preserved formatting only by accident.
`locateRuntimeEntry` returns the entry **and** the JSONC path to its `version`,
because the write is now a surgical edit and mutation is exactly what must not
happen. The path is shape-dependent — `devEngines.runtime` is legally either a
single object or an array, so it is `["devEngines","runtime","version"]` or
`["devEngines","runtime",<index>,"version"]` — which is why one walker produces
both rather than a second walker deriving the path and drifting from the first.

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
 readonly generateCommitMessage: (updates) => string;
}>()("Report") {}
```

- `base` is the resolved `target-branch`. Creation/update goes through
  `PullRequest.upsert`.
- **The DCO sign-off is resolved once, in the layer body**, via
  `resolveSignoff()` (see `utils/commit-signoff.ts` below), and closed over by
  both `generateCommitMessage` and the PR body's proposed-squash-commit fence.
  That placement is the usual "resolve dependencies in the layer" convention
  doing real work here: `resolveSignoff` is an `Effect` over `ActionState` while
  the two consumers are a sync string builder and a method whose `R` must stay
  `Repo`-only, so the layer is the one place it can be read without pushing
  `ActionState` into a member's requirement channel and out of reach of the
  app-layer guard. It also makes drift between the two renderings structurally
  impossible rather than merely intended.
  - It replaced a `generateCommitMessage(updates, appSlug?)` parameter. The
    parameter is gone rather than defaulted, because **nothing ever passed it**:
    `steps/commit-and-pr.ts` calls with updates only, so the App-bot branch was
    reachable from the test suite and from nowhere else, and every real run
    signed as `github-actions[bot]` while the App bot authored the commit. An
    optional parameter with one caller that never supplies it is a capability
    the type system advertises and the program does not have.
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
the source.

**The sketch below is illustrative and stays that way deliberately.** Read
`src/layers/app.ts` for the wiring itself. It is kept as a sketch rather than
promoted to a transcript because a transcript acquires an obligation to be
byte-accurate — which is the maintenance burden that let the previous version of
this sketch drift into teaching the *opposite* of the invariant this module
exists to state (it showed `NodeServices.layer` and `FetchHttpClient.layer` being
built locally and merged into `libraryLayers`, which is exactly what
`makeAppLayer` must not do). What a reader has to get right is the **`Layer.provide`
topology** and **which services are deliberately not built here**; the sketch is
answerable for those two things and nothing else.

```typescript
export const makeAppLayer = (dryRun: boolean, options: { runtimeLive: boolean } = { runtimeLive: false }) => {
 // The token is provisioned in `pre` and persisted to ActionState.
 // clientLayer() reads it back. ActionState comes from ActionRuntime via
 // Action.run, so it is NOT rebuilt here. orDie makes a missing/expired token
 // a fatal defect rather than an error every caller must handle.
 const githubClient = GitHubToken.clientLayer().pipe(Layer.orDie);
 // Repo is required per call rather than captured, so it is a layer like any
 // other; GITHUB_REPOSITORY is read through the ambient ConfigProvider.
 const repo = Repo.layerFromConfig().pipe(Layer.orDie);

 // ── NOT BUILT HERE, and this is the load-bearing part ──────────────────────
 // NpmRegistry needs an HttpClient; the workspace layers and PackageJsonFile
 // need FileSystem/Path/ChildProcessSpawner. None of those is constructed in
 // this function. They are members of `ActionServices`, which Action.run's
 // ActionRuntime already provides, so they stay in this layer's REQUIREMENT
 // channel and are satisfied at the boundary. Building them here shipped a
 // second copy of the Node platform and the fetch client in the bundle.
 // => no `NodeServices.layer`, no `FetchHttpClient.layer`, anywhere below.
 const npmRegistry = NpmRegistry.layer;
 const packageJsonFile = PackageJsonFile.layer;
 const workspaceRoot = WorkspaceRoot.layer;
 const packageManagerDetector = PackageManagerDetector.layer;

 const gitBranch = GitBranch.layer.pipe(Layer.provide(githubClient));
 const gitCommit = GitCommit.layer.pipe(Layer.provide(githubClient));
 const prLayer = PullRequest.layer.pipe(Layer.provide(githubClient));

 const workspaceDiscovery = WorkspaceDiscovery.layer().pipe(Layer.provide(workspaceRoot));
 // The lockfile records which config-dependency version is actually installed —
 // the merge base for CatalogConfigDeps' three-way catalog merge.
 const lockfileReader = LockfileReader.layer().pipe(
  Layer.provide(Layer.mergeAll(workspaceRoot, packageManagerDetector, workspaceDiscovery)),
 );
 // MUST be the subprocess variant: the in-process one loads each pnpmfile with a
 // computed dynamic import(), which rspack compiles into a context module and
 // breaks in the bundled dist.
 const workspaceCatalogs = WorkspaceCatalogs.layerWithConfigDependenciesSubprocess().pipe(
  Layer.provide(Layer.mergeAll(workspaceRoot, lockfileReader)),
 );
 // ReleaseAge.layer, not a factory: the root is bound by WorkspaceCatalogs.
 const releaseAge = ReleaseAge.layer.pipe(Layer.provide(Layer.merge(npmRegistry, workspaceCatalogs)));
 const depsRegen = SilkChangesets.DepsRegenDefault;

 const libraryLayers = Layer.mergeAll(
  githubClient, repo, gitBranch, gitCommit,
  CheckRun.layer.pipe(Layer.provide(githubClient)),
  prLayer, npmRegistry,
  // Read-mostly: status for the change verdict and commit file list, configSet
  // once for the core.fileMode pin. History still moves through the API.
  Git.layer,
  DryRun.layerFrom(dryRun),
 );

 const domainLayers = Layer.mergeAll(
  workspaceRoot, workspaceDiscovery, packageManagerDetector,
  Changesets.layer.pipe(Layer.provide(depsRegen)),
  BranchManager.layer.pipe(Layer.provide(Layer.mergeAll(gitBranch, gitCommit, Git.layer))),
  // BOTH package.json writers resolve PackageJsonFile in their layer bodies, so
  // BOTH must be provided it. Providing it to only one is NOT a type error and
  // fails only on the runner — this line is the v4.6.0 fix.
  PackageManagerUpgrade.layer.pipe(Layer.provide(Layer.merge(npmRegistry, packageJsonFile))),
  ConfigDeps.layer.pipe(Layer.provide(Layer.merge(npmRegistry, releaseAge))),
  CatalogConfigDeps.layer.pipe(Layer.provide(Layer.merge(npmRegistry, lockfileReader))),
  RegularDeps.layer.pipe(Layer.provide(Layer.mergeAll(npmRegistry, workspaceDiscovery, releaseAge))),
  Report.layer.pipe(Layer.provide(prLayer)),
  RuntimeUpgrade.layer.pipe(
   Layer.provide(Layer.merge(makeRuntimeResolvers(options.runtimeLive), packageJsonFile)),
  ),
 );

 return Layer.provideMerge(domainLayers, libraryLayers);
};
```

Two properties the sketch is answerable for, both checkable in one pass:

- **`Layer.provide` topology.** Every domain layer names exactly the services its
  own layer body resolves. `PackageManagerUpgrade` and `RuntimeUpgrade` each name
  `packageJsonFile`; missing it on either is the v4.6.0 defect.
- **Nothing platform-shaped is constructed.** `NodeServices.layer` and
  `FetchHttpClient.layer` must not appear. *Falsified if* either does — that is
  the drift, not a stylistic difference, and it is worth grepping this block for
  before trusting it.

`makeRuntimeResolvers(live)` returns either the three `*Resolver.layerOffline`
layers (bundled snapshot, no IO, no requirements) or the live `*.layer` layers.
On the live path `NodeResolver.layer` is used **bare** — it needs only
`HttpClient.HttpClient`, which `ActionServices` already supplies, so giving it a
private `FetchHttpClient` would be the same second-copy mistake as above. Deno
and Bun are provided `@effected/runtimes`' `GitHubClient.layerDefault`, which
pre-wires auth + `FetchHttpClient` and is genuinely self-contained (`E = never`),
so those two do keep a `Layer.provide`. Each live resolver falls back to the
bundled snapshot on a fetch failure, logging a warning.

### The requirement channel is the contract, and it is checked

`makeAppLayer` deliberately does **not** build everything it needs. Several
layers leave `FileSystem`, `Path`, `HttpClient` and `ChildProcessSpawner` in the
returned layer's requirement channel, because `Action.run` already supplies them
as `ActionServices` and building private copies would bundle a second platform
into `dist`. So the contract of this function is precisely:

> everything left in `makeAppLayer`'s requirement channel must be a member of
> `ActionServices`.

**Nothing in the production call path enforces that.** `Action.run`'s `options`
parameter is optional, so `Action.run(program)` typechecks whatever is left over
— a bare leftover requirement is not an error, it is an inference. `makeAppLayer`
is also `/* v8 ignore */`-d and never built in a test, so no runtime signal
existed either.

That combination shipped v4.6.0 dead: `PackageManagerUpgrade.layer` started
resolving `PackageJsonFile`, only `RuntimeUpgrade` was provided it,
`PackageJsonFile` sat in the channel, and every run in every consumer repo failed
~30ms in with `Service not found: @effected/package-json/PackageJsonFile` —
before the check run existed. Clean `tsc`, 588 passing tests.

`__test__/unit/layers/app.test.ts` now states the contract as a type:

```typescript
type AppLayerRequirements = RequirementsOf<ReturnType<typeof makeAppLayer>>;
type UnsatisfiedRequirements = Exclude<AppLayerRequirements, ActionServices>;

const _everyRequirementIsProvidedByActionRun: [UnsatisfiedRequirements] extends [never]
 ? true
 : UnsatisfiedRequirements = true;
```

The teeth are the annotation — when the exclusion is non-empty, `true` stops
being assignable and the compiler error *names the missing service*. Tests are in
the tsc project, so this fails `pnpm typecheck` at pre-commit and in CI, not only
under vitest. The runtime `expect` in that file is deliberately weak and says so.

**What it does not cover, stated so it is not over-trusted:** it catches a
*missing* provide, not a *broken* one. Nothing builds the graph, so a layer that
is wired but fails to construct still gets through. And it is only as good as
`ActionServices` being an honest list of what `Action.run` constructs — see the
three falsification conditions in @./09-project-status.md.

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

### src/utils/commit-signoff.ts

- `resolveSignoff()` — `Effect<string, never, ActionState>`. The DCO
  `Signed-off-by` trailer for a commit this action creates, read from the token
  `GitHubToken.provision` persisted in `pre` and rendered by
  `BotIdentity.signoff`. Deliberately the same module, name and shape as
  `silk-release-action`'s: both actions commit through the Git Data API, which is
  what makes GitHub verify the commit and also what bypasses `git commit -s`, so
  both must supply their own trailer.

  What is **local** is the policy — which identity to sign as, and that an
  unreadable token degrades to `BotIdentity.githubActions` rather than failing a
  run whose dependency work is already done. What is **not** local is the trailer
  text: `Signed-off-by:` is DCO 1.1, with fixed casing, spacing and angle
  brackets, and since nothing validates it at commit time a subtly malformed one
  surfaces as a red DCO check on someone else's pull request, in another
  repository, after the run reported success.

  Two fallbacks at different depths, both load-bearing:
  `GitHubToken.botIdentity()` already answers `BotIdentity.githubActions` when the
  persisted token carries no `appSlug` (`provision`'s `GET /app` lookup failed);
  the `Effect.catch` here covers the state read failing outright, which is every
  unit test that does not stand up a `pre` phase. The declared error channel is
  `never` because of the second one.

  **The `ActionState` double had to be corrected for this to be testable**, and
  the correction is the more general finding: `__test__/utils/action-doubles.ts`
  used to `Effect.die` on a missing key while the real `ActionState.get` fails
  *typed* with `reason: "missing"`. A defect is uncatchable, so code whose
  contract is to degrade when nothing was persisted read as broken under the
  double while being correct against the real store — a double stricter than the
  thing it stands in for does not catch bugs, it invents them, and the standing
  temptation is then to weaken the production code to satisfy the fake. Pinned by
  `__test__/unit/doubles.test.ts`.

### src/utils/peers.ts

- `decidePeerGate(mode, report)` — the auto-merge gate decision, pure and
  service-free. Lives here rather than inside `steps/peer-check.ts` because the
  arms that matter have **zero** required rows and are still not a pass, and each
  needs a table-driven test rather than a lockfile, a layer and a subprocess.

  The predicate is `supported && !unresolvedImporters.length &&
  !unverified.length && !requiredCount` — `@effected/workspaces` states that
  *both* `unverified` reasons mean fail closed, and a gate reading
  `required.length === 0` as "clean" is the silent pass that `supported`,
  `unresolvedImporters` and `unverified` exist to prevent. Mutation-verified: a
  gate reading only `requiredCount` turns five tests red.

  The returned `reason` is a union rather than prose because it drives a log
  line, and its **order** is load-bearing for that line rather than for the
  boolean — an unsupported format is *why* there are no rows, so reporting
  `unverified` there would send a reader to the wrong explanation.

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

- `detectIndent(content)` — detect JSON indentation. **Three call sites:**
  `RegularDeps`, `PeerSync`, `CatalogConfigDeps`. It is *no longer* used by
  `RuntimeUpgrade` or `PackageManagerUpgrade` — those write through
  `PackageJsonFile.modify`, which preserves the existing indentation exactly
  rather than guessing it.
That is now the **whole** of this module's exports, and the three deletions that
got it there happened for **two different reasons** — worth keeping distinct,
because collapsing them into "dead code was removed" loses the useful half.

- `parsePnpmVersion` / `formatPnpmVersion` / `ParsedPnpmVersion` were deleted for
  having **no caller** in `src/` or `__test__/`, `PackageManagerUpgrade` having
  moved to a module-private `parsePmVersion` during the multi-package-manager
  work. Their stated justification (the kit rejecting a caret `packageManager`
  pin) had also expired independently. Detail in @./09-project-status.md and
  @./03-type-definitions.md.
- `corepackHashFromIntegrity` was deleted for the **opposite** reason: it had a
  caller, it worked, and the capability moved upstream. `@effected/npm@0.11.0`
  ships `CorepackIntegrityHash.fromSri` / `.FromSri` — the swap this repo's own
  copy motivated (effected#281 cited it as the consumer evidence; issue #290
  tracked it here). Not a like-for-like port: see the `PackageManagerUpgrade`
  section above for the malformed-base64 and wrong-digest-length cases the local
  version converted into a pin corepack rejects at install.

The module keeps a comment block where each deleted export was, so the reasoning
is discoverable from the source and not only from here.

### src/utils/runtime.ts

- `isStaticVersion(raw)` — true when `raw` is a static exact version with no range
  operator, wildcard, OR-set or partial form. Makes `auto` a no-op on pins.
- `locateRuntimeEntry(devEngines, runtime)` — find the entry (object or array
  shape) and the JSONC `versionPath` to its `version`, or `null`. **Do not mutate
  the returned entry**: it is for reading the current version, and the path is
  what gets handed to `PackageJsonFile.modify`. There is no upsert/promote helper
  and no operator helper — the action never adds an entry and always writes a
  bare exact version.
  - Replaces `findRuntimeEntry`, which returned the live object precisely *so*
    callers could assign to it. That property was the point until the write
    became surgical; it is now the thing being designed against.

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
