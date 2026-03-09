# Module Entry Point

[Back to index](./_index.md)

## src/main.ts - Single-Phase Entry Point

**Responsibility:** Orchestrate the complete dependency update workflow in a single
phase, including token lifecycle, check runs, and all update steps.

### Input Parsing

Inputs are parsed declaratively via `Action.parseInputs()`:

```typescript
const inputs = yield* Action.parseInputs(
 {
  "app-id": { schema: Schema.String, required: true, secret: false },
  "app-private-key": { schema: Schema.String, required: true, secret: true },
  branch: { schema: Schema.String, default: "pnpm/config-deps" },
  "config-dependencies": { schema: Schema.Array(Schema.String), multiline: true, default: [] },
  dependencies: { schema: Schema.Array(Schema.String), multiline: true, default: [] },
  run: { schema: Schema.Array(Schema.String), multiline: true, default: [] },
  "update-pnpm": { schema: Schema.Boolean, default: true },
  changesets: { schema: Schema.Boolean, default: true },
  "auto-merge": { schema: Schema.Literal("", "merge", "squash", "rebase"), default: "" as const },
  "dry-run": { schema: Schema.Boolean, default: false },
 },
 (parsed) => {
  // Cross-validate: at least one update type must be active
  const hasConfig = parsed["config-dependencies"].length > 0;
  const hasDeps = parsed.dependencies.length > 0;
  const hasPnpm = parsed["update-pnpm"];
  if (!hasConfig && !hasDeps && !hasPnpm) {
   return Effect.fail(/* ActionInputError */);
  }
  return Effect.succeed(parsed);
 },
);
```

### Token Lifecycle and Layer Composition

Token is generated via `GitHubApp.withToken()`. Inside the callback, `makeAppLayer`
from `src/layers/app.ts` wires all library and domain service layers:

```typescript
const ghApp = yield* GitHubApp;
yield* ghApp.withToken(inputs["app-id"], inputs["app-private-key"], (token) =>
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

The module-level execution wraps with timeout and top-level error handling:

```typescript
Action.run(
 program.pipe(
  Effect.timeoutFail({
   duration: Duration.seconds(180),
   onTimeout: () => new Error("Action timed out after 180 seconds"),
  }),
  Effect.catchAll((error) =>
   Effect.gen(function* () {
    const outs = yield* ActionOutputs;
    yield* outs.setFailed(`Action failed: ${error.message}`);
   }),
  ),
 ),
 GitHubAppLive,
);
```

### Key Exported Functions

- `program` - Main Effect (exported for testability)
- `runCommands(commands)` - Execute custom commands sequentially via `CommandRunner`

Report-related functions (PR creation, commit messages, summaries) have moved to the
`Report` service in `src/services/report.ts`.

### Required GitHub App Permissions

- `contents: write` - Push commits and branches
- `pull-requests: write` - Create and update PRs
- `checks: write` - Create and update check runs
