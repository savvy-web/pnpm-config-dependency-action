# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Project Status

This is a **GitHub Action** that updates config dependencies, regular and peer
dependencies, the package manager itself, and `devEngines.runtime` entries
(node/deno/bun). It runs as **three phases**: `src/pre.ts` provisions the GitHub
App token (`GitHubToken.provision`), `src/main.ts` is a thin `Action.run(program)`
wrapper, `src/post.ts` reports duration and revokes the token. The testable Effect
program (`readInputs`, `program`, `innerProgram`, `runCommands`, `runInstall`)
lives in `src/program.ts`; cross-phase state in `src/state.ts`.

It runs on **Effect v4** (`effect@4.0.0-beta.101` via `catalog:effect`, injected
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

pnpm vitest run __test__/unit/services/regular-deps.test.ts   # single file
pnpm vitest run --testNamePattern="parsePnpmVersion"          # by name
```

## Architecture

### Repository Structure

- Single-package GitHub Action (not a monorepo); no barrel re-exports — direct
  imports everywhere
- **Entry points**: `src/pre.ts`, `src/main.ts`, `src/post.ts` (derived from
  `action.config.ts` by the builder); orchestration in `src/program.ts`
- **Services**: `src/services/` — `Context.Service` + `Layer`, plus stateless
  helper modules; **Layers**: `src/layers/app.ts`; **Schemas**:
  `src/schemas/domain.ts`; **Errors**: `src/errors/errors.ts`; **Utils**:
  `src/utils/` (pure helpers)
- **Tests**: `__test__/unit/**` mirrors `src/`; `__test__/integration/**` for
  real-IO suites; `__test__/utils/**` for shared helpers (see Gotchas)
- **Shared configs**: `lib/configs/`; **Build**: Turbo; `typecheck` needs `build`

### Effect-TS Patterns

- **Kit services**: `@effected/github-actions` (`Action`, `ActionInput`,
  `ActionEnvironment`, `ActionOutputs`, `ActionState`, `DryRun`, `GitHubToken`);
  `@effected/github` (`GitHubApp`, `Repo`, `GitBranch`, `GitCommit`, `CheckRun`,
  `PullRequest` — all failing with a single `GitHubError`, discriminated by
  `hasKind`); `@effected/commands` (`Run` free functions over core
  `ChildProcessSpawner` — no `CommandRunner` service); `@effected/npm`,
  `workspaces`, `lockfiles`, `runtimes`, `semver`, `yaml`. Layers are `.layer` /
  `.layer(opts)` **statics on the service class**, not `*Live` constants; services
  expose companion `*Shape` interfaces; workspace layers are **root-bound at
  build**, so their methods are arg-less.
- **Domain services**: `BranchManager`, `PackageManagerUpgrade`, `ConfigDeps`,
  `CatalogConfigDeps`, `RegularDeps`, `ReleaseAge`, `RuntimeUpgrade`, `Lockfile`,
  `Changesets`, `Report`; stateless helpers `detectPackageManager`, `syncPeers`,
  `fetchModuleCatalogs`, `WorkspaceYaml`.
- **Changesets**: `services/changesets.ts` is a thin adapter over
  `Changesets.DepsRegen` (`@savvy-web/silk-effects`, wired as `DepsRegenDefault`),
  which owns the cumulative `merge-base(base) → worktree` diff, consolidation and
  versionable-minus-ignored gating — this repo computes none of it. `plan`
  refreshes workspace discovery, so it sees manifests edited earlier in the run.
- **Errors actually raised**: `InvalidInputError` (inputs, branch refs,
  yarn/no-workspace), `FileSystemError`, `ChangesetError`, `LockfileError`, plus
  kit `GitHubError` and `CommandFailedError`/`CommandOutputError`. `GitHubApiError`
  and `PnpmError` remain in the union but are **no longer constructed**.
- **Effect v4 spellings**: `Context.Service`; `NodeServices.layer`;
  `FileSystem`/`Path` from `effect`, `HttpClient`/`FetchHttpClient` from
  `effect/unstable/http`, `ChildProcess`/`ChildProcessSpawner` from
  `effect/unstable/process`; `Effect.catch`, `Effect.result` (returns a `Result`),
  `Effect.timeoutOrElse`; log levels are string literals set via
  `References.MinimumLogLevel`.
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
published registry version (see `package.json`; `@effect/vitest` pinned exactly in
lockstep with `effect`). There **is** one `overrides` entry, unrelated to
dogfooding: `@effect/platform-node-shared` is held at `4.0.0-beta.101`, because
`@effect/platform-node@4.0.0-beta.101` depends on it at `^4.0.0-beta.101` and a
caret on a prerelease admits `beta.102`, whose peer range (`effect
^4.0.0-beta.102`) the `catalog:effect` pin does not satisfy. It is bundled into
`dist`, so the skew is not academic. Drop the override once
`@effected/pnpm-plugin-effect` ships a catalog on `beta.102`. Duplicate
resolutions of `@effected/workspaces` (0.8.0) and `@effected/npm` (0.4.0) come
entirely from the `@vitest-agent/plugin` devDependency tree, never reach the
shipped artifact, and clear when it bumps.

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
  `@effect/vitest` is pinned exactly to `effect`'s beta and must move in lockstep;
  a few suites use `it.effect`, real-IO suites deliberately do not.
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
  `readInputs` is extracted and pinned by `INPUT_*`-keyed tests.
- **Tests are not co-located**: every unit suite lives in `__test__/unit/**`
  mirroring `src/`. `__test__/utils/**` is **reserved by AgentPlugin for helpers and
  excluded from collection** — a `.test.ts` there silently never runs; keep helpers
  as plain `.ts`, pinned from `__test__/unit/doubles.test.ts`.
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
- `runInstall` **regenerates** the lockfile rather than repairing it (pnpm:
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
  would reject (`ERR_PNPM_NO_MATURE_MATCHING_VERSION`). The gate combines inline
  `pnpm-workspace.yaml` keys **and** a node-subprocess replay of config-dependency
  pnpmfile hooks (`pnpm config get` never sees hook-injected values, and the rspack
  bundle cannot host the in-process dynamic import); publish times come from
  `NpmRegistry.publishTimes`. The whole path **fails open**. Depth in
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
- **`Run.text` trims**, which corrupts column-aligned output: read
  `git status --porcelain` with `Run.collect` (see `gitRaw` in `services/branch.ts`).
  Status is always queried with `-c core.fileMode=false` — exec-bit-only flips do
  not survive the content-based API commit and would produce an empty commit
- Auto-merge requires GraphQL (no REST endpoint) and is a **separate**
  `setAutoMerge` call whose failure degrades to a warning
- `action.config.ts`: `build.nativeDynamicImports` lists
  `@changesets/apply-release-plan` only, so rspack preserves its fully dynamic
  `await import()`. `@effected/workspaces`' `ConfigDependencyHooks` has the same
  pattern but must **not** be listed (the builder's ignore-loader throws); its
  "Critical dependency" warning is benign. First-party dynamic imports use an inline
  `/* webpackIgnore: true */` instead (`src/services/module-catalogs.ts`), asserted
  post-build by `scripts/assert-native-dynamic-import.mjs`. The `build.ignore`
  cyclonedx entries are **vestigial**. Rationale in
  `@./.claude/design/silk-update-action/01-dependencies.md`
