# Module Entry Point

[Back to index](./_index.md)

## src/main.ts - Module-Level Entry

`main.ts` is intentionally tiny: it wires `GitHubAppLive` (which depends on
`OctokitAuthAppLive`) into a top-level `AppLayer` and invokes `Action.run` on
the program imported from `./program.ts`.

```typescript
import { Action, GitHubAppLive, OctokitAuthAppLive } from "@savvy-web/github-action-effects";
import { Layer } from "effect";
import { program } from "./program.js";

const AppLayer = GitHubAppLive.pipe(Layer.provide(OctokitAuthAppLive));

Action.run(program, { layer: AppLayer });
```

The module-level call is annotated with `/* v8 ignore next */` so coverage is
attributed to `program.ts`. Tests import `program` and `runCommands` directly
from `./program.js` without ever evaluating `main.ts`.

## src/program.ts - The Effect Program

**Responsibility:** Orchestrate the complete dependency update workflow in a
single phase, including token lifecycle, check runs, and all update steps.

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
const rawPeerLock = yield* Config.string("peer-lock").pipe(Config.withDefault(""));
const peerLock = parseMultiValueInput(rawPeerLock);
const rawPeerMinor = yield* Config.string("peer-minor").pipe(Config.withDefault(""));
const peerMinor = parseMultiValueInput(rawPeerMinor);
const rawRun = yield* Config.string("run").pipe(Config.withDefault(""));
const run = parseMultiValueInput(rawRun);
const updatePnpm = yield* Config.boolean("update-pnpm").pipe(Config.withDefault(true));
const changesets = yield* Config.boolean("changesets").pipe(Config.withDefault(true));
const autoMerge = yield* Config.string("auto-merge").pipe(Config.withDefault(""));
const dryRun = yield* Config.boolean("dry-run").pipe(Config.withDefault(false));
const logLevel = yield* Config.string("log-level").pipe(Config.withDefault("auto"));
const timeout = yield* Config.integer("timeout").pipe(Config.withDefault(180));

// Cross-validate: at least one update type must be active
if (configDependencies.length === 0 && dependencies.length === 0 && !updatePnpm) {
 return yield* Effect.fail(new ActionInputError({ /* ... */ }));
}

// peer-lock and peer-minor must not overlap
const peerOverlap = peerLock.filter((p) => peerMinor.includes(p));
if (peerOverlap.length > 0) {
 return yield* Effect.fail(new ActionInputError({ /* ... */ }));
}
```

`parseMultiValueInput` (in `src/utils/input.ts`) accepts JSON arrays,
newline-separated lists (with optional `*` bullets and `#` comments), or
comma-separated strings.

### Token Lifecycle and Layer Composition

Token is generated via `GitHubApp.withToken()`. The private key is read as a
`Config.secret` and unwrapped with `Redacted.value()` before passing to the token
generator. Inside the callback, the action bridges the token to
`GitHubClientLive` via `process.env.GITHUB_TOKEN` and then builds the
per-run layer:

```typescript
const ghApp = yield* GitHubApp;
const env = yield* ActionEnvironment;
const github = yield* env.github;
const headSha = github.sha;

yield* ghApp
 .withToken(appId, Redacted.value(appPrivateKey), (token) =>
  Effect.gen(function* () {
   process.env.GITHUB_TOKEN = token;
   const appLayer = makeAppLayer(dryRun);
   yield* innerProgram(inputs, dryRun, headSha, appLayer)
    .pipe(Logger.withMinimumLogLevel(effectLogLevel));
  }),
 )
 .pipe(Effect.timeoutFail({
  duration: Duration.seconds(timeout),
  onTimeout: () => new Error(`Action timed out after ${timeout} seconds`),
 }));
```

Note: `makeAppLayer` takes a single `dryRun` parameter — it does **not** take
a token. The token reaches `GitHubClientLive` through `process.env.GITHUB_TOKEN`,
not as a constructor argument. Earlier docs showing `makeAppLayer(token, dryRun)`
are stale.

### Program Structure

The module exports:

- `program` — the main Effect (input parsing, token lifecycle, timeout).
- `innerProgram(inputs, dryRun, headSha, appLayer)` — the orchestration body.
  Provides `appLayer` at two levels (outer + inside the `withCheckRun`
  callback) because the callback signature requires `R = never`.
- `runCommands(commands)` — execute custom commands sequentially via
  `CommandRunner` (`sh -c "<cmd>"`); returns `{ successful, failed }`.
- `runInstall()` — runs `pnpm install --frozen-lockfile=false --fix-lockfile`
  via `CommandRunner.exec`. Replaces the older
  `rm -rf node_modules pnpm-lock.yaml && pnpm install` clean-install pattern.

`innerProgram` requires all domain services (`BranchManager`, `PnpmUpgrade`,
`ConfigDeps`, `RegularDeps`, `Changesets`, `Report`) and helper functions
(`captureLockfileState`, `compareLockfiles`, `syncPeers`,
`formatWorkspaceYaml`) plus library services (`ActionOutputs`, `CheckRun`,
`CommandRunner`) and `WorkspaceDiscovery` (from `workspaces-effect`) in its
context.

The module-level call in `main.ts` uses `Action.run` which handles all error
formatting via `formatCause` automatically:

```typescript
Action.run(program, { layer: AppLayer });
```

Timeout is applied inside `program` via `Effect.timeoutFail` using the
configurable `timeout` input (default: 180 seconds).

### Key Exported Functions

- `program` — Main Effect (exported for testability).
- `runCommands(commands)` — Execute custom commands sequentially via
  `CommandRunner`.
- `runInstall()` — Run `pnpm install --frozen-lockfile=false --fix-lockfile`.

Report-related functions (PR creation, commit messages, summaries) live in the
`Report` service in `src/services/report.ts`.

### Required GitHub App Permissions

- `contents: write` - Push commits and branches
- `pull-requests: write` - Create and update PRs
- `checks: write` - Create and update check runs
