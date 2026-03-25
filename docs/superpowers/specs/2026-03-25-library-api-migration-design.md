# Library API Migration: @savvy-web/github-action-effects v0.11+

## Overview

Migrate from the legacy `@actions/*` + `Action.parseInputs()` API to the
modern `@savvy-web/github-action-effects` v0.11 API surface. The new library
implements the GitHub Actions runtime protocol natively in ESM with zero
`@actions/*` dependencies.

## Goals

1. Remove all `@actions/*` imports (currently only `@actions/github` for
   `context.sha`)
2. Replace `Action.parseInputs()` with Effect's `Config` API
3. Update `Action.run()` call signature to use `ActionRunOptions`
4. Use `ActionEnvironment` for GitHub context (SHA, repository, etc.)
5. Modernize test files to use library test layers consistently
6. Update design documentation to reflect new patterns

## Non-Goals

- Replace `workspace-tools` with `workspaces-effect` (follow-up)
- Replace `@pnpm/lockfile.fs` with `workspaces-effect` LockfileReader
  (follow-up)
- Change domain service interfaces or business logic

## Files Changed

| File | Change Type | Description |
| --- | --- | --- |
| `src/utils/input.ts` | New | `parseMultiValueInput` helper for multiline inputs |
| `src/utils/input.test.ts` | New | Tests for `parseMultiValueInput` |
| `src/main.ts` | Rewrite (partial) | Config API, ActionEnvironment, log level, Action.run signature |
| `src/services/lockfile.test.ts` | Edit | Remove `vi.mock("@actions/core")` |
| `src/services/pnpm-upgrade.test.ts` | Edit | Migrate to `CommandRunnerTest` |
| `src/main.effect.test.ts` | Edit | Migrate to `CommandRunnerTest` |
| `.claude/design/` docs | Edit | Update to reflect new API patterns |

No changes to: `src/layers/app.ts` (ActionEnvironment is part of
CoreServices, already provided by `Action.run`), domain service files
(`branch.ts`, `config-deps.ts`, `regular-deps.ts`, `report.ts`,
`pnpm-upgrade.ts`, `lockfile.ts`, `changesets.ts`, `workspace-yaml.ts`),
`main.test.ts`, or `report.test.ts`.

## Design

### 1. Input Parsing (src/main.ts)

**Before:** Single `Action.parseInputs()` call with schema definitions,
multiline parsing, and cross-validation callback.

**After:** Individual `Config.*` calls with `parseMultiValueInput` helper:

```typescript
import { Config, Effect, Secret } from "effect"
import { ActionInputError } from "@savvy-web/github-action-effects"
import { parseMultiValueInput } from "./utils/input.js"

// Required string inputs (withToken takes string, string)
const appId = yield* Config.string("app-id")
const appPrivateKey = yield* Config.secret("app-private-key")
// Extract string from Secret when passing to withToken:
// ghApp.withToken(appId, Secret.value(appPrivateKey), ...)

// String inputs with defaults
const branch = yield* Config.string("branch").pipe(Config.withDefault("pnpm/config-deps"))

// Multiline inputs -> arrays
const rawConfigDeps = yield* Config.string("config-dependencies").pipe(Config.withDefault(""))
const configDependencies = parseMultiValueInput(rawConfigDeps)
const rawDeps = yield* Config.string("dependencies").pipe(Config.withDefault(""))
const dependencies = parseMultiValueInput(rawDeps)
const rawRun = yield* Config.string("run").pipe(Config.withDefault(""))
const run = parseMultiValueInput(rawRun)

// Boolean inputs
const updatePnpm = yield* Config.boolean("update-pnpm").pipe(Config.withDefault(true))
const changesets = yield* Config.boolean("changesets").pipe(Config.withDefault(true))
const dryRun = yield* Config.boolean("dry-run").pipe(Config.withDefault(false))

// Other inputs
const autoMerge = yield* Config.string("auto-merge").pipe(Config.withDefault(""))
const logLevel = yield* Config.string("log-level").pipe(Config.withDefault("auto"))
const timeout = yield* Config.integer("timeout").pipe(Config.withDefault(180))

// Cross-validation (unchanged logic)
if (configDependencies.length === 0 && dependencies.length === 0 && !updatePnpm) {
  yield* Effect.fail(new ActionInputError({
    inputName: "config-dependencies",
    reason: "At least one update type must be active",
    rawValue: undefined,
  }))
}
```

Note: `Config.secret` returns `Secret` to prevent accidental logging.
`GitHubApp.withToken` takes `(appId: string, privateKey: string, ...)`,
so extract with `Secret.value(appPrivateKey)` at the call site.
`Config.string("app-id")` is used (not `Config.integer`) because
`withToken` expects a string.

### 2. Context SHA (src/main.ts)

**Before:**

```typescript
import { context } from "@actions/github"
const headSha = context.sha
```

**After:**

```typescript
const env = yield* ActionEnvironment
const github = yield* env.github
const headSha = github.sha
```

`ActionEnvironment` is part of `CoreServices` provided automatically by
`Action.run`. No layer changes needed — it's available anywhere in the
program.

### 3. Log Level Configuration (src/main.ts)

**Before:**

```typescript
const resolvedLogLevel = Action.resolveLogLevel(inputs["log-level"])
yield* Action.setLogLevel(resolvedLogLevel)
```

**After:** `Action.setLogLevel` no longer exists. Use Effect's built-in
`Logger.withMinimumLogLevel` to set the minimum log level for the inner
program. `Action.resolveLogLevel` still exists to map `LogLevelInput`
(`"info" | "verbose" | "debug" | "auto"`) to `ActionLogLevel`.

```typescript
import { LogLevel, Logger } from "effect"

const resolvedLogLevel = Action.resolveLogLevel(logLevel as LogLevelInput)
// Map ActionLogLevel to Effect LogLevel
const effectLogLevel = resolvedLogLevel === "debug" ? LogLevel.Debug
  : resolvedLogLevel === "verbose" ? LogLevel.Info
  : LogLevel.Warning

// Apply to the inner program via pipe
yield* innerProgram(...).pipe(Logger.withMinimumLogLevel(effectLogLevel))
```

### 4. Action.run Signature (src/main.ts)

**Before:**

```typescript
Action.run(program, GitHubAppLive)
```

**After:**

```typescript
Action.run(program, { layer: GitHubAppLive })
```

### 4. parseMultiValueInput Helper (src/utils/input.ts)

New file ported from `workflow-runtime-action`. Supports:

- Newline-separated: `"a\nb\nc"`
- Bullet lists: `"* a\n* b\n* c"`
- Comma-separated: `"a, b, c"`
- JSON arrays: `'["a", "b", "c"]'`
- Comment lines stripped: `"# comment\na\nb"`

```typescript
export const parseMultiValueInput = (raw: string): string[] => {
  const trimmed = raw.trim()
  if (!trimmed) return []

  // JSON array
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        return parsed.map((s: unknown) => String(s).trim()).filter(Boolean)
      }
    } catch { /* fall through */ }
  }

  // Newline or bullet list
  if (trimmed.includes("\n")) {
    return trimmed
      .split("\n")
      .map((s) => s.trim().replace(/^\*\s*/, ""))
      .filter((s) => s.length > 0 && !s.startsWith("#"))
  }

  // Comma-separated
  return trimmed.split(",").map((s) => s.trim()).filter(Boolean)
}
```

### 5. Test Modernization

**lockfile.test.ts:** Remove the 12-line `vi.mock("@actions/core")` block.
This mock was only needed because `@actions/github` had a transitive
dependency on `@actions/core`. With `@actions/github` removed, the mock
is unnecessary.

**pnpm-upgrade.test.ts:** Replace manual `makeRunner()` helper with
`CommandRunnerTest.layer(responses)` pattern. The current helper manually
constructs a `CommandRunner` service object; the library's
`CommandRunnerTest` provides the same capability with less boilerplate
and consistent behavior.

**main.effect.test.ts:** Replace manual `makeTestRunner()` helper with
`CommandRunnerTest` layer pattern, matching the approach used in
`branch.test.ts`.

### 6. Design Documentation Updates

Update `.claude/design/` files to reflect:

- `Config` API for input parsing (not `Action.parseInputs`)
- `ActionEnvironment` for context (not `@actions/github`)
- No `@actions/*` dependencies
- `Action.run(program, { layer })` signature
- Updated dependency list (no `@actions/*` packages)
- Test patterns using library test layers

## Migration Order

1. Create `src/utils/input.ts` + `src/utils/input.test.ts`
2. Rewrite input parsing, context SHA, log level, and Action.run in
   `src/main.ts`
3. Update `src/services/lockfile.test.ts` (remove mock)
4. Update `src/services/pnpm-upgrade.test.ts` (CommandRunnerTest)
5. Update `src/main.effect.test.ts` (CommandRunnerTest)
6. Run tests, fix any issues
7. Update design documentation

## Risks

- **Config.secret -> string**: `Config.secret("app-private-key")` returns
  `Secret`. `GitHubApp.withToken` takes `(appId: string, privateKey: string)`.
  Extract with `Secret.value(appPrivateKey)` at the call site.
- **Config.boolean parsing**: GitHub Actions passes booleans as strings
  (`"true"/"false"`). `Config.boolean` with `ActionsConfigProvider` should
  handle this, but verify during implementation.
- **CommandRunnerTest response matching**: The test layer matches on
  command strings. Verify the key format (e.g., `"command arg1 arg2"` vs
  separate matching). The `pnpm-upgrade.test.ts` migration is moderate
  complexity because the current `makeRunner` uses dynamic dispatch
  based on command+args content, which must be converted to static
  response maps per test case.
- **Log level mapping**: `ActionLogLevel` (`"info" | "verbose" | "debug"`)
  must be mapped to Effect's `LogLevel`. Verify the mapping is correct
  for the buffer-on-failure behavior in `Action.run`.
