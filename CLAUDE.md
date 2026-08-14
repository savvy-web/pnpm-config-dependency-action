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

It runs on **Effect v4** (`effect@4.0.0-beta.107` via `catalog:effect`, injected
by the `@effected/pnpm-plugin-effect` config dependency) and the **`@effected/*`
kit**; the former all-in-one `@savvy-web/github-action-effects` is **deleted**,
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
pnpm vitest run --testNamePattern="parsePnpmVersion"          # by name
```

## Architecture

### Repository Structure

- Single-package GitHub Action (not a monorepo); no barrel re-exports — direct
  imports everywhere
- **Entry points**: `src/pre.ts`, `src/main.ts`, `src/post.ts` (derived from
  `action.config.ts` by the builder); composition in `src/program.ts`
- **Steps**: `src/steps/` — one module per orchestration unit (14: `branch`,
  `changesets`, `commit-and-pr`, `config-dependencies`, `custom-commands`,
  `detect-changes`, `detect-package-manager`, `format-workspace`, `install`,
  `lockfile-snapshot`, `peer-sync`, `regular-dependencies`,
  `upgrade-package-manager`, `upgrade-runtimes`). Each declares its own result
  type, an explicit requirement channel, and a tagged error **only if it can
  actually fail** — four carry `never`
- **Services**: `src/services/` — `Context.Service` + `Layer`, plus stateless
  helper modules; **Layers**: `src/layers/app.ts`; **Schema**: `src/schema/`
  (singular — `domain.ts`, `inputs.ts`, `outputs.ts`); **Rendering**:
  `src/format.ts` (the run's log surface — pure, no services); **Errors**:
  `src/errors/errors.ts`; **Utils**: `src/utils/` (pure helpers)
- **Tests**: `__test__/unit/**` mirrors `src/`; `__test__/integration/**` for
  real-IO suites; `__test__/utils/**` for shared helpers (see Gotchas)
- **Shared configs**: `lib/configs/`; **Build**: Turbo; `typecheck` needs `build`

### Effect-TS Patterns

- **Kit services**: `@effected/github-actions` (`Action`, `ActionInput`,
  `ActionEnvironment`, `ActionOutputs`, `ActionState`, `DryRun`, `GitHubToken`,
  **`GitHubMarkdown`** — the GFM writer, capital H; `GithubMarkdown` was a
  *rename*, not a removal, and this repo hand-rolled a copy for a release on
  that misreading. The local copy (`src/utils/github-markdown.ts`) is now
  **deleted**; only `bold`/`rule` have no kit equivalent and they stay in
  `src/utils/markdown.ts`);
  `@effected/github` (`GitHubApp`, `Repo`, `GitBranch`, `GitCommit`, `CheckRun`,
  `PullRequest` — all failing with a single `GitHubError`, discriminated by
  `hasKind`); `@effected/commands` (`Run` free functions over core
  `ChildProcessSpawner` — no `CommandRunner` service); `@effected/git`
  (`Git.status` / `Git.configSet` only — the mutating tier is declined);
  `@effected/npm`, `workspaces`, `lockfiles`, `runtimes`, `semver`, `yaml`.
  Layers are `.layer` /
  `.layer(opts)` **statics on the service class**, not `*Live` constants; services
  expose companion `*Shape` interfaces; workspace layers are **root-bound at
  build**, so their methods are arg-less.
- **Domain services**: `BranchManager`, `PackageManagerUpgrade`, `ConfigDeps`,
  `CatalogConfigDeps`, `RegularDeps`, `ReleaseAge`, `RuntimeUpgrade`, `Lockfile`,
  `Changesets`, `Report` — **every one wired as a `static layer` on the class**,
  the same convention as the kit, declared *in* the class body (a member attached
  after the class is tree-shaken out of `dist` and fails only in production). No
  `*Live` constant survives in `src/services/`. Stateless helpers:
  `detectPackageManager`, `syncPeers`, `fetchModuleCatalogs`, and the
  `workspace-yaml` functions — the `WorkspaceYaml` **tag and layer were deleted**,
  since nothing in `src/` wired them and their only consumer was their own test.
- **Changesets**: `services/changesets.ts` is a thin adapter over
  `Changesets.DepsRegen` (`@savvy-web/silk-effects`, wired as `DepsRegenDefault`),
  which owns the cumulative `merge-base(base) → worktree` diff, consolidation and
  versionable-minus-ignored gating — this repo computes none of it. `plan`
  refreshes workspace discovery, so it sees manifests edited earlier in the run.
- **Errors**: the `ActionError` union is exactly `InvalidInputError` (inputs,
  branch refs, yarn/no-workspace), `FileSystemError`, `ChangesetError` and
  `LockfileError` — every member has a construction site. Kit failures arrive as
  `GitHubError` and `CommandFailedError`/`CommandOutputError`. `GitHubApiError`,
  `GitError`, `PnpmError` and `DependencyUpdateFailures` were **deleted** for
  having none; `__test__/unit/errors/errors.test.ts` pins the exported set, so
  re-adding one fails a test.
- **Effect v4 spellings**: `Context.Service`; `NodeServices.layer`;
  `FileSystem`/`Path` from `effect`, `HttpClient`/`FetchHttpClient` from
  `effect/unstable/http`, `ChildProcess`/`ChildProcessSpawner` from
  `effect/unstable/process`; `Effect.catch`, `Effect.result` (returns a `Result`),
  `Effect.timeoutOrElse`; log levels are string literals set via
  `References.MinimumLogLevel`.
  - **`Schema.TaggedError`, not `Schema.TaggedErrorClass`.** The `*Class` spelling
    existed only on the earlier v4 betas and was renamed back to the v3 name in
    `beta.107`; the curried shape is identical, so the fix is the name alone.
    Worth knowing how this presents: the four class declarations in
    `src/errors/errors.ts` are the *only* real breakage, but their base type
    collapses, so every `new SomeError({...})` in the codebase reports
    "Expected 0 arguments, but got 1" and every field getter reports a missing
    property — 50 errors across 14 files, all of which clear when the four names
    are fixed. Do not go site-by-site; find the declaration.
- **Token**: provisioned in `pre.ts` (credentials via `ActionInput`, fail-fast
  `required` scope check for `contents`/`pull_requests`/`checks: write`), persisted
  to `ActionState`, read back by `GitHubToken.clientLayer()` in `makeAppLayer`,
  revoked in `post.ts`. No `GITHUB_TOKEN` bridge.
- **Tests**: mock via `Layer.succeed`, a service's `layerTest`, or the doubles in
  `__test__/utils/action-doubles.ts`; script commands with `ScriptedSpawner`. Never
  mock `@actions/*` — the kit implements the protocol natively.

### Dogfooding First-Party Dependencies

Every first-party dependency is ours, so a bug or missing API can be fixed **in
its own repo** and dogfooded here before publishing. The action is **bundled** —
`pnpm build` inlines everything into `dist/{pre,main,post}.js` — so a consumer
workflow on `@dev` runs the committed `dist`, not `node_modules`.

| Package | Repo | Link mechanism |
| --- | --- | --- |
| `@savvy-web/silk-effects`, `@savvy-web/github-action-builder`, `@savvy-web/silk` | `savvy-web/systems` (`packages/<name>`) | direct → `pnpm link` |
| `@effected/*` (the whole kit + its transitives) | `spencerbeggs/effected` (one monorepo, `packages/<name>`) | direct + transitive → `link:` override |

- **Direct-only → `pnpm link`** (e.g. `pnpm link ../systems/packages/silk-effects`);
  verify via `node:fs` (NOT `require(...package.json)` — `exports` hides it) or
  `pnpm why <pkg>`.
- **Also transitive → `pnpm-workspace.yaml` `overrides`** targeting
  `link:../../spencerbeggs/effected/packages/<name>/dist/dev/pkg`, then
  `pnpm install`. A bare `pnpm link` would leave the transitive copy on the
  registry version and bundle two copies; verify with
  `find node_modules -path "*@effected/<name>"`.

Procedure: build the library (`pnpm ci:build`) → link/override + `pnpm install` →
keep the declared range correct for the eventual unlinked install → iterate
(`pnpm typecheck`, `pnpm test`, `pnpm build`) → commit the **full dogfood state**
to `dev` (`src` + `dist` + changeset + override + `pnpm-lock.yaml`) → exercise it
via a consumer workflow on `@dev` → **after** the library publishes, remove the
link/override and pin the published range. The override holds a machine-specific
path, so `dev` then only installs with the sibling repos checked out — the
accepted trade-off. Commits must be GPG-signed with the verified key for
`C. Spencer Beggs <spencer@savvyweb.systems>`.

**Currently active:** nothing is **linked** — every first-party dep is on its
published registry version (see `package.json`). `@effect/vitest` reads
`catalog:effect`, so the lockstep with `effect` is now **structural**: the
`effect` catalog pins both to the same beta, and a catalog advance moves them
together with no hand-edit. It used to be an exact literal pin that had to be
bumped manually, which is the failure mode this removed.

There are **no `overrides` entries**. The former `@effect/platform-node-shared`
pin (held at `4.0.0-beta.101` because a caret on a prerelease admitted a
`beta.102` whose peer range the catalog pin did not satisfy) went away with the
`beta.107` advance — the whole graph now resolves a single
`platform-node-shared@4.0.0-beta.107` against a single `effect@4.0.0-beta.107`.

The **duplicate resolutions are also gone**: `@effected/workspaces` and
`@effected/npm` each resolve exactly one copy, so the second workspaces copy that
`@savvy-web/silk-effects` used to drag into `dist` is no longer bundled. Verify
with `pnpm why <pkg>` — the lockfile grep reports which versions exist, never who
pulls them.

## Development & Release Cycle

### The `dev` branch convention

All in-progress work lands on the long-lived **`dev`** branch, never directly on
`main`; `main` always reflects the last released state. The shared release
workflow (`savvy-web/.github/.github/workflows/release.yml`) has a matching `dev`
branch — a caller normally pins `@main`.

### Testing dev-branch builds

Two independent switch points: `.github/workflows/silk-update.yml` here runs
`uses: savvy-web/silk-update-action@v4` (flip to `@dev` to run the committed
dev-branch `dist` against this repo), and `.github/workflows/release.yml` calls
the shared workflow at `@main` (flip to `@dev`). Trigger, `gh run watch`, then
revert once the release is cut.

### Flow: `dev` → `main` → release

Work accumulates on `dev` and merges to `main` (dependency-update PRs arrive via
`promote-deps-to-main.yml`). Push to `main` → **Phase 1** changeset detection and
the release PR on `changeset-release/main`; pushes to that branch → **Phase 2**
validation (build, publish dry-runs, release-notes preview, sticky comment);
merging it → **Phase 3** publish, tags, GitHub release, which fires
`release-sync.yml`.

### `release-sync.yml` / `promote-deps-to-main.yml`

`release-sync.yml` (on `release: [published]`, as the App bot) closes the loop: on
a **stable SemVer >= 1.0.0** tag it moves the `v<major>` alias tag and
**hard-resets `dev` to `main`** — a genuine clobber, safe because `dev` work always
lands in `main` first. Pushes are skipped when the ref already matches;
prerelease/sub-1.0.0 tags are no-ops.

`promote-deps-to-main.yml` opens it: `silk-update.yml` must run with
`source-branch: dev` so its `pnpm/config-deps` PR merges into `dev`, which
triggers this workflow to mint an App token
(`actions/create-github-app-token@v3`) and open a `dev -> main` PR left **open for
review**. Idempotent and non-recursive.

### Code Quality

Biome (lint + format, **tabs**), commitlint (conventional commits + DCO signoff),
husky (`pre-commit` lint-staged, `commit-msg` validation, `pre-push` tests).

### TypeScript

Composite builds with project references, strict mode, ES2022/ES2023.

### Testing

- **Framework**: Vitest with v8 coverage, forks pool (Effect compatibility).
  Current suite: **581 tests**. `@effect/vitest` reads `catalog:effect`, the same
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
- **Read inputs with `ActionInput.*`, never bare `Config`.** The runner exports
  inputs as `INPUT_*` (only spaces mangled), so `Config.string("dependencies")`
  resolves nothing and silently takes its `withDefault` — including `dry-run`, so a
  rehearsal performs a live run. `ActionInput.list` owns the multi-value grammar
  (`src/utils/input.ts` / `parseMultiValueInput` are **deleted**) and **fails on
  absent and empty**, so `Config.withDefault([])` on each list read is load-bearing.
  `readInputs` lives in `src/schema/inputs.ts` (beside the `INPUT_NAMES` tuple)
  and is pinned by `INPUT_*`-keyed tests.
- **The `result` output is the whole run as JSON** (`RunResultDocument`, composed
  from the existing domain schemas rather than a parallel reporting shape),
  emitted **on every exit path** as an empty-run document — never an empty
  string, so a consumer parses unconditionally. Its JSON Schema is **generated**
  into `docs/schema/run-result.schema.json` by `lib/scripts/generate-schema.ts`
  (via `@effected/schemastore` at `^0.3.0`, run under `tsx` — a declared
  devDependency, previously transitive-only); change it by editing the domain
  types and running `pnpm generate-schema`. The four scalar outputs are
  unchanged.
  - **Every shared schema needs an explicit `identifier` annotation**, because
    the beta.107 lowering hoists a reused sub-schema into `$defs` instead of
    inlining it at each use site, and invents a positional name when there is no
    identifier to use. `DependencyType` lowered to `$defs/Union_` on the first
    regeneration after the advance — a generated, position-dependent name in a
    document published at a public `$id`, where a second anonymous union would
    have shifted it to `Union_1`. It now carries
    `identifier: "DependencyType"`. If a regeneration produces a `$defs` key
    matching `Union_`/`Struct_`/similar, that is a missing annotation at the
    definition site, not something to accept into the committed artifact.
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
  `corepackHashFromIntegrity`) into both `packageManager` and
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
  `layerWithConfigDependenciesSubprocess()` combines inline `pnpm-workspace.yaml`
  keys with the replayed config-dependency pnpmfile hooks (`pnpm config get` never
  sees hook-injected values). The **subprocess** variant is mandatory — rspack
  miscompiles the in-process computed dynamic `import()` into a context module —
  and it is what unblocked this adoption. Publish times come from
  `NpmRegistry.publishTimes`. **What stays local is the fail-open posture**: the
  kit fails typed with `CatalogAssemblyFailure`, correct for a library, and this
  action degrades it to "no gate" with a warning in a one-line `Effect.catch` at
  the single call site in `ReleaseAge.layer`, because pnpm re-enforces the gate at
  install. Depth in
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
- **`@effected/package-json` was evaluated and DECLINED on evidence — do not
  re-propose it.** `Package.decode` requires `name` + a strict-semver `version`,
  so it **rejects the private workspace root** this action must edit, and its
  write path reorders keys in a manifest the action then commits to someone
  else's repo (upstream spencerbeggs/effected#286)
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
  `@effected/workspaces` and `@effected/commands` both crossed a `0.x` minor
  during this branch and needed exactly that hand-edit (now at `^0.10.0` /
  `^0.3.0`)
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
