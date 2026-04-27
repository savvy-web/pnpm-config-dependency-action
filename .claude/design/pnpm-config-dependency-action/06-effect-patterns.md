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
- `ActionEnvironment` - Provides GitHub Actions environment variables (repo, sha, ref,
  actor, etc.) without depending on `@actions/github`
- `ActionLogger` - Routes `Effect.logDebug` to `core.debug()`, `Effect.logInfo`
  to `core.info()`, etc.

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

- `Workspaces` / `WorkspacesLive` — Wraps `workspaces-effect`'s
  `getWorkspacePackagesSync`. No upstream deps.
- `ChangesetConfig` / `ChangesetConfigLive` — Reads `.changeset/config.json`
  with per-`workspaceRoot` caching. No upstream deps.
- `PublishabilityDetectorAdaptiveLive` (and the simpler
  `SilkPublishabilityDetectorLive`) — `workspaces-effect`'s
  `PublishabilityDetector` Tag overrides; the adaptive variant depends on
  `ChangesetConfig`.
- `BranchManager` / `BranchManagerLive` - Depends on `GitBranch`, `GitCommit`, `CommandRunner`
- `PnpmUpgrade` / `PnpmUpgradeLive` - Depends on `CommandRunner`
- `ConfigDeps` / `ConfigDepsLive` - Depends on `NpmRegistry`
- `RegularDeps` / `RegularDepsLive` - Depends on `NpmRegistry`, `Workspaces`
- `Changesets` / `ChangesetsLive` — Depends on `Workspaces`,
  `PublishabilityDetector`, `ChangesetConfig`
- `Report` / `ReportLive` - Depends on `PullRequest`

Stateless concerns (`PeerSync`, `WorkspaceYaml`, `Lockfile` standalone
helpers) export standalone helper functions used directly by `program.ts`.
`syncPeers` requires `Workspaces` in its environment; `compareLockfiles`
requires `Workspaces` in its environment.

### Layer Composition

All layers are wired together in `src/layers/app.ts`:

```typescript
// main.ts wires the auth dependency before invoking Action.run:
const AppLayer = GitHubAppLive.pipe(Layer.provide(OctokitAuthAppLive));
Action.run(program, { layer: AppLayer });

// Inside program (program.ts):
const ghApp = yield* GitHubApp;
yield* ghApp.withToken(appId, privateKey, (token) =>
 Effect.gen(function* () {
  process.env.GITHUB_TOKEN = token; // bridge to GitHubClientLive
  const appLayer = makeAppLayer(dryRun);
  yield* innerProgram(inputs, dryRun, headSha, appLayer);
 }),
);
```

`makeAppLayer(dryRun)` takes only `dryRun` — the GitHub App token is bridged
to `GitHubClientLive` via `process.env.GITHUB_TOKEN` rather than passed as a
Layer parameter. The function separates library layers from domain layers,
then uses `Layer.provideMerge` to wire domain layers on top of library
layers.

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
// program.ts
import {
 Action, ActionEnvironment, ActionInputError, GitHubApp,
} from "@savvy-web/github-action-effects";
import { Config, Duration, Effect, Redacted } from "effect";
import { makeAppLayer } from "./layers/app.js";

export const program = Effect.gen(function* () {
 const appId = yield* Config.string("app-id");
 const appPrivateKey = yield* Config.secret("app-private-key");
 const dryRun = yield* Config.boolean("dry-run").pipe(Config.withDefault(false));
 const timeout = yield* Config.integer("timeout").pipe(Config.withDefault(180));
 // ... other Config.* calls

 const ghApp = yield* GitHubApp;
 const env = yield* ActionEnvironment;
 const headSha = (yield* env.github).sha;

 yield* ghApp
  .withToken(appId, Redacted.value(appPrivateKey), (token) =>
   Effect.gen(function* () {
    process.env.GITHUB_TOKEN = token;
    const appLayer = makeAppLayer(dryRun);
    yield* innerProgram(inputs, dryRun, headSha, appLayer);
   }),
  )
  .pipe(Effect.timeoutFail({
   duration: Duration.seconds(timeout),
   onTimeout: () => new Error(`Action timed out after ${timeout} seconds`),
  }));
});

// main.ts
const AppLayer = GitHubAppLive.pipe(Layer.provide(OctokitAuthAppLive));
Action.run(program, { layer: AppLayer });
```

**Testing:** The `program` is exported from `program.ts` for testability.
Tests import `program` and `runCommands` directly without going through
`main.ts` (which only contains the module-level `Action.run` call). They
mock `@savvy-web/github-action-effects` via `vi.mock()` and test the
exported `program` Effect with mock service layers.
