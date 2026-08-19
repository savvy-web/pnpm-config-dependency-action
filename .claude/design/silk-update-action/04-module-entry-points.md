---
status: current
module: silk-update-action
category: architecture
created: 2026-02-20
updated: 2026-08-05
last-synced: 2026-08-05
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
imported from `./program.ts`. No `{ layer }` is passed — `program`'s only
requirements should be the core services `Action.run` injects; the `GitHubClient`
and the domain services are provided internally by `appLayer`.

**Read "should be" literally: that is an invariant this file cannot enforce, and
it has been violated in a shipped release.** `Action.run` is declared with an
*optional* `options` parameter
(`<E, R = never>(program: Effect<void, E, ActionServices | R>, options?: ActionRunOptions<R>)`,
`@effected/github-actions/index.d.ts:803`), so `R` infers to whatever the program
still requires and a bare `Action.run(program)` typechecks at **any** `R`. There
is no "you forgot a layer" error here, ever. In v4.6.0 that `R` was
`PackageJsonFile`, and every run in every consumer repo died ~30ms in with
`Service not found: @effected/package-json/PackageJsonFile` — before the check run
was created, so the failure was invisible in the GitHub UI.

What enforces it now is **`__test__/unit/layers/app.test.ts`**, not this call
site: a type-level assertion that `Exclude<AppLayerRequirements, ActionServices>`
is `never`, read off `ReturnType<typeof makeAppLayer>`. Tests are inside the tsc
project, so it fails `pnpm typecheck` at pre-commit and in CI rather than only in
a test run, and it names the missing service in the compiler error. Its three
blind spots — and the reason it does not cover *broken* wiring, only *missing*
wiring — are in @./09-project-status.md.

```typescript
import { Action } from "@effected/github-actions";
import { program } from "./program.js";

/* v8 ignore next 3 -- entry-point guard, only runs in GitHub Actions */
if (process.env.GITHUB_ACTIONS) {
 await Action.run(program);
}
```

All three entry points carry the **same `process.env.GITHUB_ACTIONS` guard**, not
just `pre` and `post`. Without it, merely importing the module runs the whole
action as a side effect in any process that touches it — which a test file, a
coverage pass or an editor's module graph will do. The guard is annotated
`/* v8 ignore next 3 */` so coverage is attributed to `program.ts`.

Tests import what they need from the module that now owns it: `program` and
`innerProgram` from `./program.js`, `readInputs` from `./schema/inputs.js`,
`runCommands` from `./steps/custom-commands.js` and `runInstall` from
`./steps/install.js` — none of which evaluates `main.ts`.

## src/state.ts - Cross-Phase State

`pre`, `main` and `post` run as separate Node processes. GitHub Actions persists
state between them as `STATE_*` env vars; `ActionState.save/get` encode/decode
each value through its Schema. `state.ts` defines `StartTimeState` (a
`Schema.Class` holding `startedAt: number`) and `STATE_KEYS`. The token envelope
itself is **not** modelled here — `GitHubToken.provision` persists it under its
own internal key.

## src/schema/inputs.ts - The Input Contract

`readInputs` no longer lives in `program.ts`. It sits in `src/schema/inputs.ts`
alongside the `INPUT_NAMES` tuple, which mirrors `action.yml` **as data so the
mirror can be checked rather than assumed** — `__test__/unit/schema/inputs.test.ts`
reads the manifest and compares. A tuple rather than a loose array, so
`InputName` is the exact union of declared names and a typo cannot typecheck.

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
rehearse performed a live run. `__test__/unit/schema/inputs.test.ts` injects a
runner-shaped environment through `ActionInput.layer`, so reverting to bare
`Config` fails every assertion. (Upstream has since also made `Action.run` install
an ActionInput-aware provider — defense in depth; the accessors remain the API.)

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
- `auto-merge` must be `""`, `"merge"`, `"squash"` or `"rebase"`. Validated
  rather than cast, so a typo fails here instead of reaching the GraphQL
  mutation as an invalid enum. The parsed value is typed as that union, which is
  what lets it be threaded to `setAutoMerge` without a cast downstream.
- `runtime-data` must be `"offline"` or `"live"`. **This now fails rather than
  warning and falling back** — an earlier version logged a warning and used
  `offline`. Silently resolving runtime versions from the bundled snapshot when
  the workflow asked for live data is the same class of quiet wrong answer as an
  input that never arrived: the run reports success having answered a question
  nobody asked.

## src/schema/outputs.ts - The Output Contract

The mirror-as-data pattern again: `OUTPUT_NAMES` is a tuple of every output
`action.yml` declares, checked against the manifest by
`__test__/unit/schema/outputs.test.ts`. `emitOutputs` writes **every** declared
name at once, so a caller cannot publish a partial set by accident — the failure
it exists to prevent is an output the manifest declares and the run never sets,
which a consuming workflow reads as an empty string rather than as the value the
action would have chosen.

There are five outputs: the four original scalars (`pr-number`, `pr-url`,
`updates-count`, `has-changes`) plus **`result`**, the whole run as one JSON
document. See `RunResultDocument` in @./03-type-definitions.md for the schema.

**The baseline is published before any work, not from a failure handler.** This
is the load-bearing decision in the module:

```typescript
yield* emitOutputs(initialOutputs);   // first statement in `program`
const { inputs, dryRun, timeout, runtimeLive } = yield* readInputs;
```

Emitting up front guarantees every declared output has a value on every exit
path — including a failure inside `readInputs` itself, which is the earliest
thing that can abort the run. The obvious alternative, re-emitting the baseline
from `Effect.onError`, is **worse and was rejected**: a failure handler that
re-emits also *overwrites* anything a step already published, so a run that
opened a PR and then failed later would report `pr-number: ""` and
`has-changes: false`. That is not a conservative default, it is a false
statement about work that actually happened. Writing the baseline first and
letting steps refine it gives the same total-coverage guarantee with no lying.

`initialOutputs.result` is a full **empty-run document, not an empty string** —
so a consumer can call `fromJSON(...)` unconditionally rather than guarding. A
baseline of `""` would push the guard onto every reader, which is the same
defect as an unset scalar wearing a different hat.

## src/program.ts - Composition

**Responsibility:** compose the `main` phase — read inputs, run the steps in
order, fold their results into outputs, report. Token provisioning and
revocation live in `pre.ts` / `post.ts`; each step's *body* lives in its own
module under `src/steps/`.

`program.ts` issues **no I/O primitive and builds no strings of its own**. State
the invariant that precisely, because the looser version — "performs no I/O" —
is **false**, and was asserted here until it was checked: `program.ts` still
calls `readWorkspaceYaml` and `compareLockfiles`, both of which read from disk.
Direct primitives moved out (the `git status` call last, which is why
`steps/detect-changes.ts` exists); two service helpers did not.

The falsifiability test has to match the claim, and the obvious one does not.
Grepping for `Run.*`, `ChildProcess.*` or `node:fs` returns **clean** on this
module and always would — a call to a helper that reads is still a read, and no
search for primitives can see it. So: **to check this invariant, follow the
callees, not the imports.** The narrow grep is what let the false version stand.

Those two calls are a candidate for extraction into steps, which would make the
stronger claim true. Not yet done, and deliberately not folded into the
behavior-preserving restructure.

The module exports two things: `program` and `innerProgram`.

### `program` — layer composition and timeout

```typescript
export const program = Effect.gen(function* () {
 yield* emitOutputs(initialOutputs);   // see the output contract above
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

The orchestration body. It provides `appLayer` **once**.

> **Corrected claim.** This document previously stated that `appLayer` was
> provided "at two levels (outer, and again inside the `withCheckRun` callback,
> because that callback signature requires `R = never`)". The *reason* was
> false, and the redundant second provide existed because of it.
>
> What settles it is the declared type, not an argument about it —
> `node_modules/@effected/github/index.d.ts:1049`:
>
> ```typescript
> readonly withCheckRun: <A, E, R>(
>   name: string,
>   headSha: string,
>   use: (id: number, conclude: ConcludeCheckRun) => Effect.Effect<A, E, R>,
> ) => Effect.Effect<A, E | GitHubError, R | Repo>;
> ```
>
> `use` is generic in `R` and the requirement propagates to the result, so the
> callback inherits the surrounding context like any other effect. The kit's own
> TSDoc on that member says as much: *"`use` keeps its own `R` and its own `A`,
> unlike the version this replaces, whose callback was `R`-less and so forced
> consumers to build self-contained layers just to use the bracket."*
>
> So the claim was **true of an older kit version and never revisited after the
> upgrade** — the same shape as the `Range.parse` note below and the
> `GithubMarkdown` claim in @./01-dependencies.md. A doc sentence carrying a
> justification outlives the release that justified it; the type declaration
> does not.

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
5. Threads the resolved `targetBranch` into `commitAndPrStep` as the PR base and
   into `Changesets.create(detected.root, targetBranch)` as the diff baseline,
   running `BranchManager.ensureBaseHistory(targetBranch, detected.root)` first.
   Both `ensureBaseHistory` and `commitChanges` take the workspace root
   explicitly — see the arity note in @./05-module-library.md.
6. Assembles the `RunResultDocument` from the same records that drive the scalar
   outputs and the PR body, rather than from a parallel reporting shape, so the
   two cannot disagree about what happened.

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
and `WorkspaceDiscovery` plus `ChildProcessSpawner` — all reached through the
step modules rather than called directly.

## src/steps/ - One Module Per Orchestration Unit

Each step module owns one unit of the workflow and declares three things for itself: its **result type**, its **requirement channel**, and a **tagged error only if it can actually fail**. Exactly **four carry `never`** in the error channel — `custom-commands`, `regular-dependencies`, `upgrade-package-manager` and `upgrade-runtimes` — which is a claim the compiler checks rather than a convention, and is verifiable by reading the four signatures. **Re-verified against all fifteen signatures** when the `configure-status` row below was added, which is the moment a count like this silently stops matching: the new step is not one of the four.

**"git errors" below abbreviates the three `@effected/git` failures** — `GitCommandError`, `NotARepositoryError`, `UnknownRefError` — which every caller of `Git.status` / `Git.configSet` carries as a set. Abbreviated here rather than repeated across four cells; `src/services/branch.ts` already names the same union `GitServiceError`, so read that or the step's own signature for the authoritative channel.

| step | error channel | note |
| --- | --- | --- |
| `detect-package-manager` | `InvalidInputError` | resolves root + manager once; everything downstream reads it |
| `configure-status` | git errors | pins `core.fileMode=false` on the checkout, once, before any status read. **Failure propagates deliberately** — a write that did not take makes every later status read count exec-bit flips as changes, and the run's whole change verdict is then wrong in a way nothing downstream can detect |
| `branch` | `BranchStepError` | validates both refs *before* `GitBranch.upsert` force-resets anything |
| `lockfile-snapshot` | `LockfileError` | runs twice (`"before"` / `"after"`); a missing lockfile is a skip, not a failure |
| `upgrade-package-manager` | `never` | a read/write failure folds into an `error`-kind outcome instead |
| `upgrade-runtimes` | `never` | a resolver failure (including EOL lines) degrades to a warning |
| `config-dependencies` | `FileSystemError` | owns the pnpm / bun / npm dispatch |
| `regular-dependencies` | `never` | `RegularDeps` already degrades per-dependency registry failures internally |
| `peer-sync` | `FileSystemError` | reports "not configured" distinctly from "synced nothing" |
| `install` | `CommandFailedError` \| `CommandOutputError` | `runInstall` lives here |
| `format-workspace` | `FileSystemError` | pnpm-only; logs the reason when it does not apply |
| `custom-commands` | `never` | `runCommands` lives here; returns failures, does **not** conclude |
| `detect-changes` | git errors | the `git status` call; extracted to get the last I/O primitive out of `program.ts`. This cell read `CommandFailedError` \| `CommandOutputError` until now, and **it never drifted — it was wrong in the commit that wrote it** (`5c92284` created the module with the git channel and the row with the command channel, in one change). Same shape as the test count in @./08-testing.md: an edit made *alongside* the change it describes is the one nobody re-checks |
| `changesets` | `ChangesetError` (+ git errors) | delegates wholly to silk's `DepsRegen`; the git errors come from `ensureBaseHistory` |
| `commit-and-pr` | `GitHubError` (+ command and git errors) | one module: the PR must describe a commit that exists |

Two boundaries in that table are deliberate and worth stating, because both look
like candidates for "simplification":

- **`custom-commands` does not conclude the check run or set outputs.** It runs
  every command, collects the failures and *returns* them. Concluding the run
  and publishing outputs are composition concerns — `program.ts` owns them for
  every terminal state, so a step reaching for `conclude` would be the one place
  the run's verdict is decided outside the composition layer. The step reports
  what happened; the program decides what it means.
- **`commit-and-pr` is one module, not two.** The halves share a precondition
  (not a dry run) and an ordering constraint (the PR must describe a commit that
  exists). Splitting them would move that constraint into the composition layer,
  where it is easy to reorder by accident. Their *failure postures* differ,
  though: the commit propagates, while a PR failure degrades to a warning and a
  `null` result, because the commit is already pushed and durable at that point
  and failing the run would report a red job for work that landed.

### `runCommands(commands)` — `steps/custom-commands.ts`

Executes each custom command sequentially via
`Run.collect(ChildProcess.make("sh", ["-c", command]))`. `Run.collect` treats a
non-zero exit as a **result**, so the failure branch is driven by the exit code
and the surrounding `Effect.catch` covers only a genuine spawn failure. All
commands are attempted; failures are collected and returned as
`{ successful, failed }`.

### `runInstall(pm, workspaceRoot?)` — `steps/install.ts`

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

The command lines are labelled for logging by `INSTALL_LABEL` in `format.ts`,
not by strings built in the step — the same single-rendering-surface rule that
keeps `program.ts` string-free.

### Required GitHub App Permissions

Passed to `GitHubToken.provision({ required })` in `pre.ts` for the fail-fast
scope check:

- `contents: write` — push commits and branches
- `pull_requests: write` — create and update PRs
- `checks: write` — create and update check runs
