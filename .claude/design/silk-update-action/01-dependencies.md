---
status: current
module: silk-update-action
category: architecture
created: 2026-02-20
updated: 2026-09-04
last-synced: 2026-09-04
completeness: 95
related:
  - ./_index.md
dependencies: []
implementation-plans: []
---

# Dependencies

[Back to index](./_index.md)

## Runtime Dependencies (bundled into action)

The authoritative dependency list and ranges live in the `dependencies` block of `package.json` — this doc does not mirror them.

**It did, though, in seven places, and every single one had rotted.** Six package headings carried a declared range in parentheses (`@effected/commands`, `git`, `workspaces`, `package-json`, `schemastore`, `github-action-builder`) and one restated a transitive range; the five `0.x` kit entries were stale by one to three **minors** — breaking, on a `0.x` line, per the caret trap recorded below — and `github-action-builder` by four patches on a stable `2.x` line, which is harmless and is exactly why nobody noticed the other five. They are removed rather than refreshed — refreshing is what produced the drift, and it re-arms the same trap for the next reader. A version literal that must agree with a file two directories away has no mechanism keeping it honest, which is the same argument the duplicate-resolutions section below reaches on its own evidence. **Where a version *is* load-bearing it is stated as history** ("`0.9.0` shipped `PackageManifest`", "adopted at `0.11.0`") — a claim about what a release contained, which does not go stale, rather than a claim about what is installed, which does.

**The same rule has since been applied outside these documents, which is the
useful confirmation that it generalizes.** `.repos/config.json` pins read-only
checkouts of `Effect-TS/effect` and `spencerbeggs/effected` for source lookups,
and its `effect` entry's prose `purpose` **named the pinned version inline**
beside the `ref` field that also named it — two sources of truth one line apart.
Predictably the prose went stale while `ref` was maintained. The literal is gone
from the prose; the `ref` is the single source, and the entry now says how to
check it (compare `packages/effect/package.json` at the pin against
`node_modules`, never read the tag name). The `effected` entry had already
learned this and said so; the `effect` entry had not. **Two entries in one file,
one carrying the lesson and one still exhibiting the bug, is what a rule looks
like before it has been applied everywhere** — worth checking for rather than
assuming a recorded lesson propagated.

Every runtime dependency is inlined into `dist/{pre,main,post}.js` at build time; the packages whose behavior is load-bearing for this action are described below.

The action runs on **Effect v4** (`effect` / `@effect/platform-node` both resolved from the `catalog:effect` catalog; **read the pinned version off the lockfile or the installed tree, never off a doc** — the line has already crossed from `4.0.0-beta` into `4.0.0-rc`, so even the *shape* of the version string in a prose claim goes stale). Effect v4 renamed several APIs the code and the notes below use: services are class-based `Context.Service` (was `Context.Tag`); the Node platform bundle is `NodeServices.layer` (was `NodeContext.layer`); `FileSystem`/`Path` import from `effect` directly, `HttpClient`/`FetchHttpClient` from `effect/unstable/http` and `ChildProcess`/`ChildProcessSpawner` from `effect/unstable/process` (the old `@effect/platform` package is dissolved into core `effect`); `Config.int` (was `Config.integer` — though this action reads integers via `ActionInput.integer`, not `Config`); `Effect.catch` (was `Effect.catchAll`); `Effect.result` returning a `Result` (was `Effect.either`); `Effect.timeoutOrElse` (was `Effect.timeoutFail`); and log levels are string literals (`"Info"` / `"Debug"` / `"Warn"`), set via `References.MinimumLogLevel`.

### The github-action-effects split (what replaced what)

`@savvy-web/github-action-effects` — the single library that used to provide the action plumbing, the GitHub API services, the npm registry and the command runner — is **deleted**. Its surface was split across the `@effected/*` kit. The mapping is worth keeping because most of the vocabulary changed with it:

| Deleted surface | Replacement |
| --- | --- |
| `Action`, `ActionEnvironment`, `ActionInput`, `ActionOutputs`, `ActionState`, `ActionLogger`, `DryRun`, `GitHubToken` | `@effected/github-actions` |
| `GitHubApp`, `GitHubClient`, `GitHubGraphQL`, `GitBranch`, `GitCommit`, `CheckRun`, `PullRequest`, `AutoMerge` | `@effected/github` |
| `NpmRegistry`, `SemverResolver`-adjacent registry reads | `@effected/npm` |
| `CommandRunner` (a service) | `@effected/commands`' `Run` free functions over core `ChildProcessSpawner` |
| `GithubMarkdown` | `GitHubMarkdown` (capital H) in `@effected/github-actions` — a **rename**, not a removal |
| `ActionInputError` | this repo's own `InvalidInputError` (`src/errors/errors.ts`) |
| `*Live` layer constants | `.layer` / `.layer(...)` statics on the service classes |
| `@savvy-web/github-action-effects/testing` (`ActionStateTest`, `GitHubAppTest`, `ActionOutputsTest`) | `__test__/utils/action-doubles.ts` over each service's `layerTest` |

## Key Packages

- `@effected/github-actions` — the GitHub Actions runtime: `Action.run(program, { layer? })`,
  `ActionEnvironment` (repo/sha/ref/actor, plus `isDebug` — the seam that reads the
  runner's step-debug flag), `ActionOutputs` (`set`, `summary`), `ActionState`
  (cross-phase state over `GITHUB_STATE`), `DryRun` (`DryRun.layerFrom(flag)`), and the
  `GitHubToken` lifecycle namespace.
  - **`ActionInput` is the input API, not `Config`.** `ActionInput.string/boolean/integer/redacted/list`
    derive the runner's mangled variable name (`dependencies` → `INPUT_DEPENDENCIES`;
    only spaces are replaced, so `upgrade-runtime-node` → `INPUT_UPGRADE-RUNTIME-NODE`)
    and treat an empty string as absent. A bare `Config.string("dependencies")` looks up
    the literal name, resolves **nothing** under the runner and silently takes its
    `withDefault` — a failure mode that is invisible in the logs because every step just
    reports "not configured". `ActionInput.list` implements the multi-value grammar
    (newline lists with `-` or `*` bullets, `#` comment lines dropped before bullet
    stripping, JSON arrays, comma-separated values) that used to live in this repo's
    `src/utils/input.ts`. It **fails on an absent or empty input**, so the
    `Config.withDefault([])` on each list read is load-bearing.
  - `GitHubToken` — `provision({ appId, privateKey, owner, required })` (pre),
    `clientLayer()` (main), `dispose()` (post). Credentials are passed **explicitly**;
    the kit does not read the app inputs itself, so `pre.ts` parses `app-client-id` /
    `app-private-key` via `ActionInput`. The scope-check field is named `required`.
- `@effected/github` — GitHub API resource services: `GitHubApp` (`GitHubApp.layer`, a
  self-contained layer — there is no octokit auth-app strategy or separate HttpClient to
  wire), `GitBranch`, `GitCommit`, `CheckRun`, `PullRequest`, and `Repo`.
  - **One error type:** every resource call fails with `GitHubError`, discriminated via
    `hasKind` rather than a per-service error class.
  - **`Repo` is a service, resolved per call.** It stays in each method's `R` instead of
    being captured at layer build, which is what keeps `Repo.provide(ref)` meaningful for
    a caller targeting a different repository. `Repo.layerFromConfig()` reads
    `GITHUB_REPOSITORY` through the ambient ConfigProvider.
  - `GitBranch.upsert(name, sha)` replaces the old exists/delete/create dance, returning
    `"created"` or `"reset"`. `GitCommit.commitFiles({ branch, message, changes })` takes
    tagged `FileContent` / `FileDeletion` members instead of a `{ path, sha: null }`
    sentinel. `PullRequest.upsert` creates-or-updates, and auto-merge is a **separate**
    `setAutoMerge` GraphQL call. `CheckRun.withCheckRun(name, sha, use)` passes
    `(id, conclude)` and concludes on **every** exit path; `CheckRunOutput.make({...})` is
    required (it is a `Schema.Class` — a bare object literal fails typechecking).
  - GraphQL is a member of the client, not a separate `GitHubGraphQL` service.
- `@effected/github-actions` + `@effected/github` together replace the whole
  `github-action-effects` layer stack; nothing in `src/` imports the old package.
- `@effected/commands` — subprocess execution as **free functions** over core
  `ChildProcessSpawner`, not a service: `Run.collect` (exit code as a *result*, so a
  non-zero exit is a value rather than an error), `Run.text` / `Run.lines` / `Run.json`
  (typed failure on a non-zero exit) and `Run.succeeds` (boolean probe). Also ships
  `ScriptedSpawner`, the public test fixture the suites script command responses with.
  - **`Run.text` trims**, which silently corrupts column-aligned output — a leading
    space is load-bearing in some formats, and trimming shifts every subsequent index.
    This used to be a live constraint on `services/branch.ts`, whose `gitRaw` helper
    read `git status --porcelain` through `Run.collect` for exactly that reason. **That
    helper and its rationale are gone**: the status reads moved to `@effected/git`, so
    no code here parses column-aligned text any more. The trimming is still true of
    `Run.text` and still worth knowing before reading a fixed-width format with it;
    it is no longer a property this action depends on.
- **`@effected/git` — adopted for `status` only.** `Git.status(cwd)` runs
  `git status --porcelain -z` and returns typed `StatusEntry` values (`x`, `y`, `path`,
  `origPath`), and `Git.configSet(cwd, key, value)` writes the checkout's local config.
  Both status readers use it — `services/branch.ts` for the commit file list and
  `steps/detect-changes.ts` for the change verdict — and `steps/configure-status.ts`
  pins `core.fileMode=false` through `configSet` once per run.
  - Adopting it **deleted `parseStatusLine`**, where three silent wrong answers had
    lived. `-z` also removes git's path-quoting layer, so the octal `\NNN` gap this
    repo used to carry is the kit's concern now.
  - The **mutating** tier is still not adopted: the other seven local git operations
    (refspec `fetch`, `checkout -B`, `reset --hard`, `--unshallow`, `branch -f`,
    `rev-parse --is-shallow-repository`, `merge-base`) stay on `Run`. So this module
    runs two subprocess mechanisms for git, accepted deliberately —
    @./09-project-status.md carries the reasoning and the revisit condition.
- `@effect/platform-node` — Node platform bundle (`NodeServices.layer`), providing
  FileSystem, Path and **ChildProcessSpawner** (the seam `Run` needs). Reaches the
  program through `Action.run`'s runtime, as a member of `ActionServices`.
  - **No module in `src/` imports it** — `grep -rn 'platform-node' src/` returns
    only a comment. `makeAppLayer` used to build `NodeServices.layer` itself for
    the root-bound `@effected/workspaces` layers, and that was the bug, not the
    design: it shipped a second copy of the Node platform in the bundle and made
    the action name a platform dependency it has no business naming. Every layer
    now leaves FileSystem/Path/ChildProcessSpawner in the requirement channel.
  - It remains a declared dependency in `package.json`. Whether that declaration
    is still load-bearing (types, transitive resolution) or vestigial like the
    `build.ignore` cyclonedx entries has **not** been checked — stated as
    unverified rather than asserted either way.
- `effect` (`catalog:effect`) — typed error handling, retries, resource management, plus
  `FileSystem`/`Path`, `HttpClient`/`FetchHttpClient` (`effect/unstable/http`) and
  `ChildProcess`/`ChildProcessSpawner` (`effect/unstable/process`).
- `@effected/npm` — the npm registry service and the release-age vocabulary.
  - `NpmRegistry` (`NpmRegistry.layer` over an `HttpClient`) — an **HTTP** registry client
    keyed by (registry, package, version); `versions`, `packageInfo` and `publishTimes`.
    It replaces both the old `NpmRegistry` service and this repo's hand-rolled
    `npm view <pkg> time --json` shell-out in `release-age.ts`. Being HTTP rather than a
    `npm` subprocess, the root-owned `~/.npm` cache EACCES class of failure on GitHub
    macOS runners is gone by construction.
  - `ReleaseAgeGate` (a Schema class — variadic total `combine`, strictest-wins;
    `matchesExclude` implementing pnpm's flat-string `*` matching, **not** minimatch;
    instance `isExcluded`; pure `filterVersions(versions, times, name, now)` where the
    caller supplies the clock and missing timestamps drop the version) and
    `PartialReleaseAgeGate` (the permissive per-source contribution type, re-exported by
    `src/services/release-age.ts`).
  - **`PackageTarball`, adopted at effected#282.** `extract(published)` takes an
    already-resolved `PublishedVersion` and answers the directory the tarball's
    `package/` root was unpacked into, failing with a `TarballError` whose `reason`
    discriminates `notFound` / `http` / `integrityMismatch` / `extractFailed`. It is
    **scoped** — the temp directory goes when the calling scope closes — which deleted
    this repo's `mkdtemp` / `rmSync` / `Effect.ensuring` bookkeeping outright.
    - It was harvested **out of this action** and keeps two properties this repo had
      already paid for: integrity is verified **before** extraction (a poisoned CDN
      edge, proxy or mirror must never reach `tar` or `import()`), and a non-2xx
      response is caught before anything is piped to disk, because otherwise a 404
      body reaches `tar` and surfaces as a misleading "failed to extract".
    - Its layer requires `FileSystem | Crypto | HttpClient | ChildProcessSpawner`, and
      **all four are `ActionServices` members here** (`Crypto` arrives via
      `NodeServices`), so it is built bare in `makeAppLayer` like `NpmRegistry` and its
      requirements stay in the channel.
    - **`tar` still shells out, and that is a tier constraint rather than a
      preference:** a bundled tarball reader would make `@effected/npm` an *integrated*
      package, which propagates to `@effected/lockfiles`, which is pure. The cost lands
      on non-runner consumers, who now need a spawner **and** the binary.
  - **The corepack pin vocabulary, adopted at `0.11.0` (issue #290).**
    `CorepackIntegrityHash.fromSri` converts npm's `sha512-<base64>` to corepack's
    `sha512.<hex>`, failing typed with `InvalidSriIntegrityHashError` on a non-sha512
    algorithm, non-canonical base64, a digest that is not 64 bytes, and
    already-corepack input (one-way by design); one layer of JSON quotes is
    tolerated. `PackageManagerPin` (`.parseResult` / `.parse` / `.FromString`) is
    the `<name>@<version>[+<integrity>]` grammar, where the first `+` after the
    version always begins the integrity — so a pin's version can never carry
    semver build metadata. Both replaced local implementations in
    `PackageManagerUpgrade`; the SRI converter's replacement was **motivated by
    this repo's copy** (effected#281 cites it as the consumer evidence).
    - Note the deliberate split with `@effected/package-json`'s `PackageManager`,
      which parses the identical grammar but accepts any `[a-z]+` name because a
      *field model* reads manifests it did not write. `PackageManagerPin`'s name
      set is closed to the four the kit provisions. This action upgrades a
      manager it has already detected, so the closed set is the right one and the
      `pin.name !== pm` check is explicit rather than implied by parsing.
- `@effected/workspaces` — Effect-native workspace layer, consumed by `RegularDeps`,
  `PeerSync`, `Lockfile`, `CatalogConfigDeps` and `detectPackageManager`. **Root-bound at
  layer build:** the layers are static factories on the service classes
  (`WorkspaceRoot.layer`, `WorkspaceDiscovery.layer(opts?)`, `PackageManagerDetector.layer`,
  `LockfileReader.layer(opts?)`) that bind the workspace root when the layer is built, so
  the methods are **arg-less**.
  - `WorkspaceDiscovery` — `listPackages()` and `importerMap()` (keyed by importer path
    relative to the root, `.` for the root workspace). Companion `WorkspaceDiscoveryShape`.
  - `WorkspaceRoot` — `find(cwd)`.
  - `PackageManagerDetector` — `detect(root)`, returning name + optional version. Stricter
    than the old `workspaces-effect`: a bun or pnpm repo is recognized from its **lockfile
    conjoined with the manifest**, not from `devEngines.packageManager` alone. A repo
    naming a package manager only in `devEngines` with no lockfile is detected as npm.
  - `LockfileReader` — used by `CatalogConfigDeps` to read what was actually installed last
    run, which is the merge base for its three-way catalog merge.
  - `WorkspaceSnapshots` / `WorkspaceStateSnapshot` — point-in-time snapshots of a git ref.
    Not consumed by this action's own code; they are how silk's `DepsRegen` reads each side
    of the dependency diff. `resolveIn(importerPath, dependency, specifier)` is the
    importer-scoped resolver DepsRegen uses (the workspace-wide `resolve` abstains whenever
    two importers disagree, which in a multi-package repo yields no row at all).
- `@savvy-web/silk-effects` — shared silk changeset services and the **source of truth**
  for the dependency-changeset step via `Changesets.DepsRegen`. The v5 major is the
  github-split fallout: its tag, tool-discovery, managed-section and changesets-markdown
  families moved into the kit. **The `Changesets` / `DepsRegen` surface this repo consumes
  is unchanged** across that major (the `changeset-emission.int.test.ts` drift canary is
  green). Its embedded changesets engine still tracks the @changesets v3 `next` prereleases
  (`@changesets/apply-release-plan@8-next` etc. — the engine that writes the
  `@changesets/config@4` `$schema` into `.changeset/config.json`). Consumed surface:
  - `Changesets.DepsRegen` — `plan({ cwd, base })` + `execute(plan)` over the cumulative
    `merge-base(base) → worktree` dependency diff, consolidating stale pure-dependency
    changesets into one current table per package. Gating (versionable-minus-ignored)
    lives inside it. `plan` refreshes workspace discovery first, so it sees manifests
    edited earlier in the same run (the fix for the silent zero-changeset bug).
  - `Changesets.DepsRegenDefault` — the batteries-included Layer bundling
    `PointInTimeWorkspace`, `ConfigInspector`, `WorkspaceDiscovery`, silk's adaptive
    `PublishabilityDetector` and `ChangesetConfig`, leaving only platform services to
    satisfy.
  - `Changesets.serializeDependencyTableToMarkdown` — reconstructs a `## Dependencies`
    table from a diff's rows for the PR body / summary without re-reading disk.
  - **Literal table cells:** cell text is emitted verbatim (only `|` and `\` escaped), so a
    `~0.2.0` specifier stays `~0.2.0` and an underscored package name stays intact.
- `@effected/runtimes` — Effect-native resolver for node/deno/bun runtime versions,
  consumed by `RuntimeUpgrade`. Per-runtime services (`NodeResolver`, `DenoResolver`,
  `BunResolver`), each its own layer factory: `*.layerOffline` (bundled snapshot, no
  network or auth — the default), `*.layer` (live, falling back to the snapshot on any
  failure) and `*.layerFresh`. `resolve({ range })` returns a `ResolvedVersions` whose
  `.latest` is the target. The live path also exports a `GitHubClient.layerDefault`
  (pre-wiring auth + `FetchHttpClient`) for the Bun/Deno GitHub-release fetchers. Both the
  snapshot and the live API **exclude end-of-life major lines** — resolving an EOL line
  returns `VersionNotFoundError` and the runtime is skipped with a warning.
- `@effected/semver` — semver parsing/comparison. Used via `parseValidSemVer` in
  `services/peer-sync.ts` and `Range.parse` in `program.ts` for validating explicit-range
  `upgrade-runtime-*` / `upgrade-package-manager` values, plus `Range.maxSatisfying` and
  `SemVer.parse` in `utils/semver.ts`.
  - **Historical note, now resolved:** these static parsers used to be attached by
    post-class assignment (`Range.parse = parseRange`), which the bundler tree-shook out
    of `dist` under `"sideEffects": false`, producing `Range.parse is not a function` at
    runtime — so the action deliberately called the standalone functions instead. As of
    `@effected/semver@0.3.2` they are **in-class static fields**
    (`static parse = Effect.fn("Range.parse")(...)`, `Range.js:111` / `SemVer.js:171`), so
    the hazard is gone and the static form is the correct one to call.
- `@effected/lockfiles` — package-manager-agnostic lockfile parser and model.
  `Lockfile.parse(content, { format })` is a **pure** parser (no memoized reader service), so
  a "before" and an "after" snapshot can be parsed in the same process; it normalizes
  `pnpm-lock.yaml`, `bun.lock` and `package-lock.json` into one `Lockfile` model. Consumed
  types: `Lockfile`, `LockfileImporter`, `ImporterDependency` (its `.specifier` is a decoded
  `ClassifiedSpecifier` — read `.specifier.raw`), `ResolvedPackage`, and the PM-specific
  extension union tagged via `.extension._tag`. `Lockfile.format` records which package
  manager wrote the file.
  - **`0.6.2` shipped two edge-resolution fixes this repo's peer gate motivated**
    (upstream effected#453, dogfooded here before release). Under ≤0.6.1 two
    legitimate pnpm lockfile shapes landed in `ResolvedPackage.unresolvedEdges`,
    which flipped `PeerCheck` to `unverified ("unresolvedEdge")` and withheld
    auto-merge from clean repos (live: spencerbeggs/type-registry-effect#122):
    **npm-alias dependencies** (pnpm records the referenced instance's key as
    the version, so the bare `name@version` composition matched nothing) and
    **`publishDirectory` `link:` edges in snapshot bodies** (no `workspace:`
    specifier exists there; the fix reads the importer's own `publishDirectory`
    declaration as exact evidence). Both shapes are pinned locally by drift
    canaries over real pnpm 11.22.0 fixtures — see @./08-testing.md — so a kit
    regression fails this suite rather than resurfacing as withheld auto-merge
    in a consumer's repository.
- **`WorkspaceCatalogs` (introduced in `@effected/workspaces@0.10.0`) now owns release-age
  discovery.** `releaseAgeGate()` combines the inline `pnpm-workspace.yaml` keys
  with the replayed config-dependency hooks; `src/services/release-age.ts` keeps
  only the fail-open wrapper and the filtering. The layer **must** be
  `layerWithConfigDependenciesSubprocess` — the in-process variant's computed
  dynamic `import()` is what rspack miscompiles into a context module, and that
  is the sole reason this adoption waited on a release. `@effected/workspaces`
  itself depends on `@effected/commands`, so `Run.jsonLine` (the framing its replay
  child uses) arrives with it and needs no manual alignment — a standing property of
  the dependency, not of the version pair that happened to be installed when this was
  written.
  - **The assembly is memoized, and `0.17.0` added `refresh()` as the explicit
    boundary for a tool that mutates the workspace mid-run** — which this action
    is. Release-age discovery deliberately reads the *before*-state; the
    post-install peer check needs the *after*-state, so `steps/peer-check.ts`
    calls `refresh()` before its rules read (an enabled run replays the hook
    subprocess twice, deliberately). The `^0.16.0` → `^0.17.0` range bump was a
    **hand-edit**, per the caret trap below. Detail and the live failure that
    forced it in @./05-module-library.md.
  - **`Run.jsonLine` was evaluated and is SUBSUMED, not skipped.** It was the
    intended replacement for this repo's local `REPLAY_SENTINEL` framing — but
    `releaseAgeGate()` combines the inline keys *and* the hook replay, so
    adopting it deletes the local subprocess entirely and leaves nothing to
    frame. The kit's own replay child already reads its payload through
    `Run.jsonLine` (`workspaces/index.d.ts` documents the 16 MiB ceiling as
    `Run.jsonLine`'s), so it is adopted transitively. Do not re-propose calling
    it directly; there is no call site.
  - **The caret trap, recorded because it fails silently:** caret pins the minor
    on `0.x`, so `^0.9.5` will not accept `0.10.0` and `^0.2.1` will not accept
    `0.3.0` — and `pnpm install` **succeeds** in that state, resolving the old
    version with no error and no warning, so the code fails only at runtime.
    Verify with `pnpm why` or by reading `node_modules/<pkg>/package.json`;
    **never** the install's exit code.
- `@effected/yaml` — parse and stringify `pnpm-workspace.yaml` with consistent formatting.
  `Yaml.parse` / `Yaml.stringify` return Effects (rather than throwing like the `yaml` npm
  package), so `workspace-yaml.ts` yields them and maps failures into `FileSystemError`.
- **`@effected/package-json` — adopted for `PackageJsonFile.modify` and
  `resolveEntryPoint`.** The second is newer (effected#282) and does not disturb the
  ruling below: it is a **pure, IO-free** function over a plain `{ exports?, main? }`
  object, so it never touches the decode path the ruling is about. It returns a
  `Result` whose failure discriminates `noRootExport` / `noConditionMatched` /
  `unsupportedExportsForm`, which is what lets `module-catalogs.ts` log *which* shape a
  consumer's plugin had rather than "could not resolve an entry point".
  - **It is deliberately stricter than the implementation it replaced, and that is a
    behavior change with a consumer-visible edge.** This repo's resolver fell through to
    `main`, then `index.js`, when `exports` was present and nothing matched; the kit
    returns a typed failure. Node's rule is that `exports` **encapsulates** a package, so
    the lenient reading resolved a file the package deliberately does not export — which
    then loads and behaves plausibly rather than failing. Measured against the config
    dependencies this repo actually consumes, the divergence is **unreachable**:
    `@effected/pnpm-plugin-effect@0.6.4` and `@savvy-web/pnpm-plugin-silk@0.29.1` both
    declare a `"."` conditions map carrying `import` **and** `default`, and **neither
    declares `main` at all**, so the fallback could never have fired for them. The
    exposure that remains is unbounded in principle and narrow in practice: this action
    loads whatever config dependency a *consumer* names, and a `require`-only package
    shipping a `main` now resolves to nothing where it used to resolve.

- **`@effected/package-json` — the `PackageJsonFile.modify` ruling.** `modify(path, edits)` applies a list of `PackageFieldEdit`s
  (a JSONC `path` plus a `value`; `value: undefined` deletes) to a manifest on disk in
  one read/edit/write pass, preserving **every byte outside the edited span** — key
  order, indentation, line endings, trailing newline — and skipping the write entirely
  when the result would be byte-identical. `RuntimeUpgrade` and
  `PackageManagerUpgrade` both use it; both still read with `readFileSync` +
  `JSON.parse` and decide from the parsed object.
  - **The schema-decoding surface is deliberately unused.** `Package.decode` requires
    `name` and a strict-semver `version`, so it rejects the private workspace root this
    action must edit. `0.9.0` also shipped `PackageManifest`, a presence-lenient model
    that *would* accept it — it is unadopted because the read only feeds a decision and
    a typed field buys nothing there, not because it is unusable. This whole package was
    **declined outright** until `0.9.0` — and that ruling was **narrowed to this one
    decode-free member, not overturned**: the objection in the sentence above is the
    ruling's own central objection, still standing and still governing everything except
    `modify`. What changed upstream, and what the adoption cost, are in
    @./09-project-status.md.
  - **Adopting it into a second consumer is a layer-wiring change.** Both services
    resolve `PackageJsonFile` in their *layer bodies*, so `makeAppLayer` must provide it
    to each. Providing it to only one is **not** a type error — see the `Action.run`
    hole in @./06-effect-patterns.md — and shipped as a total production outage in
    v4.6.0.

### Duplicate resolutions — recurring, caught each time by `pnpm why`

**Current state, measured 2026-09-04:** every one of the **twelve** installed
`@effected/*` packages — `npm`, `github`, `github-actions`, `workspaces`,
`lockfiles`, `runtimes`, `semver`, `yaml`, `commands`, `git`, `package-json`,
`schemastore` — resolves **exactly one copy**, as does `effect`. Measured by
running `pnpm why` on each and reading its trailing `Found N version` line, not
by inspecting the lockfile.

**The `@effected/workspaces` duplicate is therefore closed, and HOW it closed is
the part worth carrying.** The superseded text is preserved rather than
overwritten, because its measurement was right and its forecast was wrong:

> **`@effected/workspaces` resolves two** — `0.17.0` pulled by this action
> directly, `0.16.0` pulled by `@savvy-web/silk-effects@6.0.4` (whose `^0.16.0`
> the `0.x` caret pins to the old minor) and by dev tooling. … It dedupes when
> silk-effects bumps its range; until then this is a dated measurement carrying
> a real (bundle-size) cost and a latent hazard, not a closed state.

It did **not** dedupe by silk-effects bumping a direct range. `silk-effects`
declares `@effected/workspaces` as a **peerDependency** now, not a dependency —
and a peer range the consumer already satisfies is structurally incapable of
producing a second copy, where a direct `0.x` caret one minor behind necessarily
produces one. So the forecast named the right outcome by the wrong route, which
matters because the wrong route was something to *wait* for and the right one was
a decision somebody upstream had to make. *Re-derive with* `pnpm why
@effected/workspaces` (silk-effects appears as a dependent, so its absence is
**not** the tell) against
`node -p "require('./node_modules/@savvy-web/silk-effects/package.json').peerDependencies"`.

**The bundle probe agrees, and its method is the load-bearing half.** The
fully-qualified tag ids `@effected/workspaces/WorkspaceCatalogs`,
`…/WorkspaceDiscovery` and `…/WorkspaceRoot` each occur **once** in the minified
`dist/main.js`, where each occurred twice, matching the single-copy controls
`@effected/npm/NpmRegistry` and `@effected/github/GitBranch` (also 1).

**Grep the bare class names instead and you get 7, 15 and 4** — method names,
log strings, re-exports — which reads as three duplicates that do not exist.
The tag id is the only string that appears exactly once per class declaration.
An occurrence count over minified output is still an inference rather than a
module-graph dump; what makes it usable is that the controls are measured in the
same run and land on 1.

```text
$ pnpm why @effected/workspaces
Found 1 version of @effected/workspaces
```

**This recurs at every kit bump; it is not a closed issue.** The
`@effected/github` instance below is worth the detail because the obvious reading
of it was **wrong**, and the wrong reading survived a full documentation pass
before an experiment killed it. (It was "the most recent instance" when written
and no longer is — the workspaces recurrence above came later. A doc that says
"most recent" acquires an obligation nobody honours.)

Moving `@effected/npm` to `^0.11.0` also required `@effected/github-actions@0.9.1`,
which depends on `@effected/github@0.7.0`. This repo's own `^0.6.0` was still
**satisfiable**, so `pnpm` had no reason to move it — and two copies of
`@effected/github` resolved, while `__test__/unit/layers/app.test.ts` reported
`Type 'boolean' is not assignable to type 'GitHubClient'`. Duplicate present,
type error present, one obviously explaining the other. **It did not.**

The isolating experiment — revert the range, install, typecheck, twice:

| `@effected/github` | copies | `tsc` |
| --- | --- | --- |
| `0.6.0` + `0.7.0` (via `github-actions`) | 2 | **fails** on `GitHubClient` |
| `0.6.1` + `0.7.0` | 2 | **clean** |

Same duplication, opposite results, so duplication is not the variable. What
changed in `0.6.1` was `@octokit/types` `^16` → `^17` and
`@octokit/plugin-paginate-rest` `^14` → `^15`. `GitHubClient`'s type **embeds
octokit's types**, so at `0.6.0` the client `GitHubToken.clientLayer()` produced
was structurally incompatible with the one the resource layers required —
`0.7.0` being a pure refactor, it agrees with `0.6.1`. The lockfile was holding
`0.6.0` because a caret range that is already satisfied is a range `pnpm` never
revisits.

So the actual rule is narrower and more useful than "duplicates break the
build": **a duplicate is harmless while the copies' shapes agree, and a stale
transitive dependency inside one copy is what makes them disagree.** The fix was
therefore *getting off `0.6.0`*, which `^0.6.1` would also have done; moving to
`^0.7.0` was the right call anyway, because this repo keeps one copy of each kit
package for the bundling reason below.

Two things worth carrying forward. **After any kit bump, run `pnpm why` on every
kit package rather than only the one named in the changeset** — the range that
needs moving is frequently not the one you bumped. And **a leftover requirement
in the guard is a symptom with more than one cause**: a missing `Layer.provide`,
a duplicate, or — as here — a single copy whose shape has drifted from what its
peers were built against. The guard names the *type*, never the reason.

**What the beta.107 wave closed.** An earlier duplicate was real and *was* being
bundled: `@savvy-web/silk-effects@5.3.0` declared `^0.9.5` while this action had moved to
`^0.10.0`, and caret pins the minor on `0.x`, so the two ranges could not dedupe and two
copies of the workspaces kit were inlined into `dist/main.js`. `silk-effects@5.5.2` moved
onto the same wave, so the ranges agreed and the second copy was gone — **until it
recurred in 2026-08**, this time with this repo moving first (`^0.17.0` for
`refresh()`) while `silk-effects@6.0.4` stays on `^0.16.0`; see the current-state
measurement at the top of this section. The sentence is left as written because
it was true when written; what it teaches is that "the ranges now agree" is a
statement with a date on it.

**And that recurrence has now closed too, differently** (2026-09-04, top of this
section) — by silk-effects moving the dependency to a **peer**, which removes
the ability to duplicate rather than restoring agreement between two ranges. So
the same visible symptom has been fixed by two mechanisms with different
durability: "the ranges agree today" lasts until either side moves, whereas
"there is only one range" lasts until the peer declaration changes. Worth
distinguishing when reading a future green measurement — **the interesting
question is not whether the count is 1, it is which of those two states
produced it.**

The old entry's limit-statement is worth preserving as reasoning, because it is what made
this worth tracking rather than shrugging at: Effect resolves services by the tag's **string
id**, so a layer built from either copy satisfies a requirement from the other — safe *while
the shapes agree*, but not safe by construction, since a version-gated member (as
`WorkspaceCatalogs` was at `0.10.0`) exists on one copy and not the other, and a divergence
in a shared tag's shape would typecheck against one copy and fail at runtime against the
other.

**That limit-statement predicted the `@effected/github` incident exactly, and is
the sentence a correction had to be built back toward.** "Safe *while the shapes
agree*" is the whole of it: two copies at `0.6.1` and `0.7.0` agree and
typecheck; `0.6.0` and `0.7.0` do not, because an octokit major moved underneath
one of them. The paragraph that briefly stood here said the opposite — that
TypeScript types are *nominal per copy*, so any duplication meeting in one
signature is a compile error. That is false, and the table above is what
falsified it.

Worth recording as a shape rather than an erratum: **the wrong version was
written while the correct one was still on the page, four paragraphs up.** It
was not contradicted by new evidence — it was contradicted by this document,
already, and nobody read down that far before writing. Checking a claim against
the file it is being added to costs one search and would have caught it.

*Verify with* `pnpm why <pkg>` — **not** with a lockfile grep. The grep reports *which*
versions exist; only `pnpm why` reports *who pulls each one*, and provenance is the whole
question. An earlier version of this section was updated to new version numbers while
keeping the sentence "resolves exactly one copy of each," which was false at the moment it
was written — the numbers were refreshed and the claim they supported was not re-checked.
That trap applies to this rewrite too: the single-copy claim above is only as good as the
last `pnpm why` run against the current lockfile.

## Build tooling

- `@savvy-web/github-action-builder` (dev) — rspack-based bundler that derives the
  pre/main/post entries from `action.config.ts` and inlines every runtime dependency into
  `dist/{pre,main,post}.js`. As of v2.1 it **minifies unconditionally** and folds license
  banners inline, so the committed `dist` carries attribution again. Current output:
  ~1.3 MB minified (`dist/main.js`; `pre` and `post` are ~279 KB each).
- `@savvy-web/silk` (dev) — silk tooling (commit/changeset conventions).
- `@effect/vitest` (dev) — reads **`catalog:effect`**, the same catalog entry as `effect`
  itself, so both resolve to the same prerelease by construction. No literal here: naming
  it is what the lockstep exists to make unnecessary. The required lockstep is therefore
  structural rather than remembered: it used to be an exact literal that had to be
  hand-bumped alongside every catalog advance, and a missed bump left the test framework a
  beta behind the runtime it was testing. See @./08-testing.md.
- `@effected/schemastore` (dev) — builds, lints, gates and
  writes the JSON Schema for the `result` output. `lib/scripts/generate-schema.ts` hands it a
  `SchemaTarget` and `SchemaPipeline.run` does the rest: structural lint, the shipped ajv
  strict-mode gate, and a write **only when the document's content differs** — so a formatter
  reflowing the generated file does not provoke a rewrite, and the artifact needs no formatter
  carve-out. The package deliberately never logs; the script supplies the wording. Consumed
  only at build time and **not** bundled into `dist`. See @./03-type-definitions.md.
- `tsx` (dev) — runs the schema generator (`pnpm generate-schema`).

### `action.config.ts` notes

- **`build.ignore` is GONE — the "vestigial" loose end is closed, not still
  pending.** It listed `xmlbuilder2`, `libxmljs2` and `ajv-formats-draft2019`, the
  optional XML/JSON-validator plugins of `@cyclonedx/cyclonedx-library`, which came in
  transitively **through `@savvy-web/github-action-effects`**. That package is deleted,
  and cyclonedx now has **zero occurrences in `pnpm-lock.yaml`** (`grep -c cyclonedx
  pnpm-lock.yaml` → `0`), so the three entries were aliasing packages that are not in
  the graph. The key is removed from `action.config.ts` along with the comment that
  still described the old provenance.
  - **The confirming evidence is a rebuild, not the argument.** "Ignoring a package
    that is not in the graph is a no-op" is a claim about rspack, and this record's own
    standard is that a plausible claim is not a measurement: rebuilding without the key
    changed `dist/main.js` only by minifier variable renaming, which is what proves the
    entries were genuinely inert rather than merely believed to be. That the removal was
    *safe* and that the entries were *doing nothing* are two different statements, and
    the diff is what carries the second one.
  - Recorded rather than deleted because the shape recurs: a `build.ignore` entry
    naming a package that has left the graph is invisible — nothing fails, nothing
    warns, and the comment explaining it keeps reading as current. *Falsified if* a
    future dependency reintroduces cyclonedx, at which point the question is whether
    the action invokes its optional plugins, not whether these three names should
    return by reflex.
- **`build.nativeDynamicImports`** lists `@changesets/apply-release-plan` only. The
  changesets v3 engine loads the configured changelog module via a fully dynamic
  `await import(changelogPath)`; without this, rspack compiles it into a context module and
  the action throws `Cannot find module 'file:///…'` at runtime.
  `@effected/workspaces`' `ConfigDependencyHooks` loader has the same computed-import
  pattern and IS reachable in this bundle, but is deliberately **not** listed — registering
  it makes the builder's ignore-loader throw and fails the build.
  - **The "benign Critical dependency warning" this bullet described is gone, and
    the reason it was tolerable was also wrong.** It read: *"rspack emits a benign
    'Critical dependency' warning instead, inert unless the config-dependency-hooks
    path runs, which this action never does."* Both halves have to be corrected
    separately.
  - *On the warning:* upstream fixed it. `ConfigDependencyHooks`' in-process
    loader carries its own inline `/* webpackIgnore: true */` as of
    `@effected/workspaces@0.13.0` (spencerbeggs/effected#242) — a claim about a
    release, and re-derived here against the installed copy by finding the marker
    on the `import(candidateUrl)` site in
    `node_modules/@effected/workspaces/ConfigDependencyHooks.js`. That the warning
    is consequently **absent from a build** follows, but was **not** re-run in
    this pass — stated as unverified rather than asserted.
  - *On "this action never does":* it very much does. Release-age discovery and
    the `check-peers` rules read both replay config-dependency hooks, twice per
    enabled run. What is true is narrower: this action wires
    `layerWithConfigDependenciesSubprocess`, whose computed import lives inside a
    **static** `REPLAY_SCRIPT` string handed to `node -e`, so the bundler never
    sees it as an import at all. The *in-process* loader is the one that is never
    reached — which is a fact about the layer choice, not about the feature.
  - Either way the standing instruction is unchanged: if a "Critical dependency"
    warning naming `ConfigDependencyHooks.js` ever returns, the fix is upstream,
    not an entry in this list.
- **A third case, in first-party source:** `src/services/module-catalogs.ts` dynamically
  imports a config dependency's extracted tarball entry — a path computed at runtime, not a
  package specifier. **This is the one part of that module that did NOT move upstream**
  (effected#282), and the magic comment is why: a kit-level loader would hand the same
  context-module problem to every bundling consumer with no seam to fix it, so
  `@effected/npm` extracts and `@effected/package-json` resolves, while loading stays here.

  `nativeDynamicImports` only matches resolved paths under
  `node_modules/<name>/`, so it structurally cannot target `src/`. That call site carries an
  inline `/* webpackIgnore: true */` comment instead, and `build:prod` runs
  `scripts/assert-native-dynamic-import.mjs` afterwards to assert the built `dist/main.js`
  still holds a genuine `await import(<ident>)` there. Deleting the magic comment fails the
  build — which matters because a context-module rewrite only breaks in production (vitest
  runs the source, not the bundle).
- **`persistLocal.enabled` is `false`, deliberately, against canon B6** — and the
  comment saying so is the change; the flag itself did not move. Persisting writes a
  byte-for-byte copy of `dist/*` into `.github/actions/local`, so it roughly **doubles**
  what every consumer downloads on every run (committed `dist` is 2,080,144 bytes —
  `cat dist/*.js | wc -c`) to serve an `act` loop this repo does not run. The
  scaffolding that would have consumed it (`.actrc`, `.github/workflows/act-test.yml`)
  is **deleted**, not fed: that workflow did `uses: ./.github/actions/local`, a path
  that never existed here. Full reasoning and the revisit condition are the settled
  decision in @./09-project-status.md.
