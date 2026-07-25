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

# Dependencies

[Back to index](./_index.md)

## Runtime Dependencies (bundled into action)

The authoritative dependency list and ranges live in the `dependencies` block of `package.json` — this doc does not mirror them. Every runtime dependency is inlined into `dist/{pre,main,post}.js` at build time; the packages whose behavior is load-bearing for this action are described below.

The action runs on **Effect v4** (`effect` / `@effect/platform-node` both resolved from the `catalog:effect` catalog — a `4.0.0-beta` pin; see the lockfile for the current beta). The first-party libraries are the v4-line `@effected/*` kit (`@effected/workspaces`, `@effected/runtimes`, `@effected/semver`, `@effected/lockfiles`, `@effected/npm`, `@effected/yaml`) plus `@savvy-web/*` v4-line packages. Effect v4 renamed several APIs the code and the notes below use: services are class-based `Context.Service` (was `Context.Tag`); the Node platform bundle is `NodeServices.layer` (was `NodeContext.layer`); `FileSystem`/`Path` import from `effect` directly and `HttpClient`/`FetchHttpClient` from `effect/unstable/http` (the old `@effect/platform` package is dissolved into core `effect`); `Config.int` (was `Config.integer`); `Effect.catch` (was `Effect.catchAll`); `Effect.result` returning a `Result` (was `Effect.either`); `Effect.timeoutOrElse` (was `Effect.timeoutFail`); and log levels are string literals (`"Info"` / `"Debug"` / `"Warn"`), set via `References.MinimumLogLevel`.

## Key Packages

- `@savvy-web/github-action-effects` - Effect-based services for GitHub Actions.
  Replaces `@actions/*` with a native ESM implementation. v3 is the Effect-v4
  line: its services are `Context.Service` classes that expose a companion
  `*Shape` interface (`NpmRegistryShape`, `WorkspaceDiscoveryShape`, …) for
  typing a resolved service value without yielding it. Provides:
  - **Action plumbing:** `ActionOutputs`, `ActionEnvironment`, `ActionLogger`,
    `ActionState`, `Action.run()`, `CheckRun.withCheckRun()`, `AutoMerge.enable()`
  - **Config API:** `Config.*` from Effect for typed input parsing (replaces `Action.parseInputs()`)
  - **Token lifecycle:** `GitHubToken` namespace — `provision()` (pre),
    `client()` (main), `dispose()` (post) — coordinates one installation
    token across the three phases by persisting its envelope to `ActionState`.
  - **Domain services:** `CommandRunner`, `GitBranch`, `GitCommit`, `GitHubClient`,
    `GitHubGraphQL`, `NpmRegistry`, `PullRequest`, `DryRun`, `GithubMarkdown`
  - **Live layers:** `GitHubAppLive` (requires `OctokitAuthAppLive` **and**
    `HttpClient.HttpClient` — satisfied via `FetchHttpClient.layer`),
    `GitBranchLive`, `GitCommitLive`, `CheckRunLive`, `CommandRunnerLive`,
    `DryRunLive`, `GitHubGraphQLLive`, `OctokitAuthAppLive`, `ActionStateLive`
    (requires `FileSystem.FileSystem`).
  - **`GitHubClient` namespace:** `GitHubClient` is a namespace of layer
    constructors (`fromEnv()`, `fromToken(Redacted)`, `fromApp({ clientId,
    privateKey, installationId? })`), not a bare `GitHubClientLive`. This
    action builds its `GitHubClient` from `GitHubToken.client()`, which reads
    the envelope the pre phase persisted to `ActionState`.
  - **Build note (transitive cyclonedx):** the library pulls in
    `@cyclonedx/cyclonedx-library`, whose optional XML/JSON-validator plugins
    (`xmlbuilder2`, `libxmljs2`, `ajv-formats-draft2019`) the action never
    invokes. `action.config.ts` lists them under `build.ignore` (aliased to a
    throwing stub that cyclonedx's `_optPlug` wrapper catches) so the bundle
    builds without them.
- `@effect/platform-node` - Node platform bundle for `Command` (shell
  execution) and FileSystem/Path/ChildProcessSpawner. In Effect v4 the platform
  bundle is `NodeServices.layer` (the old `NodeContext.layer`), provided by the
  library's `Action.run()` pipeline at the platform level. `makeAppLayer` also
  pulls `NodeServices.layer` in directly to satisfy the root-bound
  `WorkspaceDiscovery.layer()` / `WorkspaceRoot.layer` from `@effected/workspaces`,
  which require FileSystem/Path to read workspace manifests. (The old
  `@effect/platform` package is gone — `FileSystem`/`Path` now live in core
  `effect`, and `HttpClient`/`FetchHttpClient` in `effect/unstable/http`.)
- `effect` (`catalog:effect`) - Typed error handling, retry logic, resource management, plus `FileSystem`/`Path` and (under `effect/unstable/http`) `HttpClient`/`FetchHttpClient`.
- `@effected/runtimes` - Effect-native resolver for node/deno/bun runtime versions. Consumed by the `RuntimeUpgrade` service (`src/services/runtime-upgrade.ts`). Provides runtime-specific services (`NodeResolver`, `DenoResolver`, `BunResolver`), each of which is its own layer factory: `*.layerOffline` (bundled offline snapshot, no network or authentication — the default), `*.layer` (live: fetches current data and falls back to the bundled snapshot on any failure), and `*.layerFresh`. `resolve({ range })` returns a `ResolvedVersions` whose `.latest` is the target. The live path also exports a `GitHubClient` (`.layerDefault`, pre-wiring auth + `FetchHttpClient`) for the Bun/Deno GitHub-release fetchers. The bundled snapshot and live API both exclude end-of-life major lines — resolution for an EOL line returns a `VersionNotFoundError` and is skipped with a warning.
- `@effected/semver` - Effect-native semver parsing/comparison; used via
  its standalone `parseValidSemVer` in `services/peer-sync.ts` for
  bump-classification under the `peer-minor` strategy, and its standalone
  `Range.parse` (aliased as `parseRange`) directly in `program.ts` for
  validating explicit-range `upgrade-runtime-*` and `upgrade-package-manager`
  input values. The action calls the standalone functions rather than the
  `SemVer.parse` / `Range.parse` static aliases where a static alias would be
  tree-shaken out of the bundled dist (`"sideEffects": false`), causing
  `Range.parse is not a function` at runtime; the standalone functions are the
  bundle-safe, canonical API. (Version resolution in `utils/semver.ts` —
  including the in-range resolution for `ConfigDeps`/`RegularDeps` and
  `configDepUpgradeRange` — uses `SemverResolver` from
  `@savvy-web/github-action-effects`, not `@effected/semver`.)
- `@effected/workspaces` - Effect-native workspace layer. Consumed directly by domain services (`RegularDeps`, `PeerSync`, `Lockfile`) via the `WorkspaceDiscovery` service. `Changesets` no longer consumes it directly — it delegates to silk's `DepsRegen`, which wires its own workspace discovery internally. **Root-bound at layer build:** the layers are static factories on the service classes (`WorkspaceRoot.layer`, `WorkspaceDiscovery.layer(opts?)`, `PackageManagerDetector.layer`, `LockfileReader.layer(opts?)`) that bind the workspace root when the layer is built, so the methods below are **arg-less**. Provides:
  - `WorkspaceDiscovery` service + `WorkspaceDiscovery.layer(opts?)` with
    arg-less `listPackages()` and `importerMap()` methods (companion
    `WorkspaceDiscoveryShape` for typing a resolved instance). `importerMap`
    returns a map keyed by importer path relative to the workspace root (`.`
    for the root workspace).
  - `WorkspaceRoot` service + `WorkspaceRoot.layer` for resolving the
    workspace root from a cwd.
  - `PackageManagerDetector` service + `PackageManagerDetector.layer` — detects
    pnpm/bun/npm. **Behavior note:** detection is stricter than the old
    `workspaces-effect` — a bun or pnpm repo is now recognized from its
    **lockfile conjoined with the manifest**, not from `devEngines.packageManager`
    alone (the rule yarn already used). A repo that names a package manager only
    in `devEngines` with no lockfile is detected as npm.
  - `LockfileReader` service + `LockfileReader.layer(opts?)` (depends on
    `WorkspaceRoot`, `PackageManagerDetector`, `WorkspaceDiscovery`).
  - `WorkspaceSnapshots` / `WorkspaceStateSnapshot` — point-in-time snapshots of a git ref. Not consumed by this action's own code; they are how silk's `DepsRegen` reads each side of the dependency diff, and their catalog behavior decides whether a bump becomes a changeset row. `resolve(dependency, specifier)` and the importer-scoped `resolveIn(importerPath, dependency, specifier)` both resolve a `workspace:` / `catalog:` specifier as of that ref, falling back to the ref's own lockfile importer entries when a `catalog:` specifier appears in no committed catalog source — the case for a catalog injected by a config-dependency pnpmfile hook, which is in neither `pnpm-workspace.yaml` nor the lockfile's `catalogs:` block. The two differ on that fallback: `resolve` abstains (`Option.none()`) whenever two importers disagree on a version, so a diff caller in a multi-package repo must use `resolveIn` to get an answer at all.
- `@savvy-web/silk-effects` - Shared silk changeset services, FileSystem-based (reads via core `effect`'s FileSystem rather than `node:fs`). It is the **source of truth** for the dependency-changeset step via its `Changesets.DepsRegen` service. The v4-line major tracks the Effect-v4 migration; the changesets engine remains the @changesets v3 `next` prereleases (`@changesets/apply-release-plan@8-next`, `get-release-plan@5-next`, `config@4-next` etc. — the engine that writes the `@changesets/config@4` `$schema` into `.changeset/config.json`); the consumed surface below is **unchanged**, so the adapter (`src/services/changesets.ts`) and layer wiring (`src/layers/app.ts`) needed no source changes beyond the v4 layer idioms. The publishability rules and `ChangesetConfig` still live here but are **internal** to `DepsRegen` — the action no longer imports them directly (the former `changeset-config.ts` and `publishability.ts` re-export shims are deleted). **Stale-discovery fix:** `DepsRegen.plan` refreshes workspace discovery at the top of plan — before the ConfigInspector base-branch fallback, the snapshots and the gating reads — so the changeset step sees manifests edited earlier in the same run (the merge-base and worktree snapshots differ instead of every run silently writing 0 changesets). Consumed surface:
  - `Changesets.DepsRegen` service — plans (`plan({ cwd, base })`) and executes
    (`execute(plan)`) the cumulative `merge-base(base) → worktree` dependency
    diff, consolidating stale pure-dependency changesets into one current table
    per package. Gating (versionable-minus-ignored) lives inside it.
  - `Changesets.DepsRegenDefault` — the batteries-included Layer (root-bound at
    build) that bundles `PointInTimeWorkspace`, `ConfigInspector`,
    `WorkspaceDiscovery`, silk's adaptive `PublishabilityDetector` and
    `ChangesetConfig` internally, leaving only platform services
    (FileSystem/Path/CommandExecutor) to satisfy.
  - `Changesets.serializeDependencyTableToMarkdown` — reconstructs a
    `## Dependencies` Markdown table from a diff's rows (used to build the PR
    body / summary without re-reading disk).
  - **Importer-scoped catalog resolution:** the dependency diff resolves every specifier through `@effected/workspaces`' importer-scoped `WorkspaceStateSnapshot.resolveIn` rather than the workspace-wide `resolve`. A `catalog:` specifier whose catalog is injected by a config-dependency pnpmfile hook therefore resolves to a concrete version on each side, and a real movement produces a row instead of both sides comparing the identical raw `catalog:<name>` string. The workspace-wide form abstains whenever two importers disagree on a version, which in a multi-package repo reproduces exactly that no-row outcome.
  - **Literal table cells:** cell text is emitted verbatim — the shared table pipeline marks cell nodes as literal, escaping only `|` and `\`, so a `~0.2.0` specifier stays `~0.2.0` and an underscored package name stays intact rather than being written as `\~0.2.0` / `some\_pkg`. This holds for both the string serializer above and the mdast `Table` the aggregation plugin inserts into a changeset AST.
  - **Build note (dynamic changelog import):** the changesets v3 engine's `@changesets/apply-release-plan` loads the configured changelog module via a fully dynamic `await import(changelogPath)`. `action.config.ts` lists it under `build.nativeDynamicImports` (a github-action-builder option) so rspack preserves a genuine dynamic import in the bundle — without it rspack compiles the import into a context module and the action throws `Cannot find module 'file:///…'` at runtime. `@effected/workspaces` is **not** listed (unlike the old `workspaces-effect`): its `ConfigDependencyHooks` loader has the same computed-import pattern and IS reachable in this bundle, so rspack emits a benign "Critical dependency" warning, but registering it in `nativeDynamicImports` makes the builder's ignore-loader throw on that file and fails the build. The warning is inert unless the config-dependency-hooks path is invoked at runtime, which this action never does. See the comment in `action.config.ts`.
- `@effected/yaml` - Parse and stringify `pnpm-workspace.yaml` with consistent
  formatting. `Yaml.parse` / `Yaml.stringify` return Effects (rather than
  throwing/returning synchronously like the old `yaml` npm package), so
  `workspace-yaml.ts` yields them and maps failures into `FileSystemError`.
- `@effected/npm` - Pure-tier kit package providing the release-age vocabulary consumed by the `ReleaseAge` service (`src/services/release-age.ts`): `ReleaseAgeGate` (a Schema class — static `combine` is variadic/total and combines contributions strictest-wins; static `matchesExclude` implements pnpm's flat-string `*` exclude matching, **not** minimatch; instance `isExcluded` and the pure `filterVersions(versions, times, name, now)` where the caller supplies the clock and missing timestamps drop the version) and `PartialReleaseAgeGate` (the permissive per-source contribution type, re-exported by `release-age.ts`). `@effected/workspaces` and `@effected/lockfiles` resolve the same major internally, so the bundle carries a single copy.
- `@effected/lockfiles` - Package-manager-agnostic lockfile parser and
  model. The parser/model moved here out of `workspaces-effect`. `Lockfile.parse(content, { format })`
  is a **pure** parser (no memoized reader service), so a "before" and an
  "after" snapshot can be parsed in the same process; it normalizes
  `pnpm-lock.yaml`, `bun.lock` and `package-lock.json` into one `Lockfile`
  model. Consumed types: `Lockfile`, `LockfileImporter`, `ImporterDependency`
  (its `.specifier` is a decoded `ClassifiedSpecifier` — read `.specifier.raw`),
  `ResolvedPackage`, and the PM-specific extension union (`PnpmExtension` /
  `BunExtension`, tagged via `.extension._tag`). `Lockfile.format` records which
  package manager wrote the file.

## Build tooling

- `@savvy-web/github-action-builder` (dev) - rspack-based bundler that derives the pre/main/post entries from `action.yml` and inlines every runtime dependency into `dist/{pre,main,post}.js`. Configured via `action.config.ts`.
- `@savvy-web/silk` (dev) - silk tooling (commit/changeset conventions).
