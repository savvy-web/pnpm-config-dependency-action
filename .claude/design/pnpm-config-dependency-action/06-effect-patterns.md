# Effect Patterns

[Back to index](./_index.md)

## Service Architecture

The action has two tiers of services:

1. **Library services** (from `@savvy-web/github-action-effects`): `ActionInputs`,
   `ActionOutputs`, `ActionState`, `ActionLogger` -- these handle all GitHub Action
   plumbing (reading inputs, setting outputs, persisting state between phases, and
   routing Effect log levels to `@actions/core` log functions).

2. **Application services** (in `src/lib/services/index.ts`): `GitHubClient`,
   `GitExecutor`, `PnpmExecutor` -- these handle domain-specific operations (GitHub
   API, git commands, pnpm commands).

### Library Services (provided by `Action.run()`)

`Action.run(program, ActionStateLive)` provides all library services automatically:

- `ActionInputs` - Read action inputs with Schema validation (`get`, `getSecret`,
  `getOptional`, `getBooleanOptional`)
- `ActionOutputs` - Set outputs (`set`), mask secrets (`setSecret`), write job
  summary (`summary`), fail the action (`setFailed`)
- `ActionState` - Save/load Schema-validated state between phases (`save`,
  `getOptional`)
- `ActionLogger` (via `ActionLoggerLayer`) - Routes `Effect.logDebug` to
  `core.debug()`, `Effect.logInfo` to `core.info()`, `Effect.logWarning` to
  `core.warning()`, `Effect.logError` to `core.error()` automatically
- `NodeContext.layer` - Provided automatically by `Action.run()` in v0.3.0

### Application Services (defined in `src/lib/services/index.ts`)

```typescript
import { Context, Effect, Layer } from "effect";
import { Command } from "@effect/platform";

// ══════════════════════════════════════════════════════════════════════════════
// Service Definitions (Tags)
// ══════════════════════════════════════════════════════════════════════════════

/** GitHub API client service - wraps Octokit with Effect error types */
class GitHubClient extends Context.Tag("GitHubClient")<GitHubClient, GitHubClientService>() {}

/** pnpm command executor service */
class PnpmExecutor extends Context.Tag("PnpmExecutor")<PnpmExecutor, PnpmExecutorService>() {}

/** Git command executor service */
class GitExecutor extends Context.Tag("GitExecutor")<GitExecutor, GitExecutorService>() {}

// ══════════════════════════════════════════════════════════════════════════════
// Composed Application Layer
// ══════════════════════════════════════════════════════════════════════════════

/** Creates all application services from a GitHub App token */
export const makeAppLayer = (token: string): Layer.Layer<GitHubClient | GitExecutor | PnpmExecutor> =>
 Layer.mergeAll(makeGitHubClientLayer(token), GitExecutorLive, PnpmExecutorLive);
```

**Key difference from prior architecture:** `makeAppLayer` no longer calls
`Layer.provide(NodeContext.layer)` -- that is now handled by `Action.run()`.

### Two-Layer Composition in main.ts

```typescript
// Library services provided by Action.run()
Action.run(runnable, ActionStateLive);

// Inside runnable:
const appLayer = makeAppLayer(tokenOption.value.token);
yield* program.pipe(
 Effect.provide(appLayer),  // Provides GitHubClient, GitExecutor, PnpmExecutor
 Effect.timeoutFail({ ... }),
 Effect.catchAll(/* ... */),
);
```

## Error Handling Strategy

Effect distinguishes between **expected errors** (typed, recoverable) and **unexpected errors** (defects):

**Expected Errors (Typed):**

- `PnpmError` - pnpm command failures
- `GitError` - git operation failures
- `GitHubApiError` - API call failures
- `InvalidInputError` - validation failures

**Unexpected Errors (Defects):**

- Runtime exceptions
- Network timeouts
- Out of memory

**Strategy by Error Type:**

| Scenario | Strategy | Effect Pattern |
| --- | --- | --- |
| Critical errors | Fail fast | `Effect.fail()` |
| Batch operations | Accumulate | `Effect.partition()` |
| Transient failures | Retry | `Effect.retry(Schedule)` |
| Optional features | Graceful degradation | `Effect.catchAll()` |

## Typed Errors with Data.TaggedError

```typescript
import { Data } from "effect";

/** pnpm command execution error */
export class PnpmError extends Data.TaggedError("PnpmError")<{
 readonly command: string;
 readonly dependency?: string;
 readonly exitCode?: number;
 readonly stderr?: string;
}> {}

// Pattern match on error type
const handleError = (error: PnpmError | GitError) =>
 Effect.gen(function* () {
  switch (error._tag) {
   case "PnpmError":
    yield* Effect.logError(`pnpm ${error.command} failed: ${error.stderr}`);
    break;
   case "GitError":
    yield* Effect.logError(`git ${error.operation} failed: ${error.stderr}`);
    break;
  }
 });
```

## Error Accumulation with Effect.partition

For batch operations, use `Effect.partition` to collect both successes and failures:

```typescript
import { Effect, Array } from "effect";

/**
 * Update multiple dependencies, collecting both successes and failures.
 * Continues processing even if some updates fail.
 */
export const updateDependenciesWithAccumulation = (
 dependencies: ReadonlyArray<string>
): Effect.Effect<
 { successful: ReadonlyArray<DependencyUpdateResult>; failed: ReadonlyArray<{ dep: string; error: PnpmError }> },
 never, // Never fails - accumulates errors instead
 PnpmExecutor
> =>
 Effect.gen(function* () {
  const pnpm = yield* PnpmExecutor;

  // Effect.partition separates successes and failures
  const [failures, successes] = yield* Effect.partition(
   dependencies,
   (dep) => pnpm.addConfig(dep).pipe(
    Effect.map((result) => ({ dep, result })),
    Effect.mapError((error) => ({ dep, error }))
   )
  );

  // Log failures but don't fail the effect
  if (failures.length > 0) {
   yield* Effect.logWarning(`${failures.length} dependency updates failed`);
   for (const { dep, error } of failures) {
    yield* Effect.logWarning(`  - ${dep}: ${error.stderr}`);
   }
  }

  return {
   successful: successes.map((s) => s.result),
   failed: failures
  };
 });
```

## Retry Policies with Schedule

Use `Schedule` for sophisticated retry logic:

```typescript
import { Effect, Schedule } from "effect";

// Exponential backoff: 100ms, 200ms, 400ms (max 3 retries)
const exponentialBackoff = Schedule.exponential("100 millis").pipe(
 Schedule.compose(Schedule.recurs(3)),
 Schedule.jittered // Add ±25% randomness to prevent thundering herd
);

// Only retry on specific errors (e.g., rate limits, network issues)
const retryableErrors = (error: GitHubApiError) =>
 error.statusCode === 429 || error.statusCode >= 500;

// Retry GitHub API calls
export const createPullRequestWithRetry = (data: PRData) =>
 Effect.gen(function* () {
  const github = yield* GitHubClient;
  return yield* github.createPR(data);
 }).pipe(
  Effect.retry({
   schedule: exponentialBackoff,
   while: retryableErrors
  })
 );
```

## Resource Management with acquireUseRelease

Ensure cleanup happens even on failure:

```typescript
import { Effect, Exit } from "effect";

/**
 * Wraps an operation with a GitHub check run.
 * The check run is always finalized (success/failure) even if the operation throws.
 */
export const withCheckRun = <A, E, R>(
 name: string,
 operation: (checkRun: CheckRun) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | GitHubApiError, R | GitHubClient> =>
 Effect.acquireUseRelease(
  // Acquire: Create check run
  Effect.gen(function* () {
   const github = yield* GitHubClient;
   return yield* github.createCheckRun(name);
  }),

  // Use: Run the operation
  operation,

  // Release: Always finalize the check run
  (checkRun, exit) =>
   Effect.gen(function* () {
    const github = yield* GitHubClient;
    const [status, conclusion, summary] = Exit.match(exit, {
     onFailure: (cause) => ["completed", "failure", `Failed: ${cause}`] as const,
     onSuccess: () => ["completed", "success", "Completed successfully"] as const
    });
    yield* github.updateCheckRun(checkRun.id, status, conclusion, summary);
   }).pipe(Effect.orDie) // Don't let cleanup errors propagate
 );
```

## Running the Effect Program

All entry points use `Action.run()` from the library instead of
`NodeRuntime.runMain()`:

```typescript
import { Action, ActionState, ActionStateLive } from "@savvy-web/github-action-effects";
import { Effect } from "effect";

// Export program for testability
export const program = Effect.gen(function* () {
 // Library services available via yield*
 const state = yield* ActionState;
 const outputs = yield* ActionOutputs;
 const inputs = yield* ActionInputs;

 // Application services (after providing appLayer)
 const github = yield* GitHubClient;
 const pnpm = yield* PnpmExecutor;
 const git = yield* GitExecutor;

 // ... orchestration logic
});

// Action.run provides ActionInputs, ActionOutputs, ActionState,
// ActionLoggerLayer, and NodeContext.layer automatically
Action.run(program, ActionStateLive);
```

**Testing:** Programs are exported as `program` and can be tested by providing
library test layers (`ActionInputsTest.layer()`, `ActionOutputsTest.layer()`,
`ActionStateTest.layer()`, `ActionLoggerTest.layer()`) instead of the live
layers. See the Testing section for details.
