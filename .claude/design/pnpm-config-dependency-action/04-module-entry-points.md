# Module Entry Points

[Back to index](./_index.md)

## src/pre.ts - Token Generation

**Responsibility:** Generate GitHub App installation token before main action runs.

**State Persistence:**

The pre.ts phase uses `ActionState` service (from `@savvy-web/github-action-effects`)
to persist Schema-validated state for main.ts and post.ts. State is saved as structured
objects with Effect Schema validation, not raw strings:

```typescript
import { Action, ActionInputs, ActionOutputs, ActionState, ActionStateLive } from "@savvy-web/github-action-effects";
import { Effect, Schema } from "effect";

const TokenState = Schema.Struct({
 token: Schema.String,
 expiresAt: Schema.String,
 installationId: Schema.Number,
 appSlug: Schema.String,
});

// State saved via ActionState.save() with Schema validation
yield* state.save("tokenState", tokenResult, TokenState);
yield* state.save("startTime", { value: Date.now().toString() }, Schema.Struct({ value: Schema.String }));
yield* state.save("skipTokenRevoke", { value: skipTokenRevoke.toString() }, Schema.Struct({ value: Schema.String }));
```

**Program Structure:**

The `program` Effect is exported for testability. It requires `ActionInputs`,
`ActionOutputs`, and `ActionState` services in its context. The module-level
`Action.run(program, ActionStateLive)` provides all services and runs the program.

```typescript
export const program = Effect.gen(function* () {
 const inputs = yield* ActionInputs;
 const outputs = yield* ActionOutputs;
 const state = yield* ActionState;

 // 1. Read app credentials via ActionInputs service
 const appId = yield* inputs.get("app-id", Schema.String);
 const privateKey = yield* inputs.getSecret("app-private-key", Schema.String);

 // 2. Generate installation token
 const tokenResult = yield* generateInstallationToken(appId, privateKey);

 // 3. Mark token as secret, save state, set outputs
 yield* outputs.setSecret(tokenResult.token);
 yield* state.save("tokenState", tokenResult, TokenState);
 yield* outputs.set("token", tokenResult.token);
});

Action.run(program, ActionStateLive);
```

**Key Functions:**

- `generateInstallationToken()`: Create JWT, get installation ID, generate token
- `ActionInputs.get()` / `getSecret()`: Read action inputs with Schema validation
- `ActionState.save()`: Persist Schema-validated state for later phases
- `ActionOutputs.setSecret()` / `set()`: Mask secrets and set outputs

**Required Permissions:**

- `contents: write` - Push commits and branches
- `pull-requests: write` - Create and update PRs
- `checks: write` - Create and update check runs

## src/main.ts - Orchestration

**Responsibility:** Coordinate all phases of the dependency update workflow.

**State Retrieval:**

Main.ts retrieves Schema-validated state saved by pre.ts using `ActionState.getOptional()`:

```typescript
import { Action, ActionInputs, ActionOutputs, ActionState, ActionStateLive } from "@savvy-web/github-action-effects";
import { Effect, Option, Schema } from "effect";

const TokenState = Schema.Struct({
 token: Schema.String,
 expiresAt: Schema.String,
 installationId: Schema.Number,
 appSlug: Schema.String,
});

// Retrieve and decode state saved by pre.ts
const tokenOption = yield* actionState.getOptional("tokenState", TokenState);
if (Option.isNone(tokenOption)) {
 return yield* Effect.fail(new Error("No token available. Ensure pre.ts ran successfully."));
}
const tokenState = tokenOption.value;
```

**Two-Level Program Structure:**

The module exports a `program` Effect (the core orchestration logic) and a `runnable`
wrapper that retrieves the token, builds the app layer, applies a timeout, and handles
top-level errors. The module-level `Action.run(runnable, ActionStateLive)` executes
everything.

- `program` requires `ActionState`, `ActionOutputs`, `ActionInputs`, `GitHubClient`,
  `GitExecutor`, and `PnpmExecutor` in its context
- `runnable` retrieves the token from state, constructs the app layer via
  `makeAppLayer(token)`, provides it to `program`, and wraps with timeout and
  error handling
- `generateCommitMessage(updates, appSlug)` takes `appSlug` as a parameter instead
  of reading from `@actions/core` state

```typescript
export const program = Effect.gen(function* () {
 const actionState = yield* ActionState;
 const outputs = yield* ActionOutputs;
 const actionInputs = yield* ActionInputs;

 // Token already retrieved and validated by runnable wrapper
 const tokenOption = yield* actionState.getOptional("tokenState", TokenState);
 // ... 14-step orchestration using Effect.logInfo/logDebug/logWarning/logError
 // ... outputs.set(), outputs.summary(), outputs.setFailed() for action I/O
});

const runnable = Effect.gen(function* () {
 // Retrieve token, build app layer, provide to program with timeout
 const appLayer = makeAppLayer(tokenOption.value.token);
 yield* program.pipe(
  Effect.provide(appLayer),
  Effect.timeoutFail({ duration: Duration.seconds(180), ... }),
  Effect.catchAll((error) => /* outputs.setFailed(...) */),
 );
});

Action.run(runnable, ActionStateLive);
```

**Key Responsibilities:**

- Coordinate phase execution in correct order
- Handle errors gracefully with accumulation where appropriate
- Provide detailed logging via `Effect.logInfo`/`logDebug`/`logWarning`/`logError`
  (routed to `@actions/core` by `ActionLoggerLayer`)
- Set outputs and write summaries via `ActionOutputs` service
- Exit early if no changes detected
- Generate comprehensive summaries

## src/post.ts - Cleanup

**Responsibility:** Clean up resources and revoke tokens after action completes.

**State Retrieval:**

Post.ts retrieves Schema-validated state from pre.ts using `ActionState.getOptional()`,
which returns `Option<T>`:

```typescript
import { Action, ActionState, ActionStateLive } from "@savvy-web/github-action-effects";
import { Effect, Option, Schema } from "effect";

const TokenState = Schema.Struct({
 token: Schema.String,
 expiresAt: Schema.String,
 installationId: Schema.Number,
 appSlug: Schema.String,
});

const tokenOption = yield* state.getOptional("tokenState", TokenState);
if (Option.isNone(tokenOption)) {
 yield* Effect.logWarning("No token found in state - nothing to revoke");
 return;
}
```

**Program Structure:**

Like pre.ts, the `program` Effect is exported for testability. Uses `Effect.logInfo`
and `Effect.logWarning` instead of `@actions/core` logging functions.

```typescript
export const program = Effect.gen(function* () {
 const state = yield* ActionState;

 // Check skip flag
 const skipRevokeOption = yield* state.getOptional("skipTokenRevoke", Schema.Struct({ value: Schema.String }));
 const skipRevoke = Option.isSome(skipRevokeOption) && skipRevokeOption.value.value === "true";

 // Retrieve and revoke token (with graceful error handling)
 const tokenOption = yield* state.getOptional("tokenState", TokenState);
 if (Option.isNone(tokenOption)) return;

 yield* revokeInstallationToken(tokenState.token).pipe(
  Effect.tap(() => Effect.logInfo("Token revoked successfully")),
  Effect.catchAll((error) => Effect.logWarning(`Failed to revoke token: ${error.reason}`)),
 );
});

Action.run(program, ActionStateLive);
```

**Key Functions:**

- `revokeInstallationToken()`: Revoke the GitHub App installation token
- `ActionState.getOptional()`: Retrieve Schema-validated state with `Option` return
