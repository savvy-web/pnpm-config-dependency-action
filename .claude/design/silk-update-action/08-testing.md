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

# Testing Strategy

[Back to index](./_index.md)

**Framework:** Vitest with v8 coverage, forks pool for Effect-TS compatibility.
Current suite: **546 tests, all passing**.

## Layout

Tests are **not co-located**. Every unit suite lives under `__test__/unit/`,
mirroring `src/`; there are no `.test.ts` siblings in `src/`.

```text
__test__/
├── unit/           # mirrors src/ — discovered suites
├── integration/    # real-IO suites (*.int.test.ts) + integration/utils/
└── utils/          # RESERVED: helper modules, EXCLUDED from collection
```

**`__test__/utils/**` is reserved by the vitest-agent `AgentPlugin` for helper
modules and is excluded from suite discovery.** That has a sharp edge worth
stating plainly: a `describe` left inside a helper there is silently **never
collected** — the suite shrinks while every local count still looks plausible.
So the helpers' own behavior is pinned by `__test__/unit/doubles.test.ts`, a
discovered suite, rather than by tests living beside them.

Shared helpers currently in that directory:

- `action-doubles.ts` — in-memory `ActionState`, `GitHubApp` and `ActionOutputs`
  doubles, replacing the deleted `@savvy-web/github-action-effects/testing`
  subpath (`ActionStateTest`, `GitHubAppTest`, `ActionOutputsTest`). The kit ships
  `makeTest` / `layerTest` per service instead, with unstubbed members dying, so
  the *recording* behavior those suites assert on lives here. The `ActionState`
  double encodes through each caller's schema exactly as the real store does, so a
  round trip proves the schema is usable across the phase boundary rather than
  asserting on the double.
- `fixtures.ts` — shared domain fixtures (`DependencyUpdateResult`,
  `ChangesetFile`, `LockfileChange`, PR results) plus registry/PR test layers.

## Test framework posture

- `@effect/vitest` is pinned **exactly** to the same beta as `effect`
  (`4.0.0-beta.101`) and must move in lockstep with it.
- Three suites are converted to `it.effect` — `services/report.test.ts`,
  `services/workspace-yaml.test.ts`, `utils/semver.test.ts`. The rest, including
  every real-IO suite, deliberately stay on plain `vitest`: `it.effect` buys
  nothing where the test is doing filesystem or git work and would obscure the
  setup/teardown.
- **No `@actions/core` mocking anywhere.** The kit implements the Actions protocol
  natively; no test file mocks `@actions/*`.
- Commands are scripted with `@effected/commands`' public `ScriptedSpawner`
  fixture (which produces structured spawn records), not a hand-rolled spawner.
  The predecessor's runner split streaming (`exec`) from capturing
  (`execCapture`) and suites asserted which half was used; `@effected/commands`
  has no such split — every `Run` combinator collects — so the surviving assertion
  is *which* commands run, in what order.

## Notable suites

- **Input parsing** (`unit/schema/inputs.test.ts`) — 12 tests over the exported
  `readInputs`, keyed on a **runner-shaped** environment (`INPUT_*`, mangled with
  only spaces replaced, so `upgrade-runtime-node` → `INPUT_UPGRADE-RUNTIME-NODE`)
  injected through `ActionInput.layer`, never `process.env`. These exist because
  of a shipped regression: `program.ts` read its inputs with bare
  `Config.string(...)`, which resolves nothing under the runner and silently takes
  every `withDefault` — including `dry-run`, so a workflow asking to rehearse
  performed a live run. The old suite could not catch it twice over: nothing
  exercised the input layer at all, and the input block sat under a `v8 ignore`.
  Reverting to bare `Config` fails every assertion here.
- **Orchestration** (`unit/program.inner.test.ts`) — drives `innerProgram`
  directly against a fake app layer and asserts on the captured **log stream**,
  which is the run's decision record. It pins: the package-manager dispatch (bun →
  `CatalogConfigDeps`, pnpm → `ConfigDeps`, npm → neither, with a warning that npm
  has no `catalog:` protocol); the acceptance signal (an `upgrade-package-manager`
  range that satisfies nothing — e.g. a pnpm `^11.0.0` in a bun repo — must WARN,
  while "disabled" and "already current" stay at info); the install gate; the
  pnpm-only workspace-format gate; that every skipped step states a reason; and
  that an unsupported (yarn) workspace fails with `InvalidInputError` from *inside*
  the check run, which is concluded `failure` rather than bypassed. Package-manager
  detection is **real** here (upstream `WorkspaceRoot` / `PackageManagerDetector`
  over a temp-dir fixture), as is `PackageManagerUpgradeLive` over an in-memory
  registry, so the dispatch and the unsatisfiable-range path are genuinely
  resolved rather than mocked into existence.
- **Install dispatch** (`unit/steps/install.test.ts`) — `runInstall` per package
  manager over a `ScriptedSpawner`, asserting the command lines and their order,
  and that the npm path unlinks `package-lock.json` through `node:fs`.
- **Entry points** (`unit/main.test.ts`, `unit/main.effect.test.ts`,
  `unit/pre.test.ts`, `unit/post.test.ts`) — orchestration with injected fakes,
  and the token lifecycle. The `pre` / `post` suites drive the **real**
  `GitHubToken.provision` / `dispose` flow against the local doubles, covering
  scope provisioning (the minted test token's `permissions` must grant the
  `required` scopes or `provision` fails with `TokenPermissionError`), start-time
  persistence, duration reporting and unconditional revocation.
- **Doubles self-tests** (`unit/doubles.test.ts`) — see the reserved-directory note
  above.
- **Schemas and errors** (`unit/schema/domain.test.ts`, `unit/errors/errors.test.ts`).
- **Dependency services** (`unit/services/config-deps.test.ts`,
  `regular-deps.test.ts`, `catalog-config-deps.test.ts`, `module-catalogs.test.ts`,
  `peer-sync.test.ts`, `package-manager.test.ts`,
  `package-manager-upgrade.test.ts`, `runtime-upgrade.test.ts`) — registry
  querying, range-respecting resolution (never absolute `latest`), multi-section
  scanning with accurate per-section `type`, bun catalog three-way merge and delta
  reporting, `peer-lock`/`peer-minor` range computation, package-manager
  self-upgrade across pnpm/bun/npm (including the corepack-hash vs bare-version
  write split and the `unsatisfiable` outcome), and per-runtime
  `devEngines.runtime` rewriting (the never-add rule in *every* mode, exact
  write-back, `auto` no-op on static pins, per-runtime resolver-failure
  resilience). `config-deps` and `regular-deps` default their fixtures to
  `ReleaseAgeNoop` and each pin one hold-back case through a fake `ReleaseAge`.
- **Release-age gate** (`unit/services/release-age.test.ts`) — inline
  `pnpm-workspace.yaml` discovery, the subprocess hook replay (argv passing,
  `pnpmfile.mjs`/`.cjs` order, best-effort degradation with a warning), publish-time
  fetching via `NpmRegistry.publishTimes`, strictest-wins combination, exclude
  matching, and the fail-open filtering paths.
- **Lockfile and changesets** (`unit/services/lockfile.test.ts`,
  `changesets.test.ts`) — catalog/importer comparison emitting per-importer,
  per-section triples; and the DepsRegen **adapter plumbing** only (the
  `.changeset/` guard, the `plan({ cwd, base }) → execute` call, the
  `written → ChangesetFile` mapping, error mapping) against a mock
  `Changesets.DepsRegen`. The gating cascade, catalog-aware diffing and
  consolidation live upstream in `@savvy-web/silk-effects`.
- **Reporting, branch and pure helpers** (`unit/services/report.test.ts`,
  `branch.test.ts`, `workspace-yaml.test.ts`, `unit/utils/*.test.ts`) — PR
  create/update and auto-merge degradation, commit-message and summary generation,
  YAML sorting/round-tripping, branch lifecycle over `GitBranch.upsert` /
  `GitCommit.commitFiles` (including the `ensureBaseHistory` merge-base probe and
  fetch fallback), `resolveTargetBranch`, catalog helpers, commit subjects,
  `devEngines.runtime` helpers and the semver range helpers.

## Coverage

**What the gate actually enforces.** `vitest.config.ts` takes its coverage
configuration from `AgentPlugin.COVERAGE_LEVELS.strict` — `coverageTargets` passed
to the plugin, `.thresholds` on `test.coverage`, with `exclude: []` (nothing
excluded). Those are **aggregate** (whole-run) minimums: **not** a per-file gate
and not 100%.

**Plugin config.** The config is an async factory that loads
`@vitest-agent/plugin`: `AgentPlugin.discover()` supplies `projects` and `tags`,
and `AgentPlugin({...})` is registered in `plugins` alongside the console routing.

**The trap.** Because the gate is aggregate, an entire module can have zero test
execution while the suite stays green — the rest of the codebase carries the
average. This is precisely how `innerProgram` (~250 lines of orchestration) sat
untested behind a passing gate and a `/* v8 ignore */` block, and how the bare
`Config` input regression shipped. A green coverage run is **not** evidence that a
module is exercised.

**A second, subtler counting trap.** While suites were co-located, importing a
`.test.ts` fixture module from another suite **re-executed its tests** in the
importing file's context — 22 of the then-reported 573 tests were duplicate
executions, not distinct tests. The honest count after the move (and after the
deletions/additions of the same change) is **546**. Two rules fall out of this:
shared helpers are plain `.ts` in the reserved `__test__/utils/` directory, never
`.test.ts`; and a test-count delta is only meaningful once duplicate executions
are accounted for.

**How to actually verify a module is exercised:** fault injection. Throw inside the
code path and confirm a test fails. If the suite still passes, that code has no
test execution, whatever the coverage number says.

## Integration Testing

`__test__/integration/` holds the real-IO suites. Each builds its own
`discoveryLayer` from `NodeServices.layer` directly:

```typescript
const platform = NodeServices.layer;
const discoveryLayer = WorkspaceDiscovery.layer().pipe(
 Layer.provide(Layer.merge(WorkspaceRoot.layer.pipe(Layer.provide(platform)), platform)),
);
```

- `workspaces.int.test.ts` — `WorkspaceDiscovery.listPackages` / `importerMap`
  against real single-leaf and multi-leaf fixtures.
- `lockfile-compare.int.test.ts` — `compareLockfiles` against paired
  `pnpm-lock.before.yaml` / `pnpm-lock.after.yaml` fixtures covering catalog and
  importer change shapes.
- `changeset-emission.int.test.ts` — drives the action's `Changesets` service
  through the **real** `Changesets.DepsRegenDefault` layer (the same one
  `makeAppLayer` wires) against a throwaway git repo: each scenario commits a base
  state on `main`, mutates the worktree, then regenerates against `base = "main"`.
  It pins, from the consumer side: a publishable package emits a changeset through
  the default layer; accumulated pure-dependency changesets consolidate to one
  current table on re-fire; a catalog-only bump still surfaces a row with concrete
  versions; a non-versionable package is gated out; and markdown-significant
  characters survive the table writer verbatim. This suite is the **upstream-drift
  canary** for silk-effects — it is what confirmed the `Changesets` / DepsRegen
  surface was unchanged across the v5 major.
  - The escaping scenario earns its own note: it uses a `~`-prefixed specifier and
    an underscored package name, and its load-bearing assertion is that no cell
    contains a backslash. The other four scenarios all use plain `N.N.N`
    specifiers and unremarkable names, so they stayed green while a `~0.2.0`
    specifier was being written as `\~0.2.0`. A path whose inputs cannot
    distinguish correct from corrupt output is unexercised in the only sense that
    matters, however green the suite is.
- `runtime-upgrade.int.test.ts` — `RuntimeUpgrade.upgrade` against the real
  `*Resolver.layerOffline` layers (no network) over a temp `package.json`. An
  upstream-drift canary for the bundled snapshot: `auto` must resolve a real
  version within an existing range and write it back **exact** (the caret ranges
  the resolution; a bare `24.x.y` is written). The fixture pins `^24.0.0` — the
  lowest major present in the cache — rather than an EOL line, because the
  snapshot carries only currently-maintained majors.

**External integration scenarios (live GitHub repo, future work):** full workflow,
no-changes early exit, partial failures, branch reset, changeset creation.
