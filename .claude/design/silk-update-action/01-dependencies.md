---
status: current
module: silk-update-action
category: architecture
created: 2026-02-20
updated: 2026-07-26
last-synced: 2026-07-26
completeness: 95
related:
  - ./_index.md
dependencies: []
implementation-plans: []
---

# Dependencies

[Back to index](./_index.md)

## Runtime Dependencies (bundled into action)

The authoritative dependency list and ranges live in the `dependencies` block of `package.json` — this doc does not mirror them. Every runtime dependency is inlined into `dist/{pre,main,post}.js` at build time; the packages whose behavior is load-bearing for this action are described below.

The action runs on **Effect v4** (`effect` / `@effect/platform-node` both resolved from the `catalog:effect` catalog — a `4.0.0-beta` pin; see the lockfile for the current beta). Effect v4 renamed several APIs the code and the notes below use: services are class-based `Context.Service` (was `Context.Tag`); the Node platform bundle is `NodeServices.layer` (was `NodeContext.layer`); `FileSystem`/`Path` import from `effect` directly, `HttpClient`/`FetchHttpClient` from `effect/unstable/http` and `ChildProcess`/`ChildProcessSpawner` from `effect/unstable/process` (the old `@effect/platform` package is dissolved into core `effect`); `Config.int` (was `Config.integer` — though this action reads integers via `ActionInput.integer`, not `Config`); `Effect.catch` (was `Effect.catchAll`); `Effect.result` returning a `Result` (was `Effect.either`); `Effect.timeoutOrElse` (was `Effect.timeoutFail`); and log levels are string literals (`"Info"` / `"Debug"` / `"Warn"`), set via `References.MinimumLogLevel`.

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
  - **`Run.text` trims.** That silently corrupts column-aligned output: `git status
    --porcelain`'s two-character status field means a leading space (`" M path"`) is
    load-bearing, and trimming shifts every subsequent `substring` index by one. Code
    reading such output uses `Run.collect` and checks `succeeded` itself (see the `gitRaw`
    helper in `src/services/branch.ts`).
- `@effect/platform-node` — Node platform bundle (`NodeServices.layer`), providing
  FileSystem, Path and **ChildProcessSpawner** (the seam `Run` needs). Provided by
  `Action.run`'s runtime at the platform level and also pulled in directly by
  `makeAppLayer` for the root-bound `@effected/workspaces` layers.
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
- `@effected/yaml` — parse and stringify `pnpm-workspace.yaml` with consistent formatting.
  `Yaml.parse` / `Yaml.stringify` return Effects (rather than throwing like the `yaml` npm
  package), so `workspace-yaml.ts` yields them and maps failures into `FileSystemError`.

### Duplicate resolutions

Two copies each of `@effected/workspaces` (`0.9.0` and `0.8.0`) and `@effected/npm`
(`0.5.0` and `0.4.0`) resolve. The lower copy of each comes **entirely** from the
`@vitest-agent/plugin` devDependency tree and never reaches the shipped artifact; it clears
when that plugin bumps. Effect resolves services by the tag's string id, so even a genuine
duplicate would share one provided layer — the concern is bundle size, not correctness.

## Build tooling

- `@savvy-web/github-action-builder` (dev) — rspack-based bundler that derives the
  pre/main/post entries from `action.config.ts` and inlines every runtime dependency into
  `dist/{pre,main,post}.js`. As of v2.1 it **minifies unconditionally** and folds license
  banners inline, so the committed `dist` carries attribution again. Current output:
  ~1.18 MB minified.
- `@savvy-web/silk` (dev) — silk tooling (commit/changeset conventions).
- `@effect/vitest` (dev) — pinned **exactly** to the same beta as `effect`
  (`4.0.0-beta.101`) and must move in lockstep with it. See @./08-testing.md.

### `action.config.ts` notes

- **`build.ignore`** lists `xmlbuilder2`, `libxmljs2` and `ajv-formats-draft2019` — the
  optional XML/JSON-validator plugins of `@cyclonedx/cyclonedx-library`. That library came
  in transitively **through `@savvy-web/github-action-effects`**, which is now deleted:
  cyclonedx no longer appears in the lockfile at all, so these three entries are currently
  **vestigial**. They are harmless (ignoring a package that is not in the graph is a no-op)
  and the comment in `action.config.ts` still describes the old provenance.
- **`build.nativeDynamicImports`** lists `@changesets/apply-release-plan` only. The
  changesets v3 engine loads the configured changelog module via a fully dynamic
  `await import(changelogPath)`; without this, rspack compiles it into a context module and
  the action throws `Cannot find module 'file:///…'` at runtime.
  `@effected/workspaces`' `ConfigDependencyHooks` loader has the same computed-import
  pattern and IS reachable in this bundle, but is deliberately **not** listed — registering
  it makes the builder's ignore-loader throw and fails the build. rspack emits a benign
  "Critical dependency" warning instead, inert unless the config-dependency-hooks path runs,
  which this action never does.
- **A third case, in first-party source:** `src/services/module-catalogs.ts` dynamically
  imports a config dependency's extracted tarball entry — a path computed at runtime, not a
  package specifier. `nativeDynamicImports` only matches resolved paths under
  `node_modules/<name>/`, so it structurally cannot target `src/`. That call site carries an
  inline `/* webpackIgnore: true */` comment instead, and `build:prod` runs
  `scripts/assert-native-dynamic-import.mjs` afterwards to assert the built `dist/main.js`
  still holds a genuine `await import(<ident>)` there. Deleting the magic comment fails the
  build — which matters because a context-module rewrite only breaks in production (vitest
  runs the source, not the bundle).
