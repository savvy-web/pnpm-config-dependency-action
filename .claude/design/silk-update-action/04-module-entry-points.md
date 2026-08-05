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

# Module Entry Points

[Back to index](./_index.md)

The action ships three entry points wired to the `runs` block in `action.yml`:
`pre: dist/pre.js`, `main: dist/main.js`, `post: dist/post.js` (the build derives
them from `action.config.ts`). The GitHub App token lifecycle spans them — `pre`
provisions, `main` consumes, `post` revokes.

## src/pre.ts - Pre-Phase Entry

`pre.ts` provisions the GitHub App installation token and records the start time
for `post`'s duration report.

Unlike the deleted library's `provision`, the kit's
`GitHubToken.provision` takes credentials **explicitly** rather than reading the
action inputs itself, so `pre.ts` parses them — through `ActionInput`, like every
other input in this action. The scope-check field is named `required`, and it is
verified against what GitHub actually granted before the token is persisted, so a
misconfigured installation fails here in `pre` rather than mid-run in `main` with
a 403 on one request.

```typescript
const state = yield* ActionState;
const env = yield* ActionEnvironment;

yield* state.save(STATE_KEYS.startTime, new StartTimeState({ startedAt: Date.now() }), StartTimeState);

const appId = yield* ActionInput.string("app-client-id");
const privateKey = yield* ActionInput.redacted("app-private-key");
const owner = (yield* env.github).repositoryOwner;

const token = yield* GitHubToken.provision({
 appId,
 privateKey,
 owner,
 required: { contents: "write", pull_requests: "write", checks: "write" },
});
```

`PreLive` is just `GitHubApp.layer` — in the kit that layer is **self-contained**:
there is no octokit auth-app strategy to provide and no separate `FetchHttpClient`
wiring. `ActionState` / `ActionOutputs` come from `Action.run`'s runtime, so they
are not rebuilt here either. The module-level run is
`await Action.run(pre, { layer: PreLive })`, guarded by
`if (process.env.GITHUB_ACTIONS)` so importing the module in tests does not
execute it.

## src/post.ts - Post-Phase Entry

`post.ts` runs after `main`, even on failure. It reports total duration from the
saved `StartTimeState` (read with `state.getOptional`, so a run where `pre` never
recorded one is silent rather than failing), then revokes the token via
`GitHubToken.dispose()` — a no-op if `pre` never provisioned one. The whole
effect is guarded with `Effect.catch` (around `dispose`) plus `Effect.catchDefect`
so a post failure never fails the workflow. `PostLive` is `GitHubApp.layer`,
mirroring `PreLive`.

## src/main.ts - Main-Phase Entry

`main.ts` is intentionally tiny: it calls `Action.run(program)` on the program
imported from `./program.ts`. No `{ layer }` is needed — `program`'s only
requirements are the core services `Action.run` injects; the `GitHubClient` and
the domain services are provided internally by `appLayer`.

```typescript
import { Action } from "@effected/github-actions";
import { program } from "./program.js";

/* v8 ignore next */
Action.run(program);
```

The module-level call is annotated with `/* v8 ignore next */` so coverage is
attributed to `program.ts`. Tests import `readInputs`, `program`, `runCommands`
and `runInstall` directly from `./program.js` without ever evaluating `main.ts`.

## src/state.ts - Cross-Phase State

`pre`, `main` and `post` run as separate Node processes. GitHub Actions persists
state between them as `STATE_*` env vars; `ActionState.save/get` encode/decode
each value through its Schema. `state.ts` defines `StartTimeState` (a
`Schema.Class` holding `startedAt: number`) and `STATE_KEYS`. The token envelope
itself is **not** modelled here — `GitHubToken.provision` persists it under its
own internal key.

## src/program.ts - The Effect Program

**Responsibility:** orchestrate the complete dependency update workflow for the
`main` phase, including the check run and all update steps. Token provisioning
and revocation live in `pre.ts` / `post.ts`, not here.

The module exports four things: `readInputs`, `program`, `innerProgram`, and the
`runCommands` / `runInstall` helpers.

### `readInputs` — the input layer, extracted deliberately

Input parsing is **split out of `program`** rather than inlined, because it is the
only part of the program reachable in-process without the real GitHub/layer
wiring — and leaving it inline is exactly what let an input regression ship green.

Every read goes through **`ActionInput`**, never bare `Config`:

```typescript
export const readInputs = Effect.gen(function* () {
 const branch = yield* ActionInput.string("branch").pipe(Config.withDefault("pnpm/config-deps"));
 const sourceBranch = yield* ActionInput.string("source-branch").pipe(Config.withDefault("main"));
 const rawTargetBranch = yield* ActionInput.string("target-branch").pipe(Config.withDefault(""));
 const targetBranch = resolveTargetBranch(rawTargetBranch, sourceBranch);
 const configDependencies = yield* ActionInput.list("config-dependencies").pipe(
  Config.withDefault<ReadonlyArray<string>>([]),
 );
 const dependencies = yield* ActionInput.list("dependencies").pipe(Config.withDefault<ReadonlyArray<string>>([]));
 const peerLock = yield* ActionInput.list("peer-lock").pipe(Config.withDefault<ReadonlyArray<string>>([]));
 const peerMinor = yield* ActionInput.list("peer-minor").pipe(Config.withDefault<ReadonlyArray<string>>([]));
 const run = yield* ActionInput.list("run").pipe(Config.withDefault<ReadonlyArray<string>>([]));
 // Default "false" — opt-in, matching the upgrade-runtime-* inputs.
 const upgradePackageManager = yield* ActionInput.string("upgrade-package-manager").pipe(Config.withDefault("false"));
 const changesets = yield* ActionInput.boolean("changesets").pipe(Config.withDefault(true));
 const autoMerge = yield* ActionInput.string("auto-merge").pipe(Config.withDefault(""));
 const dryRun = yield* ActionInput.boolean("dry-run").pipe(Config.withDefault(false));
 const timeout = yield* ActionInput.integer("timeout").pipe(Config.withDefault(180));
 // upgrade-runtime-{node,deno,bun} default "false"; runtime-data default "offline".
 // …validation below…
});
```

**Why this matters (the regression it pins):** GitHub exports inputs as `INPUT_*`
with only spaces mangled — `dependencies` → `INPUT_DEPENDENCIES`,
`upgrade-runtime-node` → `INPUT_UPGRADE-RUNTIME-NODE` (the dash survives). A bare
`Config.string("dependencies")` looks up the literal name `dependencies`, finds
nothing under the runner and silently takes its `withDefault`. Every input then
resolves to its default and every step reports "not configured" while the
workflow plainly configured it — including `dry-run`, so a workflow asking to
rehearse performed a live run. `program.inputs.test.ts` injects a runner-shaped
environment through `ActionInput.layer`, so reverting to bare `Config` fails every
assertion. (Upstream has since also made `Action.run` install an ActionInput-aware
provider — defense in depth; the accessors remain the API.)

`ActionInput.list` supplies the multi-value grammar (newline lists with `-` or `*`
bullets, `#` comment lines dropped before bullet-stripping, JSON arrays, commas)
that used to live in this repo's `src/utils/input.ts`, now **deleted** along with
`parseMultiValueInput`. `list` fails on an absent **and** on an empty input, so
the `Config.withDefault([])` on each list read is load-bearing, not decoration.

Validation performed in `readInputs`:

- `upgrade-package-manager` and each `upgrade-runtime-*` value must be one of the
  input's keywords or a parseable semver range — checked with `Range.parse` from
  `@effected/semver`, raising `InvalidInputError` on failure. (An earlier note here
  warned that the static alias was tree-shaken out of the bundled dist; that was
  fixed upstream — see @./01-dependencies.md.)
- At least one update type must be active. Since `upgrade-package-manager`
  defaults to `"false"`, a workflow configuring nothing now fails here.
- `peer-lock` / `peer-minor` must not overlap; peer entries matching no
  `dependencies` pattern warn.
- An unrecognized `runtime-data` value warns and falls back to `offline`.

### `program` — layer composition and timeout

```typescript
export const program = Effect.gen(function* () {
 const { inputs, dryRun, timeout, runtimeLive } = yield* readInputs;

 const env = yield* ActionEnvironment;
 // The kit has no Action.resolveLogLevel — ActionEnvironment.isDebug is the
 // seam that reads the runner's step-debug flag (RUNNER_DEBUG/ACTIONS_STEP_DEBUG).
 const effectLogLevel = (yield* env.isDebug) ? "Debug" : "Info";
 const headSha = (yield* env.github).sha;

 const appLayer = makeAppLayer(dryRun, { runtimeLive });
 yield* innerProgram(inputs, dryRun, headSha, appLayer)
  .pipe(Effect.provideService(References.MinimumLogLevel, effectLogLevel))
  .pipe(Effect.timeoutOrElse({
   duration: Duration.seconds(timeout),
   orElse: () => Effect.fail(new Error(`Action timed out after ${timeout} seconds`)),
  }));
});
```

`makeAppLayer` builds the `GitHubClient` from `GitHubToken.clientLayer()` (see
`src/layers/app.ts`), which reads the token envelope from `ActionState` — no
`process.env.GITHUB_TOKEN` bridge and no token plumbing in `program.ts`.

### `innerProgram(inputs, dryRun, headSha, appLayer)`

The orchestration body. It provides `appLayer` at two levels (outer, and again
inside the `withCheckRun` callback, because that callback signature requires
`R = never`).

Inside the check run it:

1. Calls `detectPackageManager()` **first** — inside the check run, like the
   branch validation and for the same reason: an unsupported workspace (yarn, or
   no workspace root) must fail with a check run in the GitHub UI rather than an
   invisible early exit.
2. Logs a "Run context" block (package manager + evidence, workspace root +
   package count, lockfile name, branch triple, mode/changesets/runtime-data).
3. Runs `BranchManager.validateBranches` before `BranchManager.manage`, so a
   missing ref fails before the branch is reset.
4. Threads `detected.root` — **not** `process.cwd()` — into every step that reads
   or writes files, and `detected.pm` into every dispatch point.
5. Threads the resolved `targetBranch` into `Report.createOrUpdatePR(branch,
   base, …)` as the PR base and into `Changesets.create(detected.root,
   targetBranch)` as the diff baseline, running
   `BranchManager.ensureBaseHistory(targetBranch)` first.

Its logging contract is part of its design, and is what `program.inner.test.ts`
asserts on: every skipped step states a reason, dispatch decisions name the path
and the evidence, and the one non-benign skip (an unsatisfiable
`upgrade-package-manager` range) reports at **warning** while "disabled" and
"already current" stay at info.

`innerProgram` requires the domain services (`BranchManager`,
`PackageManagerUpgrade`, `RuntimeUpgrade`, `ConfigDeps`, `CatalogConfigDeps`,
`RegularDeps`, `Changesets`, `Report`), the standalone helpers
(`detectPackageManager`, `captureLockfileState`, `compareLockfiles`, `syncPeers`,
`formatWorkspaceYaml`), the kit services (`ActionOutputs`, `CheckRun`, `Repo`)
and `WorkspaceDiscovery` plus `ChildProcessSpawner`.

### `runCommands(commands)`

Executes each custom command sequentially via
`Run.collect(ChildProcess.make("sh", ["-c", command]))`. `Run.collect` treats a
non-zero exit as a **result**, so the failure branch is driven by the exit code
and the surrounding `Effect.catch` covers only a genuine spawn failure. All
commands are attempted; failures are collected and returned as
`{ successful, failed }`.

### `runInstall(pm, workspaceRoot?)`

Regenerates the lockfile, dispatched on the package manager, with every command
anchored at `workspaceRoot`:

- **pnpm:** `pnpm clean --lockfile` then `pnpm install --frozen-lockfile=false`.
- **bun:** `bun install --force`.
- **npm:** remove `package-lock.json` via `node:fs` (not a shelled `rm` — it does
  not exist on a Windows runner) then `npm install`.

It regenerates rather than repairs because the action mutates all three inputs to
resolution — the manager version, the manager's config, and the declared ranges —
and a repair-only install (pnpm's `--fix-lockfile`) never re-runs resolution under
the changed inputs, so it can commit an inconsistent lockfile (an upstream peer
range moving leaves a required peer unfilled → `ERR_MODULE_NOT_FOUND` for the
consumer). It uses `Run.text`, which fails typed on a non-zero exit, so an install
failure aborts the run.

### Required GitHub App Permissions

Passed to `GitHubToken.provision({ required })` in `pre.ts` for the fail-fast
scope check:

- `contents: write` — push commits and branches
- `pull_requests: write` — create and update PRs
- `checks: write` — create and update check runs
