# Effect Patterns

[Back to index](./_index.md)

## Service Architecture

The action uses Effect's Service and Layer system for clean dependency injection:

```typescript
import { Context, Effect, Layer } from "effect";
import { Command } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";

// ══════════════════════════════════════════════════════════════════════════════
// Service Definitions (Tags)
// ══════════════════════════════════════════════════════════════════════════════

/** GitHub API client service */
class GitHubClient extends Context.Tag("GitHubClient")<
 GitHubClient,
 {
  readonly createBranch: (name: string, sha: string) => Effect.Effect<void, GitHubApiError>;
  readonly createPR: (data: PRData) => Effect.Effect<PullRequest, GitHubApiError>;
  readonly createCheckRun: (name: string) => Effect.Effect<CheckRun, GitHubApiError>;
  readonly enableAutoMerge: (nodeId: string, method: "MERGE" | "SQUASH" | "REBASE") => Effect.Effect<void, GitHubApiError>;
 }
>() {}

/** pnpm command executor service */
class PnpmExecutor extends Context.Tag("PnpmExecutor")<
 PnpmExecutor,
 {
  readonly addConfig: (dep: string) => Effect.Effect<DependencyUpdateResult, PnpmError>;
  readonly update: (pattern: string) => Effect.Effect<DependencyUpdateResult, PnpmError>;
  readonly install: () => Effect.Effect<void, PnpmError>;
  readonly run: (command: string) => Effect.Effect<string, PnpmError>; // Generic shell command execution
 }
>() {}

/** Git command executor service */
class GitExecutor extends Context.Tag("GitExecutor")<
 GitExecutor,
 {
  readonly checkout: (branch: string) => Effect.Effect<void, GitError>;
  readonly commit: (message: string) => Effect.Effect<void, GitError>;
  readonly push: (branch: string, force?: boolean) => Effect.Effect<void, GitError>;
  readonly status: () => Effect.Effect<GitStatus, GitError>;
 }
>() {}

// ══════════════════════════════════════════════════════════════════════════════
// Layer Implementations
// ══════════════════════════════════════════════════════════════════════════════

/** Create PnpmExecutor using @effect/platform Command */
const PnpmExecutorLive = Layer.effect(
 PnpmExecutor,
 Effect.gen(function* () {
  return {
   addConfig: (dep) =>
    Effect.gen(function* () {
     const result = yield* Command.make("pnpm", "add", "--config", dep).pipe(
      Command.string,
      Effect.mapError((e) => new PnpmError({ command: "add --config", dependency: dep, ...e }))
     );
     return parseUpdateResult(result, dep, "config");
    }),

   update: (pattern) =>
    Effect.gen(function* () {
     const result = yield* Command.make("pnpm", "up", pattern, "--latest").pipe(
      Command.string,
      Effect.mapError((e) => new PnpmError({ command: "up --latest", dependency: pattern, ...e }))
     );
     return parseUpdateResult(result, pattern, "regular");
    }),

   install: () =>
    Command.make("pnpm", "install").pipe(
     Command.exitCode,
     Effect.filterOrFail(
      (code) => code === 0,
      () => new PnpmError({ command: "install", exitCode: 1, stderr: "Install failed" })
     ),
     Effect.asVoid
    )
  };
 })
);

/** Create GitHubClient from token */
const GitHubClientLive = (token: string) =>
 Layer.succeed(GitHubClient, {
  createBranch: (name, sha) =>
   Effect.tryPromise({
    try: () => octokit.rest.git.createRef({ ...context.repo, ref: `refs/heads/${name}`, sha }),
    catch: (e) => new GitHubApiError({ operation: "createRef", message: String(e) })
   }).pipe(Effect.asVoid),

  createPR: (data) =>
   Effect.tryPromise({
    try: () => octokit.rest.pulls.create({ ...context.repo, ...data }),
    catch: (e) => new GitHubApiError({ operation: "pulls.create", message: String(e) })
   }).pipe(Effect.map((r) => ({ number: r.data.number, url: r.data.html_url, created: true, nodeId: r.data.node_id }))),

  enableAutoMerge: (nodeId, method) =>
   Effect.tryPromise({
    try: () => octokit.graphql(`
     mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
      enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) {
       pullRequest { id }
      }
     }
    `, { pullRequestId: nodeId, mergeMethod: method }),
    catch: (e) => new GitHubApiError({ operation: "enablePullRequestAutoMerge", message: String(e) })
   }).pipe(Effect.asVoid),

  createCheckRun: (name) =>
   Effect.tryPromise({
    try: () => octokit.rest.checks.create({ ...context.repo, name, head_sha: context.sha, status: "in_progress" }),
    catch: (e) => new GitHubApiError({ operation: "checks.create", message: String(e) })
   }).pipe(Effect.map((r) => ({ id: r.data.id, name, status: "in_progress" as const })))
 });

// ══════════════════════════════════════════════════════════════════════════════
// Composed Application Layer
// ══════════════════════════════════════════════════════════════════════════════

const makeAppLayer = (token: string) =>
 Layer.mergeAll(
  GitHubClientLive(token),
  PnpmExecutorLive,
  GitExecutorLive
 ).pipe(Layer.provide(NodeContext.layer)); // Provides platform requirements
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

```typescript
import { Effect, Layer } from "effect";
import { NodeRuntime } from "@effect/platform-node";

// Compose all layers
const AppLive = Layer.mergeAll(
 GitHubClientLive(token),
 PnpmExecutorLive,
 GitExecutorLive
).pipe(Layer.provide(NodeContext.layer));

// Main program
const program = Effect.gen(function* () {
 // All services available via yield*
 const github = yield* GitHubClient;
 const pnpm = yield* PnpmExecutor;
 const git = yield* GitExecutor;

 // ... orchestration logic
});

// Run with all layers provided
const runnable = program.pipe(Effect.provide(AppLive));

// Execute
NodeRuntime.runMain(runnable);
```
