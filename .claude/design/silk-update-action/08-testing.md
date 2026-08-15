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
Current suite: **581 tests, all passing**.

## Layout

Tests are **not co-located**. Every unit suite lives under `__test__/unit/`,
mirroring `src/`; there are no `.test.ts` siblings in `src/`.

```text
__test__/
├── unit/           # mirrors src/ — discovered suites
│   └── utilities/  # tests for src/utils/ — NOT named `utils/` (see below)
├── integration/    # real-IO suites (*.int.test.ts) + integration/utils/
└── utils/          # RESERVED: helper modules, EXCLUDED from collection
```

**`utils`, `fixtures` and `snapshots` are reserved directory names, at *any*
depth under `__test__`, not just at the top level.** The rule in
`@vitest-agent/sdk` (`utils/test-location.js`) is
`segments.slice(1, -1).some((s) => TEST_HELPER_DIRS.includes(s))` — so a test
file is classified `excluded` if **any** intermediate path segment is one of
those three names. `utils/` is for helpers and mocks; tests must not live there.

That has a sharp edge worth stating plainly: an excluded file is silently
**never collected** — the suite shrinks while every local count still looks
plausible, and because the coverage gate is *aggregate* nothing turns red. The
helpers' own behavior is therefore pinned by `__test__/unit/doubles.test.ts`, a
discovered suite, rather than by tests living beside them.

**This has already bitten once.** The five suites covering `src/utils/`
(`resolveTargetBranch`, the catalog helpers, `buildUpdateSubject`, the
`devEngines.runtime` helpers and the semver range helpers) sat in
`__test__/unit/utils/`, matched the nested-segment rule, and stopped being
collected — the run silently dropped from 580 tests to **478** and stayed
green. They now live in `__test__/unit/utilities/`, and all five pass.

`__test__/unit/test-collection.test.ts` guards the recurrence: it walks
`__test__`, asserts no `*.test.ts` crosses a reserved segment, and asserts the
walker found something (so it cannot pass vacuously). Verified by planting a
file under `__test__/unit/utils/` — the guard fails and names it.

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

- `@effect/vitest` reads **`catalog:effect`** — the same catalog entry as `effect`
  itself, currently `4.0.0-beta.107`. The lockstep it must keep is now enforced by
  the catalog rather than by an exact literal someone has to remember to bump
  alongside every advance.
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
  over a temp-dir fixture), as is `PackageManagerUpgrade.layer` over an in-memory
  registry, so the dispatch and the unsatisfiable-range path are genuinely
  resolved rather than mocked into existence.
  - It also pins the `core.fileMode=false` write — that it happens, and that it
    targets the **detected root**. Two status readers now depend on it (the
    change verdict and the commit file list) and neither passes a per-command
    flag, so this one write is the only thing keeping an executable-bit-only
    flip from producing an empty commit and a spurious PR.
  - **And the `result` document on all three exit paths** — success, the
    no-changes neutral exit, and the custom-command failure. All three are
    asserted because they return through different branches, so one being
    correct says nothing about the others. The two early returns used to publish
    the *pre-run baseline* (`packageManager: null`, `workspaceRoot: ""`) after
    detection had already succeeded; the success path had no assertion at all.
    - The failure exit is asserted on its **contents**, not only its context,
      and that is the second defect on the same line: the first fix corrected
      `packageManager` and left `updates: []` for a run that had really updated
      things. Fixing half a document is how it looked correct. The harness makes
      `RegularDeps` return one update, so an exit that drops it produces an
      empty array rather than a missing field — which parses, and reads as
      "nothing happened".
    That gap surfaced by accident — a mutation aimed at one early-return path
    landed on the success path instead, and the whole suite stayed green. A
    misfire that reports green is evidence about the path it hit, not a wasted
    attempt.
- **Change detection** (`unit/steps/detect-changes.test.ts`) — three tests over a
  `Git.layerTest` that records the `cwd` it was called with. It exists because
  the composition suite reads only the count, so it would stay green against a
  step that ran status in the wrong directory or discarded everything but the
  path — both of which this step has actually done. Mutation-verified in both
  directions: swapping the root for `process.cwd()` fails one test, flattening
  the entries to `{ path }` fails the other.
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
  `ReleaseAge.layerNoop` and each pin one hold-back case through a fake `ReleaseAge`.
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
  - **The status-parsing tests moved a level up, deliberately.** `branch.test.ts`
    used to hold a `parseStatusLine` block asserting on a parser this repo owned.
    That parser is **deleted** — the reads go through `@effected/git`'s `status`,
    whose `StatusEntry` models the two porcelain columns separately and carries
    `origPath`. The three cases that expressed *behavior* rather than parsing
    survive, re-pointed at `commitChanges`' commit payload: a rename emits a
    delete of the origin plus content at the destination, a deletion whose
    columns disagree (`AD`, `RD`) is a deletion, and a copy does **not** delete
    its origin. Asserting on the payload rather than a parser return is what
    keeps those three fixes pinned now that the parser they were fixed in no
    longer exists — the defects became unrepresentable, and the tests still fail
    if the mapping onto commit members regresses.
  - The suite scripts `Git.layerTest({ status })` and lets every other `Git`
    member die naming itself, which is what proves `BranchManager` reaches for
    nothing else on that service.

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

**A third counting trap, and the one that actually shipped: a suite that is
never collected at all.** The five `src/utils/` suites sat in a reserved
directory name and stopped running; the total fell from 580 to 478 and every
signal stayed green. Note what distinguishes this from the two traps above —
both of those are about a count being *inflated* or a module being *thin*,
which a careful reader might catch. This one **removes** tests, and the only
visible symptom is a number nobody was diffing.

So: **a test-count delta is evidence and should be explained, in both
directions.** A drop is not noise. `pnpm exec vitest list --filesOnly` piped
against `find __test__ -name '*.test.ts'` answers "is every suite collected" in
one line, and `__test__/unit/test-collection.test.ts` now answers it on every
run.

**How to actually verify a module is exercised:** fault injection. Throw inside the
code path and confirm a test fails. If the suite still passes, that code has no
test execution, whatever the coverage number says. That is how the restored
suites were checked before being trusted — inverting `resolveTargetBranch`'s
sentinel fails two of its four cases, so they discriminate rather than decorate.

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
- `configure-status.int.test.ts` — `configureStatusStep` against a **real** git
  repository in a temp directory. Real IO rather than a scripted spawner because
  the claim under test is that a config write takes effect on a *later,
  independent* command — git's behavior, not ours. A scripted double could only
  prove we issued a command we chose to issue.
  - Three cases, and two of them exist because the first alone would not be
    evidence. The exec-bit case carries a **control** asserting the change IS
    visible under git's default, without which "the config worked" is
    indistinguishable from "git never saw a change here." A second case asserts a
    genuine content change is still visible, without which `core.fileMode=false`
    is indistinguishable from a change-blind read that suppresses everything. The
    third pins `--local` scope, because a global write would look identical here
    while leaking the setting onto the runner for every later step.
  - Mutation-verified: deleting the `configSet` call fails two of the three.
- `runtime-upgrade.int.test.ts` — `RuntimeUpgrade.upgrade` against the real
  `*Resolver.layerOffline` layers (no network) over a temp `package.json`. An
  upstream-drift canary for the bundled snapshot: `auto` must resolve a real
  version within an existing range and write it back **exact** (the caret ranges
  the resolution; a bare `24.x.y` is written). The fixture pins `^24.0.0` — the
  lowest major present in the cache — rather than an EOL line, because the
  snapshot carries only currently-maintained majors.

**External integration scenarios (live GitHub repo, future work):** full workflow,
no-changes early exit, partial failures, branch reset, changeset creation.
