# Module Entry Point

[Back to index](./_index.md)

## src/main.ts - Single-Phase Entry Point

**Responsibility:** Orchestrate the complete dependency update workflow in a single
phase, including token lifecycle, check runs, and all update steps.

**Architecture change (v0.4.0):** The previous three-phase architecture (`pre.ts`,
`main.ts`, `post.ts`) has been replaced by a single `main.ts` entry point. Token
generation and revocation are handled automatically by `GitHubApp.withToken()`.
The `ActionState` service is no longer needed for cross-phase state persistence.

### Input Parsing

Inputs are parsed declaratively via `Action.parseInputs()` instead of a separate
`parseInputs` module:

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

### Token Lifecycle

Token is generated and automatically revoked via `GitHubApp.withToken()`:

```typescript
const ghApp = yield* GitHubApp;
yield* ghApp.withToken(inputs["app-id"], inputs["app-private-key"], (token) =>
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

### Program Structure

The module exports a `program` Effect and an `innerProgram` function:

- `program` handles input parsing, token lifecycle, and error handling
- `innerProgram(inputs, dryRun)` contains the 16-step orchestration logic
  and requires `ActionOutputs`, `CheckRun`, `GitBranch`, `GitCommit`,
  `GitHubClient`, `CommandRunner` in its context

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
- `createOrUpdatePR(branch, updates, changesets)` - Create or update dependency PR via `GitHubClient`
- `generateCommitMessage(updates, appSlug?)` - Generate conventional commit message
- `generatePRBody(updates, changesets)` - Generate Dependabot-style PR description
- `generateSummary(updates, changesets, pr, dryRun)` - Generate check run/job summary

### Required GitHub App Permissions

- `contents: write` - Push commits and branches
- `pull-requests: write` - Create and update PRs
- `checks: write` - Create and update check runs
