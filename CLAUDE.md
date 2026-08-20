# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Project Status

This is a **GitHub Action** that updates config dependencies, regular and peer
dependencies, the package manager itself, and `devEngines.runtime` entries
(node/deno/bun). It runs as **three phases**: `src/pre.ts` provisions the GitHub
App token (`GitHubToken.provision`), `src/main.ts` is a thin `Action.run(program)`
wrapper, `src/post.ts` reports duration and revokes the token. `src/program.ts`
holds `program` / `innerProgram` as **pure composition** — read inputs, run the
steps in order, fold their results into outputs, report; each step's body lives
in its own module under `src/steps/`, input reading in `src/schema/inputs.ts`
(`readInputs`), log rendering in `src/format.ts`. Cross-phase state in
`src/state.ts`.

It runs on **Effect v4** (via `catalog:effect`, injected by the
`@effected/pnpm-plugin-effect` config dependency — the line has crossed from
`beta` into `rc`, so **read the version off the tree**
(`node -p "require('./node_modules/effect/package.json').version"`) rather than
off any doc, this one included) and the **`@effected/*` kit**; the former all-in-one `@savvy-web/github-action-effects` is **deleted**,
its surface split across the kit packages. Domain logic is wrapped as Effect
services (`Context.Service` + `Layer`) in `src/services/`, wired by
`makeAppLayer(dryRun, { runtimeLive })` in `src/layers/app.ts`.

The **package manager is detected once per run** (`detectPackageManager`) and
every dispatch point routes on that one value. pnpm, bun and npm are supported;
yarn is rejected with `InvalidInputError`.

For architecture and implementation details, load sections as needed:
-> @./.claude/design/silk-update-action/_index.md

Load the index first, then follow its navigation table to the sections your work
touches. Do not load all sections at once; skip entirely for simple bug fixes or
test-only changes.

## Commands

```bash
pnpm run lint / lint:fix           # Biome check / auto-fix
pnpm run typecheck                 # tsc via Turbo
pnpm run test / test:watch         # Vitest
pnpm run test:coverage             # Coverage (see the gate caveat below)
pnpm run build / build:prod        # Bundle via github-action-builder
pnpm run generate-schema           # Regenerate docs/schema/run-result.schema.json
pnpm run lint:md                   # markdownlint-cli2 (docs + this file)

pnpm vitest run __test__/unit/services/regular-deps.test.ts   # single file
pnpm vitest run --testNamePattern="buildUpdateSubject"        # by name
```

## Architecture

### Repository Structure

- Single-package GitHub Action (not a monorepo); no barrel re-exports — direct
  imports everywhere
- **Entry points**: `src/pre.ts`, `src/main.ts`, `src/post.ts` (derived from
  `action.config.ts` by the builder); composition in `src/program.ts`
- **Steps**: `src/steps/` — one module per orchestration unit (16: `branch`,
  `changesets`, `commit-and-pr`, `config-dependencies`, `configure-status`,
  `custom-commands`, `detect-changes`, `detect-package-manager`,
  `format-workspace`, `install`, `lockfile-snapshot`, `peer-check`, `peer-sync`,
  `regular-dependencies`, `upgrade-package-manager`, `upgrade-runtimes`). Each
  declares its own result type, an explicit requirement channel, and a tagged
  error **only if it can actually fail** — **five** carry `never` (`peer-check`
  is the newest; do not carry the old count of four forward without re-reading
  the signatures)
- **Services**: `src/services/` — `Context.Service` + `Layer`, plus stateless
  helper modules; **Layers**: `src/layers/app.ts`; **Schema**: `src/schema/`
  (singular — `domain.ts`, `inputs.ts`, `outputs.ts`); **Rendering**:
  `src/format.ts` (the run's log surface — pure, no services); **Errors**:
  `src/errors/errors.ts`; **Utils**: `src/utils/` (pure helpers)
- **Tests**: `__test__/unit/**` mirrors `src/`; `__test__/integration/**` for
  real-IO suites; `__test__/utils/**` for shared helpers (see Gotchas)
- **Shared configs**: `lib/configs/`; **Build**: Turbo; `typecheck` needs `build`

### Effect-TS Patterns

Service and layer inventory — which kit package owns which service, the domain
service list, Effect v4 spellings, the token lifecycle:
-> @./CLAUDE.effect-kit.md

Load before wiring or editing a service or layer, or when a kit API is not where
you expect. The two Effect hazards that bite *without* being looked up — the
`Action.run` requirement-channel hole and the `Schema.TaggedError` rename — are
in **Gotchas** below, not behind that pointer.

### Dogfooding, Branching and Release

Linking/overriding a first-party dep, the `dev` -> `main` -> release flow, and
the two workflows that clobber `dev`:
-> @./CLAUDE.workflow.md

**`dev` IS the feature branch here** — feature work is committed directly to it
with ordinary commits, because the action is bundled and a consumer pinning
`@dev` runs the **committed `dist`**, so nothing else can be tested end to end.
That makes **rewriting `dev` wrong** — no squash, no force-push, no rebase — and
`/design-docs:finalize` in particular: it soft-resets to the merge base and
pushes, which on an in-sync `dev` means force-pushing a branch other repositories'
CI is pinned to. A **`dev` → `main` PR is the intended finalization**, not a
prohibited one; GitHub squashes at merge without rewriting the branch first.

Load before linking a dependency, cutting a release, **finalizing or promoting a
branch**, or editing `.github/workflows/**`. **Currently nothing is linked and there are no
`overrides` entries** — if you were only checking that, you now have the answer
and do not need the pointer.

## Testing

- **Framework**: Vitest with v8 coverage, forks pool (Effect compatibility).
  Current suite: **634 tests across 44 files**, measured, not carried forward.
  **Treat a test count here as evidence and re-derive it** (`pnpm vitest run`) — a
  figure this line once carried was never a real count, having been edited by a
  plausible `+1` in the very commit that invalidated it, which is what made it
  credible. Per-commit accounting in
  `@./.claude/design/silk-update-action/08-testing.md`.
  `@effect/vitest` reads `catalog:effect`, the same
  catalog entry as `effect`, so the required lockstep is maintained by the catalog
  rather than by remembering to bump a literal; a few suites use `it.effect`,
  real-IO suites deliberately do not.
- **Schema drift**: `__test__/unit/generate-schema.test.ts` fails when
  `docs/schema/run-result.schema.json` no longer matches `RunResultDocument`; fix
  by running `pnpm generate-schema`, not by editing the JSON.
- **Config**: `vitest.config.ts` is an async factory loading `@vitest-agent/plugin`
  — `AgentPlugin.discover()` supplies `projects`/`tags`, `AgentPlugin({...})` is
  registered in `plugins`.
- **Coverage gate**: `AgentPlugin.COVERAGE_LEVELS.strict` (`coverageTargets` on
  the plugin, `.thresholds` on `test.coverage`, `exclude: []`) — **aggregate**
  minimums, **not** a per-file gate and nowhere near 100%. An entire module can
  have **zero** test execution while the run stays green (exactly how
  `innerProgram` and the bare-`Config` regression shipped). Verify by **fault
  injection**: throw inside the path and confirm a test fails.

## Conventions

- `.js` extensions on relative imports (ESM); `node:` protocol for built-ins;
  separate `import type`
- Commits: conventional format, DCO signoff, no markdown in the body (commitlint
  `silk/body-no-markdown`)

## Gotchas

- Biome enforces **tabs**, not spaces
- **`Schema.TaggedError`, not `Schema.TaggedErrorClass`.** The `*Class` spelling
  existed only on the earlier v4 betas and was renamed back to the v3 name in
  `beta.107`; the curried shape is identical, so the fix is the name alone. Worth
  knowing how it presents, because the shape recurs on every advance: the four
  class declarations in `src/errors/errors.ts` are the *only* real breakage, but
  their base type collapses, so every `new SomeError({...})` reports "Expected 0
  arguments, but got 1" and every field getter reports a missing property — 50
  errors across 14 files, in modules that never mention the renamed API. **An
  advance whose error list is dominated by call sites is still, usually, a
  declaration-site problem: find the declaration before touching a single call
  site.**
- **Read inputs with `ActionInput.*`, never bare `Config`.** The runner exports
  inputs as `INPUT_*` (only spaces mangled), so `Config.string("dependencies")`
  resolves nothing and silently takes its `withDefault` — including `dry-run`, so a
  rehearsal performs a live run. `ActionInput.list` owns the multi-value grammar
  (`src/utils/input.ts` / `parseMultiValueInput` are **deleted**) and **fails on
  absent and empty**, so `Config.withDefault([])` on each list read is load-bearing.
  `readInputs` lives in `src/schema/inputs.ts` (beside the `INPUT_NAMES` tuple)
  and is pinned by `INPUT_*`-keyed tests.
- **A service `makeAppLayer` does not provide is NOT a type error.** Same class as
  the entry above — a framework surface that silently accepts a wrong call.
  `Action.run` is declared `<E, R = never>(program: Effect<void, E,
  ActionServices | R>, options?: ActionRunOptions<R>)`; `options` is **optional**,
  so `R` infers to whatever is left over and `Action.run(program)` typechecks at
  *any* leftover requirement. There is no "you forgot a layer" error, ever. So a
  service resolved in a **domain layer's body** that `makeAppLayer` does not
  provide ships under a clean `tsc` and a green suite and dies on the runner as a
  defect ~30ms in — **before the check run is created**, so nothing appears in the
  GitHub UI. Not hypothetical: v4.6.0 shipped with `PackageJsonFile` provided to
  `RuntimeUpgrade.layer` only and failed 100% of runs in every consumer repo. The
  only thing standing between that and the next release is
  **`__test__/unit/layers/app.test.ts`**, a compile-time assertion that
  `Exclude<AppLayerRequirements, ActionServices>` is `never` — it fails
  `pnpm typecheck`, and the error names the missing service. **So adopting a
  service into a second consumer is a layer-wiring change, not a call-site
  change.** Its blind spots, so it is not over-trusted: it catches *missing*
  wiring, not *broken* wiring (nothing builds the graph), and a service resolved
  in a **method** rather than a layer body never reaches the requirement channel
  at all. **That third blind spot has now fired in production too**, so the guard
  has a SECOND assertion: `Exclude<InnerProgramRequirements, ActionServices>`
  must also be `never`. `steps/peer-check.ts` resolves `WorkspaceCatalogs` in its
  step body, `makeAppLayer` built that layer but piped it into `ReleaseAge`
  **without merging it into the returned layer**, and the run died with
  `Service not found: @effected/workspaces/WorkspaceCatalogs`. The layer-side
  assertion could not see it — it checks the layer's **input** channel, and this
  is a missing **output**. Both halves are mutation-verified; the second names
  `WorkspaceCatalogs` when reinstated. **A service built inside `makeAppLayer` is
  not thereby provided — check it appears in a `mergeAll`, not merely in a
  `Layer.provide`.** Depth in
  `@./.claude/design/silk-update-action/06-effect-patterns.md`
- **The `result` output is the whole run as JSON** (`RunResultDocument`, composed
  from the existing domain schemas rather than a parallel reporting shape),
  emitted **on every exit path** as an empty-run document — never an empty
  string, so a consumer parses unconditionally. Its JSON Schema is **generated**
  into `docs/schema/run-result.schema.json` by `lib/scripts/generate-schema.ts`
  (via `@effected/schemastore`, run under `tsx` — a declared
  devDependency, previously transitive-only); change it by editing the domain
  types and running `pnpm generate-schema`. The four scalar outputs are
  unchanged.
  - **Every shared schema needs an explicit `identifier` annotation.** From
    beta.107 the lowering hoists a sub-schema used in more than one place into
    `$defs` and invents a *positional* name when there is none — so a second
    anonymous union silently renames the first. Nothing fails, which is why this
    needs a rule: **a `$defs` key matching `Union_`/`Struct_` is a missing
    annotation at the definition site, not an artifact to commit.** Depth in
    `@./.claude/design/silk-update-action/03-type-definitions.md`
- **Tests are not co-located**: every unit suite lives in `__test__/unit/**`
  mirroring `src/`. `utils`, `fixtures` and `snapshots` are **reserved by
  AgentPlugin for helpers and mocks and excluded from collection — at ANY depth
  under `__test__`, not just the top level** (the rule is
  `segments.slice(1,-1).some(s => TEST_HELPER_DIRS.includes(s))`). A `.test.ts`
  crossing one silently never runs, and the aggregate coverage gate stays green.
  Keep helpers as plain `.ts` in `__test__/utils/`, pinned from
  `__test__/unit/doubles.test.ts`. **Tests for `src/utils/` therefore live in
  `__test__/unit/utilities/`, not `__test__/unit/utils/`** — they sat in the
  latter and silently stopped running, dropping the suite from 580 to 478.
  `__test__/unit/test-collection.test.ts` fails if it recurs.
- `@actions/*` is never imported; the head SHA comes from `ActionEnvironment`
  (`env.github.sha`), the log level from `env.isDebug`
- Action input is `app-client-id` (not `app-id`); `post.ts` always revokes
- `source-branch` (default `main`) is the cut-from ref; `target-branch` (empty →
  follows source, via `resolveTargetBranch`) is the PR base. Both are validated by
  `BranchManager.validateBranches` **inside the check run**, before the branch is
  force-reset by `GitBranch.upsert`
- Changesets need local history for the base ref: the checkout must use
  `fetch-depth: 0`, and `BranchManager.ensureBaseHistory(target)` is a best-effort
  preflight before `Changesets.create`
- `upgrade-package-manager` is a **string** input (`false` | `true` | `auto` | a
  semver range) defaulting to **`"false"`** (opt-in, matching `upgrade-runtime-*`).
  It upgrades the **detected** manager via `PackageManagerUpgrade`. corepack-managed
  managers (pnpm, npm) are written hash-pinned (`+sha512.<hex>`, via
  `@effected/npm`'s `CorepackIntegrityHash.fromSri`) into both `packageManager` and
  `devEngines.packageManager.version`; **bun is written bare** (corepack does not
  manage it). `upgrade()` never returns `null` — it returns an outcome whose `kind`
  explains the skip, and `unsatisfiable` (a range typed for a different manager)
  is the only one logged at **warning**. A successful upgrade opens the install gate
- `runInstall` (`src/steps/install.ts`; `runCommands` is in
  `src/steps/custom-commands.ts`) **regenerates** the lockfile rather than
  repairing it (pnpm:
  `pnpm clean --lockfile` + `pnpm install --frozen-lockfile=false`, needs pnpm 11+;
  bun: `bun install --force`; npm: unlink `package-lock.json` via `node:fs` then
  `npm install`) — the action mutates all three resolution inputs, so a repair-only
  install could commit an inconsistent lockfile. Advancing transitives is expected
- Config dependencies dispatch on the manager: **pnpm** edits
  `pnpm-workspace.yaml` (`ConfigDeps`); **bun** three-way merges the dependency's
  `catalogs` export into `package.json` against the lockfile's installed version
  (`CatalogConfigDeps`, emitting `CatalogDelta` rows that reach the PR body);
  **npm** is skipped — no `catalog:` protocol
- `ConfigDeps`/`RegularDeps` mirror pnpm's `minimumReleaseAge` gate at resolution
  time via `ReleaseAge.filterVersions`, so the action never proposes a version pnpm
  would reject (`ERR_PNPM_NO_MATURE_MATCHING_VERSION`). **Gate discovery is the
  kit's**, not this repo's: `WorkspaceCatalogs.releaseAgeGate()` over
  **`layerWithConfigDependenciesSubprocess()`** — the subprocess variant is
  mandatory, because rspack miscompiles the in-process computed dynamic
  `import()` into a context module. **What stays local is the fail-open
  posture**: the kit fails typed with `CatalogAssemblyFailure` (right for a
  library), and this action degrades that to "no gate" with a warning in a
  one-line `Effect.catch` in `ReleaseAge.layer`, because pnpm re-enforces the
  gate at install anyway. Depth in
  `@./.claude/design/silk-update-action/05-module-library.md`
- Runtime bumps (`upgrade-runtime-*`) **upgrade only, never add** — in *every*
  mode — and always write the **bare exact** resolved version (the range only
  selects which line to resolve), because `silk-runtime-action` downstream rejects
  range operators. `auto` no-ops on a static pin. `@effected/runtimes` resolves only
  **non-EOL** major lines; an EOL target is skipped with a warning (offline and
  live alike). Runtime bumps never create a changeset and never trigger install
- `@effected/workspaces`' `PackageManagerDetector` recognizes bun/pnpm from the
  **lockfile conjoined with the manifest**, not `devEngines.packageManager` alone —
  a repo naming a manager only in `devEngines` with no lockfile detects as **npm**
- **`git status` is read through `@effected/git`'s `Git.status(cwd)`**, which
  returns typed `StatusEntry` values (`x`, `y`, `path`, `origPath`). Both readers
  use it — `services/branch.ts` (commit file list) and `steps/detect-changes.ts`
  (change verdict). `parseStatusLine` and the `gitRaw`/`Run.collect` helper it
  needed are **deleted**; `Run.text` still trims, but nothing here parses
  column-aligned text any more
- **`core.fileMode=false` is set once on the checkout, not per command.**
  `steps/configure-status.ts` writes it via `Git.configSet` right after detection,
  before any status read — exec-bit-only flips do not survive the content-based
  API commit at mode 100644 and would produce an empty commit and a spurious PR.
  Repository scope, so it also applies to silk's DepsRegen commands in that
  checkout (benign, and stated in the design docs rather than assumed)
- Auto-merge requires GraphQL (no REST endpoint) and is a **separate**
  `setAutoMerge` call whose failure degrades to a warning
- **`check-peers` gates auto-merge by NOT making that separate call.** Input is
  `false` | `warn` | `no-auto-merge`, and its **default is DERIVED** rather than
  static: unset resolves to `no-auto-merge` when `auto-merge` is enabled and
  `false` when it is not. A static `no-auto-merge` default would have been a
  no-op for the *gate* but not for the *run* — the step still spawns the
  config-dependency hook replay as a subprocess in the consumer's repo. Deriving
  makes "free where there is nothing to gate" literally true. An explicit value
  always wins. **Nothing can be withheld that was never going to happen:**
  `decidePeerGate` takes `autoMergeEnabled`, because without it the PR body told
  reviewers "auto-merge was withheld" on repositories that had never enabled it;
  `fail` is deliberately **rejected**, not accepted-and-ignored, because it is the
  only tier needing a second concurrent check run. The gate predicate is
  **not** `required > 0` — it is
  `supported && !unresolvedImporters.length && !unverified.length && !requiredCount`,
  because each of the other three produces an empty result meaning *"not examined"*
  rather than *"nothing wrong"*. A mutant reading only `requiredCount` turns five
  tests red, which is the check that this is real rather than decorative.
  - **A lockfile alone cannot answer the question.** pnpm persists
    *resolution*-affecting config into the lockfile and discards
    *reporting*-affecting config: `overrides` from a pnpmfile **are** recorded,
    `peerDependencyRules` appears **zero** times (`pnpmfileChecksum` in the
    lockfile header is the tell — pnpm would have nothing to invalidate against if
    the lockfile were complete). So the rules come from
    `WorkspaceCatalogs.peerDependencyRules()`, which also replays
    config-dependency plugins — and **this repo declares no rules of its own**, so
    a workspace-file-only read would find nothing here and still false-positive.
  - **Presence of the option is the assertion, not its contents.** Omitting
    `peerDependencyRules` means "nobody looked" and always reports
    `peerRulesNotApplied`; passing `NoPeerDependencyRules` asserts "I looked, there
    are none". A failed lookup therefore degrades to **omitting**, never to the
    empty set — the empty set is a claim we would have no basis to make.
  - Stated limits, not implied coverage: optional peers never gate;
    a pnpm workspace package's **own** peer declarations are undetectable (absent
    from the lockfile, and `pnpm peers check` does not report them either); and
    `ignoreMissing`/`allowAny` are **not consumed upstream and fail closed** — a
    non-empty either axis makes the report `unverified`, so **the gate stops
    firing positively rather than answering wrongly**. Neither of this repo's two
    config-dependency plugins sets either axis today (verified from
    `peerDependencyRules()` output, not from the plugin sources:
    `allowedVersions` 36, both axes `[]`), so the gate is unaffected — but a
    plugin that starts setting one silently turns the gate into a permanent
    abstain, and that is deliberate, not a regression to chase
- **`@effected/package-json` is adopted for `PackageJsonFile.modify` ONLY** —
  a declared runtime dependency wired as `PackageJsonFile.layer` and
  consumed by both `RuntimeUpgrade` and `PackageManagerUpgrade`. This line used to
  read "evaluated and DECLINED — do not re-propose it"; that ruling was
  **narrowed, not overturned**, and the distinction is the content. Its central
  objection still governs: `Package.decode` requires `name` + a strict-semver
  `version`, so it **rejects the private workspace root** this action must edit.
  That is honored by *not using the decode path* — both services still
  `readFileSync` + `JSON.parse` to **decide**, routing only the **write** through
  `modify` (a decode-free JSONC edit at a field path; key order, indent and line
  endings survive byte-for-byte). What changed is upstream: `0.9.0` (PR
  spencerbeggs/effected#366) shipped the two things the old ruling named as its
  own falsification condition — a presence-lenient `PackageManifest` and an
  order-preserving single-field edit — answering **#286**. Nothing here noticed
  for a release, because "do not re-propose" is the sentence that stops the next
  reader checking. **Re-checking the ruling's four "therefore staying" helpers by
  call site deleted two of them**: `parsePnpmVersion` / `formatPnpmVersion` (and
  `ParsedPnpmVersion`) had no caller anywhere and the reason recorded for keeping
  them had independently expired, so they are **gone** from `src/utils/pnpm.ts`.
  That is the sequence worth copying — a doc pass that checks call sites is how
  dead exports get found, the same argument that removed four error classes. The
  per-helper verdicts (including why `detectIndent` stays but *not* for its
  recorded reason) are in
  `@./.claude/design/silk-update-action/09-project-status.md`; re-derive by grep
  rather than re-reading either list
- **`src/utils/pnpm.ts` is down to `detectIndent` alone**, and the two deletions
  happened for *different* reasons — do not collapse them. `parsePnpmVersion` /
  `formatPnpmVersion` went for having **no caller** (above).
  `corepackHashFromIntegrity` had a caller and worked; it went because the
  capability **moved upstream** (`@effected/npm`'s `CorepackIntegrityHash.fromSri`,
  issue #290 — effected#281 cites this repo's copy as the consumer evidence). The
  kit is not a like-for-like port: the local version base64-decoded whatever
  followed `sha512-`, so a wrong-length digest or non-canonical base64 became a
  pin that *looked* well-formed and that corepack rejects at install, in the
  consumer's repo, after a successful run. Those fail typed now and degrade to
  the bare-version write. **`PackageManagerUpgrade`'s module-private
  `parsePmVersion` went the same way**, onto `PackageManagerPin` — with one local
  concession: a leading `^`/`~` is stripped before parsing
  `devEngines.packageManager.version`, because devEngines legally carries a range
  and a corepack pin never does
- **The DCO sign-off comes from the persisted token, not a literal.**
  `src/utils/commit-signoff.ts`' `resolveSignoff()` reads
  `GitHubToken.botIdentity()` and renders through `BotIdentity.signoff`, falling
  back to `BotIdentity.githubActions`; `Report.layer` resolves it **once in the
  layer body** so the commit trailer and the PR body's proposed-squash fence
  cannot disagree, and so neither member gains an `ActionState` requirement. It
  replaced a `signoffLine(appSlug?)` whose slug branch **nothing ever passed** —
  reachable only from a test — so every real run signed as `github-actions[bot]`
  while the App bot authored the commit. Same shape as the sister
  `silk-release-action`'s `resolveSignoff`, deliberately
- **`@effected/git` is adopted for `status` only.** The mutating tier is still
  declined — it covers 2 of the 9 local git operations `services/branch.ts`
  performs, so seven stay on `Run` (spencerbeggs/effected#279). The earlier
  blanket decline rested on "`-c core.fileMode=false` cannot be scoped", which
  was **wrong**: that enumerated per-command and process-global and treated the
  list as exhaustive, when repository config is a third scope and the ordinary
  one. Worth remembering as a shape — every individual claim in that ruling was
  true. Detail and the "what would change the answer" conditions live in
  `@./.claude/design/silk-update-action/09-project-status.md`
- **A caret on a `0.x` dependency pins the minor.** `^0.9.5` does **not** admit
  `0.10.0`; `^0.2.1` does not admit `0.3.0`. A plain `pnpm update` therefore
  leaves a `0.x` kit package on the old minor while code calls the new surface —
  the install succeeds and the failure shows up later. Bump the declared range
  explicitly when a `0.x` kit package releases a minor. This is not theoretical:
  `@effected/workspaces` and `@effected/commands` both crossed a `0.x` minor and
  needed exactly that hand-edit; check the declared ranges rather than trusting
  the versions this line used to name.
  - **The trap has a second half — a range that is *satisfied* is a range pnpm
    never revisits**, so a lockfile can hold a version for months while its peers
    move. At `@effected/npm@0.11.0` that left `@effected/github` on `0.6.0` while
    `github-actions@0.9.1` pulled `0.7.0`, and
    `__test__/unit/layers/app.test.ts` failed with `Type 'boolean' is not
    assignable to type 'GitHubClient'`. **The duplicate was NOT the cause** — a
    `0.6.1`+`0.7.0` pair typechecks fine; `0.6.0` embeds `@octokit/types@16`
    where its peers were built against `@17`, and `GitHubClient`'s type embeds
    octokit's. So a duplicate is harmless while the copies' shapes agree, and it
    is a **stale transitive** that makes them disagree. Evidence table and the
    full write-up (including that the correct explanation was already on the page
    when the wrong one was added) in
    `@./.claude/design/silk-update-action/01-dependencies.md`. After any kit
    bump: `pnpm why` on **every** kit package, not just the one you bumped — and
    read a leftover requirement in the guard as *one of three* possible causes
    (missing `Layer.provide`, duplicate, drifted shape), since the message names
    the type and never the reason
- **`src/services/lockfile.ts` once held a raw NUL byte** (the `depKey`
  separator, since replaced by the `\0` escape). `file(1)` reported it as `data`
  and **grep silently skipped all 531 lines**, returning something
  indistinguishable from a clean no-match. Any pre-fix claim about that file may
  rest on no data at all; re-verify rather than cite
- `action.config.ts`: `build.nativeDynamicImports` lists
  `@changesets/apply-release-plan` only, so rspack preserves its fully dynamic
  `await import()`. `@effected/workspaces`' `ConfigDependencyHooks` has the same
  pattern but must **not** be listed (the builder's ignore-loader throws); its
  "Critical dependency" warning is benign. First-party dynamic imports use an inline
  `/* webpackIgnore: true */` instead (`src/services/module-catalogs.ts`), asserted
  post-build by `scripts/assert-native-dynamic-import.mjs`. The `build.ignore`
  cyclonedx entries are **vestigial**. Rationale in
  `@./.claude/design/silk-update-action/01-dependencies.md`
