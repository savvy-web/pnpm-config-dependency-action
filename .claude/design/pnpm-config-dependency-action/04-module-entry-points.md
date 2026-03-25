# Module Entry Point

[Back to index](./_index.md)

## src/main.ts - Single-Phase Entry Point

**Responsibility:** Orchestrate the complete dependency update workflow in a single
phase, including token lifecycle, check runs, and all update steps.

### Input Parsing

Inputs are parsed using Effect's `Config.*` API:

```typescript
const appId = yield* Config.string("app-id");
const appPrivateKey = yield* Config.secret("app-private-key");
const branch = yield* Config.string("branch").pipe(Config.withDefault("pnpm/config-deps"));
const rawConfigDeps = yield* Config.string("config-dependencies").pipe(Config.withDefault(""));
const configDependencies = parseMultiValueInput(rawConfigDeps);
const rawDeps = yield* Config.string("dependencies").pipe(Config.withDefault(""));
const dependencies = parseMultiValueInput(rawDeps);
const rawRun = yield* Config.string("run").pipe(Config.withDefault(""));
const run = parseMultiValueInput(rawRun);
const updatePnpm = yield* Config.boolean("update-pnpm").pipe(Config.withDefault(true));
const changesets = yield* Config.boolean("changesets").pipe(Config.withDefault(true));
const autoMerge = yield* Config.string("auto-merge").pipe(Config.withDefault("" as const));
const dryRun = yield* Config.boolean("dry-run").pipe(Config.withDefault(false));

// Cross-validate: at least one update type must be active
const hasConfig = configDependencies.length > 0;
const hasDeps = dependencies.length > 0;
if (!hasConfig && !hasDeps && !updatePnpm) {
 return yield* Effect.fail(/* ActionInputError */);
}
```

### Token Lifecycle and Layer Composition

Token is generated via `GitHubApp.withToken()`. The private key is read as a
`Config.secret` and unwrapped with `Redacted.value()` before passing to the token
generator. Inside the callback, `makeAppLayer` from `src/layers/app.ts` wires all
library and domain service layers:

```typescript
const ghApp = yield* GitHubApp;
yield* ghApp.withToken(appId, Redacted.value(appPrivateKey), (token) =>
 Effect.gen(function* () {
  const appLayer = makeAppLayer(token, dryRun);
  yield* Effect.provide(innerProgram(inputs, dryRun), appLayer);
 }),
);
```

### Program Structure

The module exports a `program` Effect and an `innerProgram` function:

- `program` handles input parsing, token lifecycle, and error handling
- `innerProgram(inputs, dryRun)` contains the 16-step orchestration logic
  and requires all domain services (`BranchManager`, `PnpmUpgrade`, `ConfigDeps`,
  `RegularDeps`, `Report`, `Lockfile`, `Changesets`) plus library services
  (`ActionOutputs`, `CheckRun`, `CommandRunner`) in its context

The module-level execution uses `Action.run` which handles all error
formatting via `formatCause` automatically:

```typescript
Action.run(program, { layer: GitHubAppLive });
```

Timeout is applied inside `program` via `Effect.timeoutFail` using
the configurable `timeout` input (default: 180 seconds).

### Key Exported Functions

- `program` - Main Effect (exported for testability)
- `runCommands(commands)` - Execute custom commands sequentially via `CommandRunner`

Report-related functions (PR creation, commit messages, summaries) have moved to the
`Report` service in `src/services/report.ts`.

### Required GitHub App Permissions

- `contents: write` - Push commits and branches
- `pull-requests: write` - Create and update PRs
- `checks: write` - Create and update check runs
