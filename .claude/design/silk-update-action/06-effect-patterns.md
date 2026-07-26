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
`ChildProcessSpawner.ChildProcessSpawner` (supplied by `NodeServices.layer`).

- `Run.collect(command)` — exit code as a **result** (`succeeded`, `exitCode`,
  `stdout`, `stderr`); only a genuine spawn failure hits the error channel.
- `Run.text` / `Run.lines` / `Run.json` — typed failure on a non-zero exit
  (`CommandFailedError` / `CommandOutputError`).
- `Run.succeeds` — boolean probe.
- `ScriptedSpawner` — the public test fixture.

**`Run.text` trims.** For column-aligned output (`git status --porcelain`) use
`Run.collect` and check `succeeded` yourself; `branch.ts`'s `gitRaw` helper does
exactly this. A service that needs the spawner for several members resolves it
once in the layer and re-provides it (`withSpawner` in `branch.ts`), keeping each
member's `R` free of it.

### npm (`@effected/npm`)

- `NpmRegistry` / `NpmRegistry.layer` (over an `HttpClient`) — `versions`,
  `packageInfo`, `publishTimes`; keyed by (registry, package, version). Being HTTP
  rather than an `npm` subprocess removes the whole class of `~/.npm` cache
  permission failures.
- `ReleaseAgeGate` / `PartialReleaseAgeGate` — the release-age vocabulary the
  local `ReleaseAge` service composes.

### Workspace services (`@effected/workspaces`)

`WorkspaceDiscovery` (`listPackages()`, `importerMap()`), `WorkspaceRoot`
(`find`), `PackageManagerDetector` (`detect`) and `LockfileReader` — all
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

- `BranchManager` / `BranchManagerLive` — `GitBranch`, `GitCommit`,
  `ChildProcessSpawner`
- `PackageManagerUpgrade` / `PackageManagerUpgradeLive` — `NpmRegistry`
- `RuntimeUpgrade` / `RuntimeUpgradeLive` — the three resolvers
- `ReleaseAge` / `ReleaseAgeLive(workspaceRoot?)` — `ChildProcessSpawner`,
  `NpmRegistry`; `ReleaseAgeNoop` is the inert test layer
- `ConfigDeps` / `ConfigDepsLive` — `NpmRegistry`, `ReleaseAge`
- `CatalogConfigDeps` / `CatalogConfigDepsLive` — `NpmRegistry`, `LockfileReader`,
  `HttpClient`, `ChildProcessSpawner`
- `RegularDeps` / `RegularDepsLive` — `NpmRegistry`, `WorkspaceDiscovery`,
  `ReleaseAge`
- `Changesets` / `ChangesetsLive` — `Changesets.DepsRegen`
- `Report` / `ReportLive` — `PullRequest`

Stateless concerns (`detectPackageManager`, `syncPeers`, `fetchModuleCatalogs`,
the `WorkspaceYaml` and `Lockfile` standalone helpers) export functions used
directly by `program.ts`. `syncPeers` and `compareLockfiles` require
`WorkspaceDiscovery` in their environment.

### Layer composition patterns worth copying

- **Capture context, re-provide it.** `CatalogConfigDepsLive` yields
  `Effect.context<…>()` once and pipes `Effect.provide(context)` into its method,
  so the method's `R` is `never` without threading each dependency by hand.
- **Resolve ambient infrastructure once.** `BranchManagerLive` resolves the
  spawner in the layer and wraps each member with `withSpawner`, while
  deliberately *not* resolving `Repo`.
- **`Layer.orDie` at the edge.** `GitHubToken.clientLayer()` and
  `Repo.layerFromConfig()` are `orDie`-d so a missing token or repo is a defect,
  keeping the resulting layer at `E = never` for the `withCheckRun` callback,
  which requires `R = never`.

```typescript
// main.ts — no { layer }; program needs only what Action.run injects:
Action.run(program);

// Inside program (program.ts) — no token plumbing:
const appLayer = makeAppLayer(dryRun, { runtimeLive });
yield* innerProgram(inputs, dryRun, headSha, appLayer);
```

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

`GitHubApiError` and `PnpmError` remain defined in `src/errors/errors.ts` but are
no longer constructed anywhere; see @./03-type-definitions.md.

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

## Typed Errors with Schema.TaggedErrorClass

```typescript
import { Schema } from "effect";

/** Invalid action input or unusable workspace. */
export class InvalidInputError extends Schema.TaggedErrorClass<InvalidInputError>()("InvalidInputError", {
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
import { ActionEnvironment, ActionInput } from "@effected/github-actions";
import { Config, Duration, Effect, References } from "effect";
import { makeAppLayer } from "./layers/app.js";

export const program = Effect.gen(function* () {
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

// main.ts
Action.run(program);
```

**Testing:** tests import `readInputs`, `program`, `innerProgram`, `runCommands`
and `runInstall` directly from `program.ts` — `main.ts` (with its module-level
`Action.run`) is never evaluated. Kit services are injected via `Layer.succeed`
fakes, each service's `layerTest`, or the local doubles in
`__test__/utils/action-doubles.ts`; commands are scripted with
`@effected/commands`' `ScriptedSpawner`. Config inputs are injected through
`ActionInput.layer` with a runner-shaped `INPUT_*` map. See @./08-testing.md.
