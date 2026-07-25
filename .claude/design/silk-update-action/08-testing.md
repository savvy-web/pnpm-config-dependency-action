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

# Testing Strategy

[Back to index](./_index.md)

## Unit Testing

**Test Framework:** Vitest with v8 coverage, forks pool for Effect-TS compatibility.

Each `.ts` under `src/` has a co-located `.test.ts` sibling. Notable suites:

- **Orchestration** (`program.inner.test.ts`) — drives `innerProgram` directly
  against a fake app layer and asserts on the captured log stream, which is the
  run's decision record. Pins the behavior the rest of the suite cannot see:
  the package-manager dispatch (a bun repo routes config dependencies to
  `CatalogConfigDeps`, a pnpm repo to `ConfigDeps`, an npm repo to neither, with
  a warning that npm has no `catalog:` protocol); the acceptance signal (an
  `upgrade-package-manager` range that satisfies nothing — e.g. a pnpm `^11.0.0`
  in a bun repo — must WARN, while "disabled" and "already current" stay at
  info); the install gate; the pnpm-only workspace-format gate; that every
  skipped step states a reason; and that an unsupported (yarn) workspace fails
  with `ActionInputError` from *inside* the check run, which is completed with
  `failure` rather than bypassed. Package-manager detection is **real** here
  (upstream `WorkspaceRoot` / `PackageManagerDetector` over a temp-dir fixture),
  as is `PackageManagerUpgradeLive` over an in-memory registry, so the
  dispatch and the unsatisfiable-range path are genuinely resolved rather than
  mocked into existence.
- **Entry points** (`main.test.ts`, `main.effect.test.ts`, `pre.test.ts`,
  `post.test.ts`) — orchestration with injected service fakes, input parsing
  and validation, dry-run behavior, and the token lifecycle. The `pre` / `post`
  suites drive the real `GitHubToken.provision` / `dispose` flow against the
  library's in-memory `@savvy-web/github-action-effects/testing` layers
  (`ActionStateTest`, `GitHubAppTest`, `ActionOutputsTest`), covering scope
  provisioning, start-time persistence, duration reporting and
  unconditional token revocation.
- **Schemas and errors** (`schemas/domain.test.ts`, `errors/errors.test.ts`) —
  schema validation for the domain types and error construction, `_tag`
  matching and the `isRetryable` / `getErrorMessage` helpers.
- **Dependency services** (`config-deps.test.ts`, `regular-deps.test.ts`, `peer-sync.test.ts`, `pnpm-upgrade.test.ts`, `runtime-upgrade.test.ts`) — npm-registry querying, range-respecting resolution (RegularDeps resolving within the current specifier's range, ConfigDeps within the synthesized major range, neither jumping to absolute `latest`), multi-section RegularDeps scanning with accurate per-section `type` reporting, `peer-lock`/`peer-minor` range computation, pnpm self-upgrade (driven through the library's in-memory `NpmRegistryTest` layer rather than a fake `CommandRunner`), and per-runtime `devEngines.runtime` rewriting (including `auto` no-op on static pins, the never-add rule — a missing entry is skipped with a warning in *every* mode, the dogfooded bun-only-manifest case included — exact-version write-back with no operator, and per-runtime resolver-failure resilience). `config-deps.test.ts` and `regular-deps.test.ts` default their fixtures to `ReleaseAgeNoop` and each pin one hold-back case through a fake `ReleaseAge` layer.
- **Release-age gate** (`release-age.test.ts`) — the `ReleaseAge` service and its standalone helpers: inline `pnpm-workspace.yaml` discovery, the subprocess hook replay (argv passing, `pnpmfile.mjs`/`.cjs` order, best-effort degradation to null with a warning), publish-time fetching (`npm view … time --json`, best-effort empty on failure), strictest-wins gate combination, exclude matching and the fail-open filtering paths (inert gate, excluded package, missing publish times).
- **Lockfile and changesets** (`lockfile.test.ts`, `changesets.test.ts`) —
  `lockfile.test.ts` covers catalog and importer comparison emitting
  per-importer, per-section triples. `changesets.test.ts` exercises only the
  DepsRegen **adapter plumbing** against a mock `Changesets.DepsRegen`: the
  `.changeset/` guard, the `plan({ cwd, base }) → execute` call, the
  `written → ChangesetFile` mapping and error mapping. The gating cascade,
  catalog-aware diffing and consolidation live upstream and are tested in
  `@savvy-web/silk-effects`.
- **Reporting and formatting** (`report.test.ts`, `workspace-yaml.test.ts`) — PR
  creation/update, commit-message and summary generation, and YAML sorting/round
  -tripping.
- **Pure helpers** (`utils/input.test.ts`, `utils/runtime.test.ts`,
  `utils/semver.test.ts`, `utils/fixtures.test.ts`, `services/branch.test.ts`) —
  multi-value input parsing, `devEngines.runtime` helper functions,
  `configDepUpgradeRange` / range-resolution helpers, shared fixtures, and branch
  lifecycle via the `GitBranch` / `GitCommit` library services (including the
  `ensureBaseHistory` merge-base probe / fetch fallback).

Gating semantics (silk vs vanilla mode, `versionPrivate`/`isIgnored`/`fixed`
plumbing, the publishability rules) live in `@savvy-web/silk-effects` and are
exercised here indirectly through `changeset-emission.int.test.ts` (below),
which doubles as an upstream-drift canary. Workspace discovery is exercised via
`__test__/integration/workspaces.int.test.ts`, which runs `WorkspaceDiscovery.layer()`
against real fixtures.

## Test Patterns

**Importing the program directly:** The `program` Effect lives in
`src/program.ts`, separated from the module-level `Action.run` call in
`src/main.ts`. Tests import `program` and `runCommands` from
`./program.js` without ever evaluating `main.ts`, so no `vi.mock()` of the
library is needed just to suppress module-level execution. (Tests still mock
specific library services via `Layer.succeed` to inject fakes.) `pre` and
`post` are exported from `src/pre.ts` / `src/post.ts` the same way — guarded by
`if (process.env.GITHUB_ACTIONS)` so importing them in tests is side-effect-free.

**Library test layers:** The phase tests use the in-memory layers shipped
under `@savvy-web/github-action-effects/testing` (`ActionStateTest`,
`GitHubAppTest`, `ActionOutputsTest`) rather than `Layer.succeed` stubs, so the
real `GitHubToken.provision` / `dispose` flow runs against a shared
`ActionState`. Config inputs are injected with `Effect.withConfigProvider` over
a `ConfigProvider.fromUnknown` (v4; was `ConfigProvider.fromMap`).

**Mock service layers:** Domain service tests create mock library services via
`Layer.succeed()`:

```typescript
const mockNpmRegistry = Layer.succeed(NpmRegistry, {
 getLatestVersion: vi.fn((pkg) =>
  Effect.succeed({ version: "1.2.3", integrity: "sha512-..." }),
 ),
});
```

Domain service tests provide the mock library layer to the service's Live layer:

```typescript
const testLayer = ConfigDepsLive.pipe(Layer.provide(mockNpmRegistry));
```

**No `@actions/core` mocking required:** The library implements the GitHub Actions
protocol natively without `@actions/*` package dependencies, so no test file
mocks `@actions/core`.

## Coverage

**What the gate actually enforces.** `vitest.config.ts` takes its coverage
configuration from `AgentPlugin.COVERAGE_LEVELS.strict` — `coverageTargets`
passed to the plugin, `.thresholds` on `test.coverage`. Those are **aggregate**
(whole-run) minimums: **not** a per-file gate and not 100%. `exclude: []` —
nothing is excluded (the former `src/services/pnpm-upgrade.ts` exclusion is
gone, along with that module).

**Plugin config.** The config is an async factory that loads the v4-line
`@vitest-agent/plugin`: `AgentPlugin.discover()` supplies `projects` and `tags`,
and `AgentPlugin({...})` is registered in `plugins` alongside the console
routing. (The Effect-v4 migration briefly dropped the plugin because the
then-current release was an Effect-v3 package; the v4-line release restored it.)

**The trap.** Because the gate is aggregate, an entire module can have zero test
execution while the suite stays green — the rest of the codebase carries the
average. This is precisely how `innerProgram` (~250 lines of orchestration in
`src/program.ts`) sat untested behind a passing gate and a `/* v8 ignore */`
block. A green coverage run is **not** evidence that a module is exercised.

**How to actually verify a module is exercised:** fault injection. Throw inside
the code path and confirm a test fails. If the suite still passes, that code has
no test execution, whatever the coverage number says.

## Integration Testing

**In-Repo Integration Suites (`__test__/integration/`):**

Each suite builds its own `discoveryLayer` from `NodeServices.layer` directly:

```typescript
const platform = NodeServices.layer;
const discoveryLayer = WorkspaceDiscovery.layer().pipe(
 Layer.provide(Layer.merge(WorkspaceRoot.layer.pipe(Layer.provide(platform)), platform)),
);
```

- `workspaces.int.test.ts` — Verifies `WorkspaceDiscovery.listPackages` and
  `importerMap` against real single-leaf and multi-leaf fixtures.
- `lockfile-compare.int.test.ts` — Exercises `compareLockfiles` against
  paired `pnpm-lock.before.yaml` / `pnpm-lock.after.yaml` fixtures
  covering catalog and importer change shapes.
- `changeset-emission.int.test.ts` — Drives the action's `Changesets` service through the **real** silk `Changesets.DepsRegenDefault` layer (the same one `makeAppLayer` wires) against a throwaway git repo. Because DepsRegen reads git history (`PointInTimeWorkspace.at`) and the working tree, each scenario commits a base state on `main`, mutates the worktree, then regenerates against `base = "main"`. It pins, from the consumer side: a publishable package emits a changeset through the default layer; accumulated pure-dependency changesets consolidate to one current table on re-fire; a catalog-only bump still surfaces a row with concrete versions; a non-versionable package is gated out; and markdown-significant characters in a cell survive the table writer verbatim. The exhaustive gating matrix (silk vs vanilla mode, publish targets, ignore, `versionPrivate`) lives in `@savvy-web/silk-effects` — this suite is the upstream-drift canary for the wiring, consolidation and catalog-awareness.
  - The escaping scenario earns a note of its own: it uses a `~`-prefixed specifier and an underscored package name, and its load-bearing assertion is that no cell contains a backslash. The other four scenarios all use plain `N.N.N` specifiers and unremarkable names, so they stayed green while a `~0.2.0` specifier was being written into changesets as `\~0.2.0`. It is a concrete instance of the coverage trap above: a path whose inputs cannot distinguish correct from corrupt output is unexercised in the only sense that matters, however green the suite is.
- `runtime-upgrade.int.test.ts` — Runs `RuntimeUpgrade.upgrade` against the
  real `*Resolver.layerOffline` layers from `@effected/runtimes` (no network)
  over a temp `package.json`. Acts as an upstream-drift canary for the bundled snapshot:
  it asserts `auto` resolves a real version within an existing range and writes
  it back. Because the bundled cache only carries currently-maintained majors,
  the fixture pins `^24.0.0` (the lowest major present) rather than an EOL line. It also pins the
  exact-write rule: the caret ranges the resolution, but a bare `24.x.y` is written back.

The `RuntimeUpgrade` service and the pure `src/utils/runtime.ts` helpers have
their own co-located unit suites (`runtime-upgrade.test.ts`, `runtime.test.ts`)
covering the never-add rule (missing entry skipped with a warning in every
mode), exact-version write-back, `auto` no-op on static pins, in-place update of
both the array and single-object shapes, and per-runtime resolver-failure
resilience.

**External Integration Test Scenarios (live GitHub repo, future work):**

1. **Full Workflow** - End-to-end test of entire action
2. **No Changes** - Verify early exit when already up-to-date
3. **Partial Failures** - Some updates succeed, some fail
4. **Branch Reset** - Handle existing branch deletion and recreation
5. **Changeset Creation** - Verify correct changeset files generated
