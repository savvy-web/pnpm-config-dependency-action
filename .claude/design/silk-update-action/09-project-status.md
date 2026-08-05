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

# Project Status

[Back to index](./_index.md)

## Current State

The action is Effect-first and runs as three phases (`pre` / `main` / `post`)
around the `GitHubToken` token lifecycle. It runs on **Effect v4** and the
**`@effected/*` kit** — `github-actions`, `github`, `commands`, `npm`,
`workspaces`, `lockfiles`, `runtimes`, `semver`, `yaml` — plus
`@savvy-web/silk-effects` for the changeset step. The former all-in-one
`@savvy-web/github-action-effects` is **deleted**; its surface was split across
those kit packages (mapping table in @./01-dependencies.md).

All domain logic is wrapped as Effect services with `Context.Service` + `Layer`,
plus a few standalone helper modules (`detectPackageManager`, `syncPeers`,
`fetchModuleCatalogs`, the `WorkspaceYaml` / `Lockfile` helpers). Layer
composition is centralized in `src/layers/app.ts`.

**Architecture:**

- **Three-phase entry:** `src/pre.ts` provisions the GitHub App installation
  token (`GitHubToken.provision`, explicit credentials parsed via `ActionInput`,
  fail-fast `required` scope check) and records a start time; `src/main.ts` is a
  thin `Action.run(program)` wrapper; `src/post.ts` reports duration and revokes
  the token. The testable pieces (`readInputs`, `program`, `innerProgram`,
  `runCommands`, `runInstall`) live in `src/program.ts`; cross-phase schemas in
  `src/state.ts`.
- **Package-manager dispatch:** `detectPackageManager()` resolves root + manager
  once, inside the check run, and every dispatch point (config deps, install,
  manager upgrade, workspace formatting) reads that one value. pnpm, bun and npm
  are supported; yarn is rejected with `InvalidInputError`.
- **Inputs go through `ActionInput`, never bare `Config`.** `readInputs` is
  extracted and tested against a runner-shaped `INPUT_*` environment.
- **Layer composition:** `makeAppLayer(dryRun, { runtimeLive })` builds the
  `GitHubClient` from `GitHubToken.clientLayer()` (`Layer.orDie`) and `Repo` from
  `Repo.layerFromConfig()`; `ActionState` comes from `Action.run`'s runtime rather
  than being rebuilt. `runtimeLive` selects offline vs live `@effected/runtimes`
  resolvers.
- **Tests are not co-located:** every unit suite lives under `__test__/unit/`
  mirroring `src/`, with reserved helper modules in `__test__/utils/`.
- **No barrel re-exports:** direct imports everywhere.

**Implemented features:**

- Three-phase execution with the `GitHubToken` lifecycle: `provision()` (pre) →
  `clientLayer()` (main) → `dispose()` (post, never fails the workflow). The
  envelope is persisted to `ActionState` (backed by `GITHUB_STATE`) — no
  `process.env.GITHUB_TOKEN` bridge.
- Branch management via `GitBranch.upsert` (create when absent, force-reset to the
  source ref when present), with `validateBranches` failing fast on a missing
  `source-branch` / `target-branch` before the reset.
- Config dependency updates, dispatched on the package manager: **pnpm** edits
  `pnpm-workspace.yaml` (`ConfigDeps`); **bun** merges the config dependency's
  `catalogs` export into `package.json` via a three-way merge against the
  lockfile's installed version (`CatalogConfigDeps` + `fetchModuleCatalogs`),
  emitting `CatalogDelta` records that reach the PR body; **npm** is skipped with a
  warning (no `catalog:` protocol). Resolution uses a conservative range
  synthesized from the current major, never npm's absolute latest.
- Regular dependency updates resolving within each specifier's own range
  (caret-on-zero widened to `>=version <2.0.0`), across `dependencies`,
  `devDependencies` and `optionalDependencies`, reporting the real section type
  per update. Under bun, names owned by the config-dep path are excluded so one
  manifest entry is not bumped twice.
- Release-age gating (`ReleaseAge` over `@effected/npm`'s `ReleaseAgeGate`),
  discovered from inline `pnpm-workspace.yaml` keys plus a subprocess replay of
  config-dependency pnpmfile hooks, combined strictest-wins, with publish times
  from `NpmRegistry.publishTimes`. Fail-open by design.
- Peer dependency range syncing (`peer-lock` / `peer-minor`).
- Package-manager self-upgrade (`PackageManagerUpgrade`) for pnpm, bun and npm,
  driven by `upgrade-package-manager` (`false` — the **default** — / `true` /
  `auto` / a semver range). corepack-managed managers are written hash-pinned into
  both `packageManager` and `devEngines.packageManager`; bun is written bare.
  `upgrade()` always returns an outcome, so a skip reports its `kind`, and the
  `unsatisfiable` kind (a range typed for a different manager) warns.
- `devEngines.runtime` upgrades (`RuntimeUpgrade`) for node/deno/bun: upgrade only,
  never add; always writes the bare exact resolved version; `auto` no-ops on a
  static pin; EOL major lines are skipped with a warning. Runtime bumps never
  create a changeset and never trigger the install.
- Lockfile regeneration per manager (`pnpm clean --lockfile` + install;
  `bun install --force`; unlink `package-lock.json` + `npm install`).
- Workspace YAML formatting (pnpm only), custom command execution with error
  collection, lockfile comparison, changeset creation via silk's `DepsRegen`,
  verified commits via `GitCommit.commitFiles`, PR create/update via
  `PullRequest.upsert` with `setAutoMerge` degrading to a warning, check-run
  lifecycle with an explicit conclusion on every terminal state, and dry-run mode.

**Recent change with a behavioral consequence:** `upgrade-package-manager`'s
default flipped from `"true"` to `"false"` (a breaking change), making it opt-in
and consistent with the `upgrade-runtime-*` inputs. A workflow that configures
**nothing** now fails the "at least one update type must be active" validation
rather than silently performing a package-manager-only run.

**Known loose ends:**

- `action.config.ts`'s `build.ignore` list (`xmlbuilder2`, `libxmljs2`,
  `ajv-formats-draft2019`) is vestigial: it existed for `@cyclonedx/cyclonedx-library`,
  which came in transitively through the deleted `github-action-effects` and no
  longer appears in the lockfile at all. Harmless, but the comment there still
  describes the old provenance.
- Two duplicate resolutions (`@effected/workspaces` 0.8.0, `@effected/npm` 0.4.0)
  come entirely from the `@vitest-agent/plugin` devDependency tree and clear when
  that plugin bumps; neither reaches the shipped artifact.
- **`@effected/package-json` is deliberately NOT adopted** (upstream
  spencerbeggs/effected#286), and the reason is
  measured rather than stylistic. `Package.decode` requires both `name` and
  `version`, with `version` a strict semver — so it rejects a private monorepo
  root (`{ "private": true, "packageManager": …, "devEngines": … }`), which is
  exactly the file `RuntimeUpgrade` and `PackageManagerUpgrade` edit. It also
  rejects a caret `packageManager` pin (`pnpm@^11.20.0`), a form `parsePnpmVersion`
  supports and `PackageManagerUpgrade` reads as a reference. Separately, the
  write path sorts keys canonically, so adopting it would reformat unrelated
  regions of a manifest the action then commits to someone else's repo; the
  current surgical edit (mutate the parsed object, `JSON.stringify` with
  `detectIndent`) preserves key order exactly.

  Four helpers therefore stay, each a **deliberate divergence with its own
  reason** — recorded so the next audit does not re-propose them:

  | helper | why it stays |
  | --- | --- |
  | `parsePnpmVersion` / `formatPnpmVersion` | `PackageManager.FromString` rejects the caret pin (`pnpm@^11.20.0`) these accept and `PackageManagerUpgrade` documents |
  | `findRuntimeEntry` | returns the **live object** inside `devEngines`, so assigning `.version` rewrites in place and preserves the entry's other keys; `DevEngine` decoding yields a detached copy |
  | `detectIndent` | serves the surgical write path that `PackageIndent` would replace only if the kit's writer were adopted |
  | `corepackHashFromIntegrity` | the kit has no SRI (`sha512-<base64>`) → corepack (`sha512.<hex>`) converter — upstream #281 |

- **`@effected/git` is deliberately NOT adopted** (upstream spencerbeggs/effected#279).
  It covers 2 of the 9 local git operations `services/branch.ts` performs, so
  adopting it would leave two subprocess mechanisms in one module while fixing
  nothing; git stays entirely on `Run`. Missing upstream: `-c core.fileMode=false` on
  `status` (spencerbeggs/effected#279, load-bearing here), an explicit-refspec
  `fetch` (load-bearing for single-branch checkouts), `checkout -B`,
  `reset --hard`, `fetch --unshallow`, `branch -f`, and
  `rev-parse --is-shallow-repository`. The `GIT_CONFIG_COUNT` /
  `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` env route **does** reach the child
  (`GitCommand` spawns with `extendEnv: true`, verified against a real repo) but
  can only be set process-globally, which would change every git command in the
  run including silk's DepsRegen — rejected on blast radius. The rename bug the
  kit's `StatusEntry` would have fixed was fixed directly instead; see
  `parseStatusLine` in @./05-module-library.md.
- **Raw `node:fs` / `node:path` use is pervasive and unresolved.** Core
  `FileSystem` / `Path` are ambient (they are members of `ActionServices`), so
  these are drift rather than necessity — the kit's rule is that a raw `node:`
  import is sanctioned only inside `@effected/github-actions` itself. The
  current, **NUL-safe recount** is 14 modules: `format.ts`, `utils/deps.ts`,
  `steps/install.ts`, and `services/{changesets, peer-sync,
  package-manager-upgrade, config-deps, workspace-yaml, catalog-config-deps,
  regular-deps, runtime-upgrade, branch, module-catalogs, lockfile}.ts`.
  `module-catalogs.ts` is the one defensible case (`node:crypto` / `os` / `url`
  for tarball extraction).
  - **Correction to the original audit.** That finding claimed "14 modules" while
    enumerating only 12, and the enumeration omitted `services/lockfile.ts`
    because the grep it came from silently skipped that file — see the
    NUL-byte note below. The count, the list, and each other all disagreed. The
    conclusion — that the drift is pervasive — was right; the evidence presented
    as exhaustive was not. Do not cite the original enumeration.
- **Resolved, worth keeping:** `services/lockfile.ts` used to carry a **raw NUL
  byte** — the separator in `` `${dep.name}\0${dep.depType}` ``, written as a
  literal `U+0000` rather than the `\0` escape. The NUL itself is correct (a
  package name cannot contain one, so it is a safe composite-key separator); the
  raw encoding was not. `file(1)` reported the source as `data`, and **grep
  treated the whole 531-line file as binary and silently skipped it** — returning
  what looks exactly like a clean no-match.
  - That is why the audit enumeration above was wrong, and it is worth
    remembering as a class rather than an incident: a search that returns nothing
    because it could not read the file is indistinguishable, at the call site,
    from a search that returns nothing because there was nothing to find.
  - Fixed by replacing the raw byte with the `\0` escape. The runtime string is
    unchanged — verified both by an escape-equivalence probe
    (`\0` === `String.fromCharCode(0)`) and by `dist/main.js` rebuilding
    **byte-identical**. Note that the test suite could *not* have caught a broken
    escape here: `depKey` is used symmetrically on both sides of every
    comparison, so a wrong separator would still compare equal to itself.

## Settled decisions — do not re-propose without new evidence

These were investigated, rejected on measurement, and are the half of this
record that a fresh audit will otherwise re-derive from scratch. Each names what
would change the answer.

### `@effected/package-json` — not adopted (upstream #286)

Probed before migrating anything, which is why nothing was half-migrated:

- `Package.decode` **requires both `name` and `version`**, so it rejects a
  private monorepo root (`{ "private": true, "packageManager": …,
  "devEngines": … }`) — precisely the manifest `RuntimeUpgrade` and
  `PackageManagerUpgrade` edit. Adoption would turn "edits your manifest" into
  "refuses your repo."
- It also rejects a caret `packageManager` pin (`pnpm@^11.20.0`), a form
  `parsePnpmVersion` supports and this action documents.
- The write path **sorts keys canonically**, so adopting it would reformat
  unrelated regions of a file the action then commits to someone else's repo.

**What would change the answer:** a lenient decode for the workspace-root shape,
and an order-preserving single-field edit. Both are asked for in #286.

**Trap for the next auditor:** this repo's own `package.json` is already sorted
by lint-staged, so the reordering is a no-op *here*. Checking only against this
repo would have made it look safe.

### `@effected/git` — not adopted (upstream #279)

It covers **2 of the 9** local git operations `services/branch.ts` performs.
Missing: `-c core.fileMode=false` on `status` (load-bearing — exec-bit-only
flips do not survive the content-based API commit, so counting them makes an
empty commit and a spurious PR), an explicit-refspec `fetch` (load-bearing on a
single-branch `actions/checkout`, which otherwise never materializes
`origin/<branch>`), `fetch --unshallow`, `checkout -B`, `reset --hard`,
`branch -f`, and `rev-parse --is-shallow-repository`. `refExists` is covered but
unused — branch existence goes through the **API** (`GitBranch.exists`), not git.

Adopting for the remaining two would leave two subprocess mechanisms in one
module while fixing nothing.

**What would change the answer:** the mutating tier landing upstream. The
`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` env route *does*
reach the child (`GitCommand` spawns with `extendEnv: true`, verified against a
real repo), but only process-globally — which would change every git command in
the run including silk's DepsRegen. Rejected on blast radius, not capability.

### `format.ts` and `services/report.ts` stay separate

Two rendering modules, split by sink: `format.ts` renders the **run's** log
output (pure, no services); `report.ts` renders the **PR's** body, summary and
commit message (a `Context.Service` over `PullRequest`). The
single-rendering-surface rule exists to stop rendering scattering through step
bodies — which it does not. Merging them would drag a service dependency into a
pure module or strand `Report`'s statics.

### `lockfile-snapshot` fail-open — argued, not acted on

There is a real argument that a lockfile snapshot is diagnostic (`git status` is
the run's actual change signal) and that `LockfileError` should degrade to
`null` rather than fail the run. It was **deliberately not applied**, because it
surfaced mid-restructure and a behavior change folded into a behavior-preserving
move is unreviewable. The argument is recorded in the step's module doc. It may
well be correct; it needs to land as its own decision.

## How to read the claims in these documents

Several confident assertions in this record turned out to be false, and the
pattern is worth naming because it recurs:

- "The kit deliberately ships no `GithubMarkdown` successor" — asserted across
  **five design docs plus the module doc it lived in** — `01`, `02`, `05`, `07`,
  `09`, and `src/utils/github-markdown.ts`; never `CLAUDE.md`. It ships
  `GitHubMarkdown`; the rename was three characters. *Re-derive with*
  `git grep -in 'successor|consumer policy' 697bbab -- '*.md' 'src/**'`, then
  keep only the hits naming `GithubMarkdown` or "report shaping" — the same
  search also returns four hits for an unrelated and **true** claim, that the kit
  has no `ActionInputError` successor. Conflating the two is how this count was
  first miscorrected: a grep for "no successor" alone returns both, and a grep
  for the exact phrasing returns neither `01` nor `02`, which word it
  differently.
- "`Range.parse` is tree-shaken out of the bundled dist" — true once, fixed
  upstream, and left asserting a hazard that no longer existed.
- The raw-`node:` enumeration claimed 14 modules, listed 12, and the true count
  was 13 — the number, the list, and each other all disagreed.

Each read as evidence and was an author's account of a property. **Where a
document here asserts that something is load-bearing, it should say what would
falsify the claim, or say plainly that it is unverified.** "We believe X, and
here is what would show us wrong" survives being wrong; a confident claim does
not. The concrete habit: *before trusting a green signal, ask what specific
change would have turned it red — if the answer is "nothing", the signal is
decoration.*

**Next steps:**

1. Integration testing with a real GitHub App in CI.
2. Documentation: user guide and troubleshooting.
3. Support for additional changeset strategies beyond `patch`.

## Rationale

### Why Effect Instead of Plain TypeScript/Promises?

**Type-safe error handling:** Effect's type system makes errors explicit in
function signatures, and the compiler ensures you handle them.

**Error accumulation:** a GitHub Action should be resilient. If updating 10
dependencies and 2 fail, the run should continue with the other 8, report all
failures, and still create a PR with the successful updates. Effect makes this
easy with `Effect.all`, `Effect.result` and custom error types — and this codebase
leans on it heavily (per-dependency registry failures, per-runtime resolver
failures, auto-merge failures and PR failures all degrade rather than abort).

**Resource management:** the App token spans three processes and the check run must
close on every path. The token is provisioned in `pre` and revoked in `post` (which
always runs), and `CheckRun.withCheckRun` concludes on every exit path.

**Testing:** Effect programs are pure and composable. Services are mocked with
`Layer.succeed` or each service's `layerTest`, with no module-mocking framework.

### Why Effect-First Service Architecture?

`Context.Service` + `Layer` gives compile-time-verified dependency injection; each
service declares its dependencies in its layer and the compiler ensures they are
satisfied. Adding a service means defining its tag, implementing its layer, and
adding it to `makeAppLayer`.

### Why the `@effected` kit instead of one library?

The all-in-one `@savvy-web/github-action-effects` bundled unrelated concerns —
Actions runtime, GitHub API, npm registry, subprocess execution, Markdown — behind
one dependency, so any consumer of one part paid for all of them (including the
transitive cyclonedx tree this action had to teach its bundler to ignore).
Splitting into focused kit packages made each surface independently versionable
and let the shapes improve: one `GitHubError` instead of per-service error classes,
`upsert` instead of exists/delete/create, `Run` free functions instead of a
`CommandRunner` service, `ActionInput` accessors that actually know the runner's
`INPUT_*` mangling, and `GithubMarkdown` → `GitHubMarkdown` (capital H), which is
a rename rather than a removal. This repo spent a release believing the kit
shipped no markdown writer and hand-rolled one; only `bold` and `rule` genuinely
have no kit equivalent.

### Why Three-Phase (Pre/Main/Post)?

- **Idiomatic client construction.** `GitHubToken.clientLayer()` reads the envelope
  `pre` persisted, so there is no bare client layer and no
  `process.env.GITHUB_TOKEN` bridge.
- **Revokes the token even when `main` fails.** `post` always runs (guarded so it
  never fails the workflow). Tokens also expire after 1 hour regardless.
- **Fails fast on missing scopes.** `pre` passes the `required` permissions to
  `provision`, so a misconfigured App fails there rather than mid-run with a 403.

### Why a Dedicated Branch, Reset Each Run?

Always starting from a clean state is simpler than rebasing, needs no conflict
resolution, and is appropriate because the branch only contains automated updates.
`GitBranch.upsert` performs the reset atomically from the caller's perspective,
which the previous delete-then-create sequence did not.

### Why Changesets Integration?

Changesets is the de facto standard for versioning in pnpm monorepos: automatic
changelog generation, semantic versioning enforcement, release automation
compatibility. The dependency-changeset step is delegated to
`@savvy-web/silk-effects`' `DepsRegen` so the gating rules live in one place and
this action does not re-implement them.

### Why GitHub App Instead of PAT?

Tokens expire in 1 hour, permissions are fine-grained, commits are verified via the
Git Data API without SSH/GPG keys, and it matches how GitHub's own bots behave.

## Related Documentation

**External references:**

- [pnpm Config Dependencies](https://pnpm.io/config-dependencies)
- [bun catalogs](https://bun.sh/docs/install/catalogs)
- [GitHub Apps Authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app)
- [Changesets Documentation](https://github.com/changesets/changesets)
- [Effect Documentation](https://effect.website)
