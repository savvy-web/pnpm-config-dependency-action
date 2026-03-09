# Effect Patterns

[Back to index](./_index.md)

## Service Architecture

Services are organized in two tiers:

1. **Library services** from `@savvy-web/github-action-effects` (infrastructure)
2. **Domain services** defined in `src/services/` (application logic)

### Library Services

**Action plumbing** (provided by `Action.run()` automatically):

- `ActionOutputs` - Set outputs (`set`), mask secrets (`setSecret`), write job
  summary (`summary`), fail the action (`setFailed`)
- `ActionLoggerLayer` - Routes `Effect.logDebug` to `core.debug()`, `Effect.logInfo`
  to `core.info()`, etc.
- `NodeContext.layer` - Platform layer provided automatically

**Token lifecycle:**

- `GitHubApp` / `GitHubAppLive` - Generate and automatically revoke GitHub App tokens
  via `withToken(appId, privateKey, callback)`

**Infrastructure services** (constructed from token inside `GitHubApp.withToken()`):

- `GitHubClient` / `GitHubClientLive(token)` - Octokit wrapper with `rest()` and `repo`
- `GitBranch` / `GitBranchLive` - Branch CRUD: `exists`, `create`, `delete`, `getSha`
- `GitCommit` / `GitCommitLive` - Git Data API: `createTree`, `createCommit`, `updateRef`
- `CheckRun` / `CheckRunLive` - Check run lifecycle: `withCheckRun`, `complete`
- `PullRequest` / `PullRequestLive` - PR CRUD + auto-merge via GraphQL
- `NpmRegistry` / `NpmRegistryLive` - npm registry queries (version, integrity)
- `CommandRunner` / `CommandRunnerLive` - Shell command execution: `exec`, `execCapture`
- `DryRun` / `DryRunLive(flag)` - Dry-run mode flag

### Domain Services (src/services/)

Each domain service uses `Context.Tag` + `Layer`:

- `BranchManager` / `BranchManagerLive` - Depends on `GitBranch`, `GitCommit`, `CommandRunner`
- `PnpmUpgrade` / `PnpmUpgradeLive` - Depends on `CommandRunner`
- `ConfigDeps` / `ConfigDepsLive` - Depends on `NpmRegistry`
- `RegularDeps` / `RegularDepsLive` - Depends on `NpmRegistry`
- `Report` / `ReportLive` - Depends on `PullRequest`

Stateless services (`Lockfile`, `Changesets`, `WorkspaceYaml`) export standalone
helper functions used directly by `main.ts`.

### Layer Composition

All layers are wired together in `src/layers/app.ts`:

```typescript
// Action.run provides plumbing services + GitHubApp
Action.run(program, GitHubAppLive);

// Inside program:
const ghApp = yield* GitHubApp;
yield* ghApp.withToken(appId, privateKey, (token) =>
 Effect.gen(function* () {
  const appLayer = makeAppLayer(token, dryRun);
  yield* Effect.provide(innerProgram(inputs, dryRun), appLayer);
 }),
);
```

`makeAppLayer` separates library layers from domain layers, then uses
`Layer.provideMerge` to wire domain layers on top of library layers.

## Error Handling Strategy

Effect distinguishes between **expected errors** (typed, recoverable) and **unexpected errors** (defects):

**Expected Errors (Typed):**

- `PnpmError` - pnpm command failures
- `GitError` - git operation failures
- `GitHubApiError` - API call failures
- `InvalidInputError` - validation failures
- `FileSystemError` - file read/write failures
- `LockfileError` - lockfile parsing failures

**Strategy by Error Type:**

| Scenario | Strategy | Effect Pattern |
| --- | --- | --- |
| Critical errors | Fail fast | `Effect.fail()` |
| Batch operations | Accumulate | Sequential loop with `Effect.catchAll()` |
| Transient failures | Retry | `Effect.retry(Schedule)` |
| Optional features | Graceful degradation | `Effect.catchAll()` |

## Typed Errors with Schema.TaggedError

```typescript
import { Schema } from "effect";

/** pnpm command execution error */
export class PnpmError extends Schema.TaggedError<PnpmError>()("PnpmError", {
 command: NonEmptyString,
 dependency: Schema.optional(Schema.String),
 exitCode: Schema.Number.pipe(Schema.int()),
 stderr: Schema.String,
}) {
 get message() {
  return `pnpm ${this.command} failed (exit ${this.exitCode}): ${this.stderr}`;
 }
}
```

## Resource Management

### Token Lifecycle via GitHubApp.withToken

Token generation and revocation are handled automatically by the library:

```typescript
const ghApp = yield* GitHubApp;
yield* ghApp.withToken(appId, privateKey, (token) =>
 Effect.gen(function* () {
  // Token is valid here
  // Automatically revoked when this callback completes (success or failure)
 }),
);
```

### Check Run Lifecycle via CheckRun.withCheckRun

Check runs are automatically finalized even on failure:

```typescript
const checkRunService = yield* CheckRun;
yield* checkRunService.withCheckRun(name, headSha, (checkRunId) =>
 Effect.gen(function* () {
  // Check run is "in_progress" here
  // Use checkRunService.complete(checkRunId, conclusion, output) to finalize
 }),
);
```

## Running the Effect Program

```typescript
import { Action, ActionOutputs, GitHubApp, GitHubAppLive } from "@savvy-web/github-action-effects";
import { Duration, Effect } from "effect";
import { makeAppLayer } from "./layers/app.js";

export const program = Effect.gen(function* () {
 const inputs = yield* Action.parseInputs({ ... });
 const ghApp = yield* GitHubApp;
 yield* ghApp.withToken(inputs["app-id"], inputs["app-private-key"], (token) =>
  Effect.gen(function* () {
   const appLayer = makeAppLayer(token, inputs["dry-run"]);
   yield* Effect.provide(innerProgram(inputs, inputs["dry-run"]), appLayer);
  }),
 );
});

Action.run(
 program.pipe(
  Effect.timeoutFail({ duration: Duration.seconds(180), ... }),
  Effect.catchAll((error) => ...),
 ),
 GitHubAppLive,
);
```

**Testing:** The `program` is exported for testability. Tests mock
`@savvy-web/github-action-effects` via `vi.mock()` to prevent module-level
`Action.run` execution, then test the exported `program` Effect directly
with mock service layers.
