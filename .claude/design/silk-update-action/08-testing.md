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
Current suite: **648 tests across 44 files, all passing** (verified by
`pnpm vitest run`, not carried forward from this document's previous figure).

**Accounting for the delta from the 581 this document used to state** — and the
answer is not "it drifted", which is what it looks like:

| count | where | measured how |
| --- | --- | --- |
| 580 | this file at `5c97829` | — |
| **581** | this file at `f55fab6` | **never measured — this figure was wrong when it was written** |
| 588 | the tree at `f55fab6`, and at the 4.6.0 release commit | `pnpm vitest run`, 40 files |
| 589 | with `unit/layers/app.test.ts` added | `pnpm vitest run`, 41 files |
| 599 | before `check-peers`: +5 `unit/utilities/commit-signoff.test.ts`, +4 in `services/package-manager-upgrade.test.ts`, +1 in `doubles.test.ts` (two sign-off cases in `main.test.ts` were rewritten, not added) | `pnpm vitest run`, 42 files |
| **634** | the `check-peers` work, itemised in the first paragraph below this table | `pnpm vitest run`, 44 files |
| 645 | inferred, not measured — see the honesty note below | — |
| **648** | now: +3 in `unit/steps/peer-check.test.ts` (the peer-gate false-positive work), itemised below | `pnpm vitest run`, 44 files |

**The 581 was never a real count.** `f55fab6` — the kit-wave and
`@effected/package-json` adoption — added 8 tests and edited this file's figure
by **+1**. The release commit on top of it (`768d15a`) touched no tests at all,
so the tree stood at 588 for the whole of 4.6.0 while this document said 581.
Verified by re-running the suite with `__test__/unit/layers/` temporarily
removed: 588 across 40 files.

That is worse than staleness and is the reason this table exists. A stale number
is one nobody revisited; **this one was revisited in the very commit that
invalidated it, and adjusted by a plausible-looking increment.** The edit is what
made it credible. See the note on partial reconciliation in
@./09-project-status.md.

*Re-derive rather than trust this table:* `pnpm vitest run` for the total, and
`git log -p -- .claude/design/silk-update-action/08-testing.md` for when each
figure was claimed. If those two disagree, the document is wrong, not the runner.

**Accounting for 599 -> 634 (+35, +2 files)**, so the delta is explained rather
than merely observed: +9 `unit/schema/inputs.test.ts` (the `check-peers` value
set), +3 `unit/schema/domain.test.ts` (`PeerIssue`), +9 **new**
`unit/utilities/peers.test.ts` (`decidePeerGate`), +5 **new**
`unit/steps/peer-check.test.ts`, +4 `unit/format.test.ts`, +3
`unit/services/report.test.ts`, +2 `unit/program.inner.test.ts` (the gate and its
control).

**Accounting for 634 -> 648 (+14, +0 files) — only +3 of which are tests this
repo added.** The three are all in `unit/steps/peer-check.test.ts`: two
kit-drift canaries over **real pnpm 11.22.0 lockfile fixtures**
(`__fixtures__/pnpm-lock.alias.yaml`, `pnpm-lock.publish-dir-link.yaml`)
asserting proven-clean gating on the npm-alias and `publishDirectory` `link:`
shapes that `@effected/lockfiles` ≤0.6.1 misclassified as `unresolvedEdge`
(commit `2ddb105`), and one refresh-ordering test whose `WorkspaceCatalogs`
double only answers with rules **after** `refresh()` has been called, so it
fails on a missing *or* misordered call (commit `4b2fc5e`).

The residual +11 (634 → 645) is the honesty note the middle row above points
at: **no commit between the 634 measurement and this session touched a test
file** (`git log --name-only 5568503..981eb29 -- __test__ vitest.config.ts`
returns nothing), so those eleven are a change in what the runner *counts*, not
tests anyone wrote — the interval's only relevant changes are dependency-update
commits including a `@vitest-agent/plugin` bump. The specific counting change
has **not** been isolated; 645 is arithmetic (648 measured, minus the three
attributable additions), not a measurement. Recorded that way deliberately, per
the 581 entry above: a plausible unexplained increment is exactly the figure
this table exists to distrust.

## Layout

Tests are **not co-located**. Every unit suite lives under `__test__/unit/`,
mirroring `src/`; there are no `.test.ts` siblings in `src/`.

```text
__test__/
├── unit/           # mirrors src/ — discovered suites
│   ├── layers/     # app.test.ts — a COMPILE-TIME guard (see notable suites)
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
  itself, so the two resolve to the same prerelease by construction. The lockstep it
  must keep is now enforced by the catalog rather than by an exact literal someone has
  to remember to bump alongside every advance. **No version literal here on purpose:**
  this line used to carry "currently `4.0.0-beta.107`" while the tree had moved on to an
  `rc` — a literal in the very sentence explaining why literals were made unnecessary,
  which is the trap wearing its own uniform. Re-derive with `pnpm why effect`.
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
- **Peer-check step** (`unit/steps/peer-check.test.ts`) — drives `peerCheckStep`
  over parsed lockfile fixtures and `WorkspaceCatalogs.layerTest` doubles. Three
  of its tests exist because unit-green shipped consumer-red twice, and each
  pins the failure with the artifact that actually failed:
  - Two **kit-drift canaries** over real pnpm 11.22.0 lockfiles — an npm-alias
    dependency (`semver-classic: npm:semver@7.6.3`, at the importer level *and*
    inside a snapshot body) and a `publishDirectory` workspace whose satisfied
    peer is recorded as `react: link:packages/react/dist/pkg`. Both shapes
    landed in `ResolvedPackage.unresolvedEdges` under `@effected/lockfiles`
    ≤0.6.1, flipping the report to `unverified ("unresolvedEdge")` and
    withholding auto-merge from repos with zero real peer problems
    (spencerbeggs/type-registry-effect#122 was the alias case, live). The fix is
    upstream (`0.6.2`); the canaries assert `proven-clean` here so a kit
    regression fails this suite rather than resurfacing as withheld auto-merge
    in consumer repositories. They discriminate: both fixtures demonstrably
    fail against the ≤0.6.1 parser, which is what makes them evidence rather
    than decoration.
  - One **refresh-ordering test**, whose double is the interesting part: its
    `peerDependencyRules` fails typed until `refresh()` has been called, so the
    test goes red on a step that skips the refresh *or* orders it after the
    read. An always-succeeding double would have passed against the pre-fix
    step — the same "double more capable than production" trap recorded under
    the layers suite below, avoided this time by making the double model the
    staleness being fixed.
- **Install dispatch** (`unit/steps/install.test.ts`) — `runInstall` per package
  manager over a `ScriptedSpawner`, asserting the command lines and their order,
  and that the npm path unlinks `package-lock.json` through `node:fs`.
- **DCO sign-off** (`unit/utilities/commit-signoff.test.ts`) — five tests over
  `resolveSignoff`, covering **both** fallbacks (a persisted token with no
  `appSlug`, and no persisted token at all) because they produce the same string
  for different reasons, and asserting the exact trailer for an App identity with
  and without an `appUserId`. Ported from `silk-release-action`'s suite of the
  same name, deliberately: the two actions run the same resolver and a divergence
  should show up as a diff between the files. Token fixtures are real
  `InstallationToken.make(...)` values, because `botIdentity()` is a *method* —
  a structurally-correct literal typechecks through the double and dies at
  runtime.
  - Mutation-verified from the consumer side: hard-coding the fallback trailer in
    `Report.layer` turns `main.test.ts`'s "signs off as the App bot named by the
    persisted token" red. Worth noting *which* test that is — the sign-off tests
    that already existed asserted the fallback string, which the mutant also
    produces, so they never discriminated on identity at all.
- **Layer requirement channel** (`unit/layers/app.test.ts`) — **the only suite
  here whose assertion is not a runtime assertion.** It declares
  `type UnsatisfiedRequirements = Exclude<AppLayerRequirements, ActionServices>`
  over `ReturnType<typeof makeAppLayer>` and annotates a constant
  `[UnsatisfiedRequirements] extends [never] ? true : UnsatisfiedRequirements`,
  so a leftover requirement makes `true` unassignable and the compiler error
  names the missing service.
  - It exists because `Action.run`'s `options` parameter is **optional**, so
    `Action.run(program)` typechecks at any leftover `R` — v4.6.0 shipped with
    `PackageJsonFile` unprovided under a clean `tsc` and 588 green tests, and
    died on 100% of runs before the check run was created.
  - **Mutation-verified in both directions**, which is the bar this document
    sets: reinstating the bug produces `error TS2322: Type 'boolean' is not
    assignable to type 'PackageJsonFile'`; with the fix, `tsc --noEmit` is clean.
  - The `expect` calls in it are **deliberately weak and the file says so** —
    they only prove the module was evaluated. That is the inverse of the "false
    justification" hazard: an honest note that a signal is decoration is worth
    more than a confident one that it is not.
  - Its teeth depend on tests being inside the tsc project (`__test__/**/*.ts` is
    in the resolved `include`), so it blocks `pnpm typecheck` at pre-commit and in
    CI rather than only under vitest. *Falsified if* the tsconfig `include`
    narrows — the suite would keep passing while enforcing nothing.
  - **A second assertion now covers the program side**, added after the first
    shipped-and-died instance of the guard's own third blind spot:
    `Exclude<RequirementsOfEffect<ReturnType<typeof innerProgram>>, ActionServices>`
    must be `never`. A service resolved in a **step body** never enters the
    layer's input channel, so the original assertion is structurally blind to it —
    `WorkspaceCatalogs` was built by `makeAppLayer`, provided to `ReleaseAge`, and
    never merged into the returned layer. Reinstating that produces
    `Type 'boolean' is not assignable to type 'WorkspaceCatalogs'`.
    - Worth recording why the *suite* missed it as well, because it is the
      inverse of the `ActionState` double lesson: `program.inner.test.ts` supplies
      its own `WorkspaceCatalogs.layerTest`, so the **double was more capable than
      production**. A fake more complete than the real thing hides precisely the
      wiring bug it looks like it is exercising.
  - **What it does not cover:** a *broken* provide. Nothing builds the graph, so
    a layer that is wired but fails to construct still ships. See
    @./09-project-status.md for the three ways the type assertion itself can stop
    discriminating.
- **Entry points** (`unit/main.test.ts`, `unit/main.effect.test.ts`,
  `unit/pre.test.ts`, `unit/post.test.ts`) — orchestration with injected fakes,
  and the token lifecycle. The `pre` / `post` suites drive the **real**
  `GitHubToken.provision` / `dispose` flow against the local doubles, covering
  scope provisioning (the minted test token's `permissions` must grant the
  `required` scopes or `provision` fails with `TokenPermissionError`), start-time
  persistence, duration reporting and unconditional revocation.
- **Doubles self-tests** (`unit/doubles.test.ts`) — see the reserved-directory note
  above. It also pins that the `ActionState` double **fails typed** on a missing
  key rather than dying, which is what the real store does. The double used to
  die there, and the cost was not hypothetical: code whose contract is to degrade
  when nothing was persisted (`resolveSignoff`) read as broken under the double
  while being correct against the real store. A double stricter than the thing it
  stands in for does not catch bugs, it invents them — and the standing
  temptation is to weaken the production code until the fake is satisfied. The
  assertion uses `Effect.flip`, so a defect would still reject and the test
  discriminates between "failed typed" and "died".
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
  - `package-manager-upgrade.test.ts` carries a labelled block for the
    `@effected/npm` adoption (#290), and it is a worked example of **which** of a
    batch of new tests actually discriminate. Two assert behaviour that *changed*
    and go red against the restored helpers — a malformed registry integrity must
    produce a bare version rather than `pnpm@11.13.0+sha512.deadbeef`, and
    `pnpm@11.12.0garbage` must report `no-reference` rather than
    `unsatisfiable`. The other two are **controls**: a sha256 integrity and a
    `devEngines` caret range pass against both implementations, and are named as
    controls in the file so a later reader does not mistake four passing tests for
    four pieces of evidence. Note the input choice in the second: a *partial*
    version like `pnpm@11.12` would have passed against both and proved nothing,
    since the old regex rejected partials too — it only accepted trailing garbage.
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

**And `src/layers/app.ts` is the case where coverage cannot help at all.** It is
`/* v8 ignore */`-d as pure wiring, and the defect it shipped in v4.6.0 was a
*missing* provide — a fact about a type, not about a line, so no amount of
executing that module would have surfaced it. `unit/layers/app.test.ts` answers it
at compile time instead. The general point: some invariants are not statements
about executed lines, and reaching for coverage or fault injection on those is
looking under the wrong lamppost. Fault injection remains the right tool for
"is this code path exercised"; a type-level assertion is the right tool for "is
this graph complete".

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
