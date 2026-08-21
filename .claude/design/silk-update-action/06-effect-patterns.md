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

# Effect Patterns

[Back to index](./_index.md)

## Service Architecture

Services are organized in two tiers:

1. **Kit services** from `@effected/*` (infrastructure)
2. **Domain services** defined in `src/services/` (application logic)

The former all-in-one `@savvy-web/github-action-effects` is deleted; see the
split table in @./01-dependencies.md for the old-name → new-name mapping. Two
naming conventions changed with it: layers are `.layer` / `.layer(...)` **statics
on the service class** rather than `*Live` constants, and services expose a
companion `*Shape` interface for typing a resolved value without yielding it.

### Action runtime services (`@effected/github-actions`)

Provided by `Action.run()`:

- `ActionOutputs` — `set`, `summary`.
- `ActionEnvironment` — repo/sha/ref/actor/owner, plus **`isDebug`**, the seam
  that reads the runner's step-debug flag. (The kit has no
  `Action.resolveLogLevel`; `program.ts` maps `isDebug` to a
  `References.MinimumLogLevel` of `"Debug"` or `"Info"`.)
- `ActionState` — cross-phase state over `GITHUB_STATE`. **Not rebuilt** in
  `makeAppLayer`: it comes from the `Action.run` runtime.
- `ActionInput` — **the input API**. `string` / `boolean` / `integer` /
  `redacted` / `list`, each deriving the runner's mangled `INPUT_*` name and
  treating empty as absent. Bare `Config` reads resolve nothing under the runner
  — see @./04-module-entry-points.md.
- `DryRun` — `DryRun.layerFrom(flag)`.
- `GitHubToken` — `provision({ appId, privateKey, owner, required })` (pre),
  `clientLayer()` (main), `dispose()` (post). Credentials are explicit; the scope
  field is `required`.

### GitHub API services (`@effected/github`)

- `GitHubApp` / `GitHubApp.layer` — self-contained (no octokit auth-app strategy,
  no separate HttpClient to wire). Used only by `pre.ts` / `post.ts`.
- `Repo` / `Repo.layerFromConfig()` — the repository a resource call resolves
  against. Required **per call**, not captured at layer build, which is what keeps
  `Repo.provide(ref)` meaningful for a caller targeting another repository.
- `GitBranch` — `exists`, `sha`, `upsert` (create-or-force-reset, returning
  `"created"` / `"reset"`).
- `GitCommit` — `commitFiles({ branch, message, changes })` with tagged
  `FileContent` / `FileDeletion` members.
- `CheckRun` — `withCheckRun(name, sha, use)`, where `use` receives
  `(id, conclude)` and the run is concluded on **every** exit path.
  `CheckRunOutput.make({ title, summary })` is required (a `Schema.Class`; a bare
  object literal fails typechecking).
- `PullRequest` — `upsert` plus a **separate** `setAutoMerge` GraphQL call.
- GraphQL is a member of the client; there is no `GitHubGraphQL` service.
- **One error type:** every resource call fails with `GitHubError`, discriminated
  via `hasKind` rather than per-service error classes.

### Commands (`@effected/commands`)

Subprocess execution is **free functions over core `ChildProcessSpawner`**, not a
service — there is no `CommandRunner` tag to inject, and a caller's requirement is
`ChildProcessSpawner.ChildProcessSpawner` — which `makeAppLayer` deliberately
does **not** build, leaving it in the requirement channel for `ActionServices`
(whose `NodeServices` member supplies it) to satisfy at the boundary.

- `Run.collect(command)` — exit code as a **result** (`succeeded`, `exitCode`,
  `stdout`, `stderr`); only a genuine spawn failure hits the error channel.
- `Run.text` / `Run.lines` / `Run.json` — typed failure on a non-zero exit
  (`CommandFailedError` / `CommandOutputError`).
- `Run.succeeds` — boolean probe.
- `ScriptedSpawner` — the public test fixture.

**`Run.text` trims**, which corrupts a fixed-width format. That used to constrain
`branch.ts`, whose `gitRaw` helper read `git status --porcelain` through
`Run.collect` for exactly this reason; **both are gone** — status is
`@effected/git`'s `Git.status` now, returning typed entries, so nothing here
parses column-aligned text. The trimming remains true of `Run.text` and worth
knowing; it is no longer a property this action depends on.

A service that needs the spawner for several members resolves it once in the
layer and re-provides it (`withSpawner` in `branch.ts`), keeping each member's
`R` free of it.

### git (`@effected/git`)

Adopted for **reads only**: `Git.status(cwd)` (`git status --porcelain -z` →
`StatusEntry[]`) and `Git.configSet(cwd, key, value)` (writes the checkout's own
config). `Git.layer` requires only `ChildProcessSpawner`, and `Git.layerTest`
supplies the per-member doubles the suites use.

The seven mutating operations `services/branch.ts` performs stay on `Run`, so
that module runs two subprocess mechanisms for git. That is a deliberate trade,
not an oversight — see @./09-project-status.md.

### npm (`@effected/npm`)

- `NpmRegistry` / `NpmRegistry.layer` (over an `HttpClient`) — `versions`,
  `packageInfo`, `publishTimes`; keyed by (registry, package, version). Being HTTP
  rather than an `npm` subprocess removes the whole class of `~/.npm` cache
  permission failures.
- `ReleaseAgeGate` / `PartialReleaseAgeGate` — the release-age vocabulary. The
  **gate is now assembled by `@effected/workspaces`' `WorkspaceCatalogs`**, not
  locally; the local `ReleaseAge` service only wraps it in a fail-open posture
  and does the filtering. See @./05-module-library.md.

### Workspace services (`@effected/workspaces`)

`WorkspaceDiscovery` (`listPackages()`, `importerMap()`), `WorkspaceRoot`
(`find`), `PackageManagerDetector` (`detect`), `LockfileReader` and
**`WorkspaceCatalogs`** (`releaseAgeGate()`, from `0.10.0`) — all
**root-bound at layer build** via static `.layer` / `.layer(opts?)` factories, so
their methods are arg-less. Consumed by `RegularDeps`, `PeerSync`, `Lockfile`,
`CatalogConfigDeps` and `detectPackageManager`.

### Runtime resolver services (`@effected/runtimes`)

`NodeResolver` / `DenoResolver` / `BunResolver`, each its own layer factory.
`makeAppLayer` provides either the bundled `*.layerOffline` layers (default, no
network/auth) or the live `*.layer` layers (falling back to the snapshot on fetch
failure), selected by `runtimeLive`. `resolve({ range })` → `.latest`.

### Silk services (`@savvy-web/silk-effects`)

- `Changesets.DepsRegen` — `plan({ cwd, base })` + `execute(plan)`. Gating lives
  inside it. `plan` refreshes workspace discovery first, so its worktree snapshot
  reads manifests edited earlier in the run rather than the layer-memoized
  discovery cache — the fix for the silent zero-changeset bug.
- `Changesets.DepsRegenDefault` — batteries-included layer bundling
  `PointInTimeWorkspace`, `ConfigInspector`, `WorkspaceDiscovery`, the adaptive
  `PublishabilityDetector` and `ChangesetConfig`, needing only platform services.

### Domain services (src/services/)

**Every one is a `static layer` on its class**, matching the kit — there are no
`*Live` constants left in `src/services/`. Each is declared *in* the class body,
which is load-bearing rather than cosmetic: a member attached by post-class
assignment is tree-shaken out of the bundled `dist`, and it fails only in
production because vitest runs the source.

- `BranchManager.layer` — `GitBranch`, `GitCommit`, `Git`, `ChildProcessSpawner`
- `PackageManagerUpgrade.layer` — `NpmRegistry`, **`PackageJsonFile`**
- `RuntimeUpgrade.layer` — the three resolvers, **`PackageJsonFile`**
- `ReleaseAge.layer` — `WorkspaceCatalogs`, `NpmRegistry`. Not a factory and no
  workspace-root parameter: the root is bound when `WorkspaceCatalogs`' layer is
  built, and the hook-replay subprocess is the kit's now, not ours.
  `ReleaseAge.layerNoop` is the inert variant
- `ConfigDeps.layer` — `NpmRegistry`, `ReleaseAge`
- `CatalogConfigDeps.layer` — `NpmRegistry`, `LockfileReader`, `HttpClient`,
  `ChildProcessSpawner`
- `RegularDeps.layer` — `NpmRegistry`, `WorkspaceDiscovery`, `ReleaseAge`
- `Changesets.layer` — `Changesets.DepsRegen`
- `Report.layer` — `PullRequest`, **`ActionState`**. The second is newer and is the interesting entry in this list: `Report` resolves the DCO sign-off once in its layer body (`resolveSignoff()`, over the token `pre` persisted), so `ActionState` rises into the layer's requirement channel. It is **not** provided in `makeAppLayer` — it is an `ActionServices` member, so it is left in the channel for `Action.run`'s runtime to satisfy at the boundary, exactly like `ChildProcessSpawner` under `BranchManager`. That is the intended shape, and `__test__/unit/layers/app.test.ts` is what distinguishes it from the *unintended* shape (a leftover requirement nothing supplies), which is not otherwise a type error
- `Lockfile.layer` — no requirements

`PreLive` / `PostLive` in the entry points are **not** part of this: they are
aliases for `GitHubApp.layer`, not service layers.

Stateless concerns (`detectPackageManager`, `syncPeers`, `fetchModuleCatalogs`,
the `workspace-yaml` and `Lockfile` standalone helpers) export functions consumed
by the step modules in `src/steps/`, which is what `program.ts` composes — it no
longer calls them directly. `syncPeers` and `compareLockfiles` require
`WorkspaceDiscovery` in their environment.

### Step modules as an error-channel discipline

`src/steps/` is where this codebase's typed-error posture is most visible: each
step declares its own error channel, and **five declare `never`**
(`custom-commands`, `peer-check`, `regular-dependencies`,
`upgrade-package-manager`, `upgrade-runtimes` — re-derived from the signatures,
this sentence having previously said "four" after `peer-check` landed; the
root `CLAUDE.md` warns against carrying the old count forward and this line was
doing exactly that). That is not a comment claiming resilience — it is a
signature the compiler enforces, and it means the degradation happens *inside*
the step rather than being left to a caller who might forget. Each module's doc
comment names its **failure posture** (fail-the-job or degrade-to-warning) in
those words, so the intent and the type can be checked against each other. See
the table in @./04-module-entry-points.md.

### Layer composition patterns worth copying

- **Capture context, re-provide it.** `CatalogConfigDeps.layer` yields
  `Effect.context<…>()` once and pipes `Effect.provide(context)` into its method,
  so the method's `R` is `never` without threading each dependency by hand.
- **Resolve ambient infrastructure once.** `BranchManager.layer` resolves the
  spawner in the layer and wraps each member with `withSpawner`, while
  deliberately *not* resolving `Repo`.
- **`Layer.orDie` at the edge.** `GitHubToken.clientLayer()` and
  `Repo.layerFromConfig()` are `orDie`-d so a missing token or repo is a defect
  rather than an error every caller must handle, keeping the resulting layer at
  `E = never`.
- **Provide the app layer once.** `innerProgram` provides `appLayer` a single
  time, around the whole body. It used to provide it a second time *inside* the
  `withCheckRun` callback, justified by "that callback requires `R = never`" —
  which was false. `withCheckRun` is generic in `R`
  (`use: (id, conclude) => Effect<A, E, R>` returning
  `Effect<A, E | GitHubError, R | Repo>`, `@effected/github/index.d.ts:1049`), so
  the callback inherits the surrounding context like any other effect. The claim
  was true of an older kit whose callback *was* `R`-less; the kit's own TSDoc
  notes the change. Full write-up in @./04-module-entry-points.md.

```typescript
// main.ts — no { layer }; program should need only what Action.run injects.
// "Should" is exact: nothing at this call site checks it. See below.
Action.run(program);

// Inside program (program.ts) — no token plumbing:
const appLayer = makeAppLayer(dryRun, { runtimeLive });
yield* innerProgram(inputs, dryRun, headSha, appLayer);
```

### The anti-pattern in the same family: an unprovided service is not a type error

Every pattern above works by keeping a requirement channel honest. **The channel
itself is not checked at the top.** `Action.run` takes an optional `options`:

```typescript
static readonly run: <E, R = never>(
 program: Effect.Effect<void, E, ActionServices | R>,
 options?: ActionRunOptions<R>,
) => Promise<void>;
```

Because `options` is optional, `R` infers to whatever is left over and nothing
demands a layer for it. So the failure mode of the "resolve dependencies in the
layer body" convention is: a service resolved in a layer body rises into
`makeAppLayer`'s requirement channel, `makeAppLayer` does not provide it,
`Action.run(program)` accepts the leftover silently, and the run dies as a
**defect** on the runner. It is not hypothetical — v4.6.0 shipped this way with
`PackageJsonFile` and failed 100% of runs before creating a check run, under a
clean `tsc` and 588 green tests.

The counter-measure is a compile-time assertion over the composed layer, not
discipline at the call site — `__test__/unit/layers/app.test.ts` asserts
`Exclude<AppLayerRequirements, ActionServices>` is `never` and fails
`pnpm typecheck`, naming the missing service. **The generalizable rule:** when a
framework entry point accepts your requirement channel *as a type parameter with
a default*, it is documenting a shape, not enforcing one — the enforcement has to
be written separately, and it belongs where the graph is composed. What would
stop it discriminating (an `any` in the channel, `ActionServices` widening
upstream, or a service resolved in a method rather than a layer body) is in
@./09-project-status.md.

## Error Handling Strategy

Effect distinguishes **expected errors** (typed, recoverable) from **defects**.

**Errors actually flowing through this action:**

- `InvalidInputError` (local) — input validation, branch-ref preflight, and the
  yarn/no-workspace rejection. The kit has no `ActionInputError` successor.
- `FileSystemError` (local) — every manifest / YAML read-write path.
- `ChangesetError` (local) — DepsRegen failures, collapsed by the adapter.
- `LockfileError` (local) — lockfile capture/compare.
- `GitHubError` (kit) — every GitHub resource call, discriminated with `hasKind`.
- `CommandFailedError` / `CommandOutputError` (kit) — subprocess failures.
- `ConfigError` (core) — a malformed/absent input from `ActionInput`.

That list is exhaustive, and `src/errors/errors.ts` defines nothing beyond it.
`GitHubApiError`, `GitError`, `PnpmError` and `DependencyUpdateFailures` were
deleted for having no construction site; see @./03-type-definitions.md.

**Strategy by scenario:**

| Scenario | Strategy | Effect pattern |
| --- | --- | --- |
| Critical errors | Fail fast | `Effect.fail()` |
| Batch operations | Accumulate | Sequential loop with `Effect.catch()` |
| Transient failures | Retry | `Effect.retry(Schedule)` |
| Optional features | Graceful degradation | `Effect.catch()` |
| Non-zero exit that is a *fact*, not a failure | Inspect the result | `Run.collect` |

Graceful degradation is pervasive and deliberate: a per-dependency registry
failure yields an empty version list rather than aborting the batch; release-age
discovery fails open to "no gate"; `setAutoMerge` failure is a warning; a PR
failure degrades to a warning and a `FAILED` step line; `post`-phase failures are
swallowed entirely.

(v4 spellings: `Effect.catch` was `catchAll`, `Effect.catchDefect` was
`catchAllDefect`, `Effect.result` returns a `Result` where `Effect.either` returned
an `Either`, and `Effect.timeoutOrElse` replaced `Effect.timeoutFail`.)

## Typed Errors with Schema.TaggedError

```typescript
import { Schema } from "effect";

/** Invalid action input or unusable workspace. */
export class InvalidInputError extends Schema.TaggedError<InvalidInputError>()("InvalidInputError", {
 field: NonEmptyString,
 value: Schema.optional(Schema.Unknown),
 reason: NonEmptyString,
}) {
 get message() {
  return `Invalid input "${this.field}": ${this.reason}`;
 }
}
```

## Resource Management

### Token lifecycle (three-phase)

`pre.ts` provisions the token (with a fail-fast scope check) and persists the
envelope to `ActionState`; `main` reads it back via `GitHubToken.clientLayer()`;
`post.ts` revokes it. `post` always runs — even when `main` fails — and is guarded
so a revocation failure never fails the workflow.

```typescript
// pre.ts
const token = yield* GitHubToken.provision({
 appId, privateKey, owner,
 required: { contents: "write", pull_requests: "write", checks: "write" },
});

// post.ts
yield* GitHubToken.dispose().pipe(Effect.catch(/* never fail the workflow */));
```

### Check run lifecycle

```typescript
const checkRunService = yield* CheckRun;
yield* checkRunService.withCheckRun(name, headSha, (_id, conclude) =>
 Effect.gen(function* () {
  // …work…
  yield* conclude("success", CheckRunOutput.make({ title, summary }));
 }),
);
```

The kit's `withCheckRun` passes `conclude` into the callback and concludes on
every exit path, so an unhandled failure still closes the check run. `innerProgram`
concludes explicitly for its three terminal states: `failure` (custom commands
failed), `neutral` (no changes) and `success`.

## Running the Effect Program

```typescript
// program.ts
import { ActionEnvironment } from "@effected/github-actions";
import { Duration, Effect, References } from "effect";
import { makeAppLayer } from "./layers/app.js";
import { readInputs } from "./schema/inputs.js";
import { emitOutputs, initialOutputs } from "./schema/outputs.js";

export const program = Effect.gen(function* () {
 // Publish the all-disabled baseline BEFORE any work, so every declared output
 // has a value on every exit path — including a failure in `readInputs` itself.
 yield* emitOutputs(initialOutputs);
 const { inputs, dryRun, timeout, runtimeLive } = yield* readInputs;

 const env = yield* ActionEnvironment;
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

// main.ts — guarded, so importing the module never runs the action
if (process.env.GITHUB_ACTIONS) {
 await Action.run(program);
}
```

**Testing:** tests import each export from the module that owns it — `program` /
`innerProgram` from `program.ts`, `readInputs` from `schema/inputs.ts`,
`runCommands` from `steps/custom-commands.ts`, `runInstall` from
`steps/install.ts` — so `main.ts` (with its module-level, guarded `Action.run`)
is never evaluated. Kit services are injected via `Layer.succeed`
fakes, each service's `layerTest`, or the local doubles in
`__test__/utils/action-doubles.ts`; commands are scripted with
`@effected/commands`' `ScriptedSpawner`. Config inputs are injected through
`ActionInput.layer` with a runner-shaped `INPUT_*` map. See @./08-testing.md.
