# Effect Patterns

[Back to index](./_index.md)

## Service Architecture

All services come from `@savvy-web/github-action-effects` (v0.4.0). There are no
custom application services defined in this codebase.

### Library Services

**Action plumbing** (provided by `Action.run()` automatically):

- `ActionOutputs` - Set outputs (`set`), mask secrets (`setSecret`), write job
  summary (`summary`), fail the action (`setFailed`)
- `ActionLoggerLayer` - Routes `Effect.logDebug` to `core.debug()`, `Effect.logInfo`
  to `core.info()`, `Effect.logWarning` to `core.warning()`, `Effect.logError` to
  `core.error()` automatically
- `NodeContext.layer` - Platform layer provided automatically

**Token lifecycle:**

- `GitHubApp` / `GitHubAppLive` - Generate and automatically revoke GitHub App tokens
  via `withToken(appId, privateKey, callback)`

**Domain services** (constructed from token inside `GitHubApp.withToken()` callback):

- `GitHubClient` / `GitHubClientLive(token)` - Octokit wrapper with `rest()` and `repo`
- `GitBranch` / `GitBranchLive` - Branch CRUD: `exists`, `create`, `delete`, `getSha`
- `GitCommit` / `GitCommitLive` - Git Data API: `createTree`, `createCommit`, `updateRef`
- `CheckRun` / `CheckRunLive` - Check run lifecycle: `withCheckRun`, `complete`
- `AutoMerge` - Enable auto-merge via GraphQL
- `CommandRunner` / `CommandRunnerLive` - Shell command execution: `exec`, `execCapture`
- `DryRun` / `DryRunLive(flag)` - Dry-run mode flag

**Declarative input parsing:**

- `Action.parseInputs(schema, validator?)` - Parse and validate action inputs with
  Effect Schema, replacing the deleted `parseInputs` module

### Layer Composition in main.ts

```typescript
// Action.run provides plumbing services + GitHubApp
Action.run(program, GitHubAppLive);

// Inside program:
const ghApp = yield* GitHubApp;
yield* ghApp.withToken(appId, privateKey, (token) =>
 Effect.gen(function* () {
  const ghClient = GitHubClientLive(token);
  const appLayer = Layer.mergeAll(
   ghClient,
   GitBranchLive.pipe(Layer.provide(ghClient)),
   GitCommitLive.pipe(Layer.provide(ghClient)),
   CheckRunLive.pipe(Layer.provide(ghClient)),
   GitHubGraphQLLive.pipe(Layer.provide(ghClient)),
   CommandRunnerLive,
   DryRunLive(dryRun),
  );
  yield* Effect.provide(innerProgram(inputs, dryRun), appLayer);
 }),
);
```

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

The single entry point uses `Action.run()` with `GitHubAppLive`:

```typescript
import { Action, ActionOutputs, GitHubApp, GitHubAppLive } from "@savvy-web/github-action-effects";
import { Duration, Effect } from "effect";

export const program = Effect.gen(function* () {
 // Parse inputs declaratively
 const inputs = yield* Action.parseInputs({ ... });

 // Token lifecycle
 const ghApp = yield* GitHubApp;
 yield* ghApp.withToken(inputs["app-id"], inputs["app-private-key"], (token) => ...);
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
