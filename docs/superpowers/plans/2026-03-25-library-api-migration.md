# Library API Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate from `@actions/*` + `Action.parseInputs()` to the modern `@savvy-web/github-action-effects` v0.11 API with Config, ActionEnvironment, and library test layers.

**Architecture:** Replace the single `Action.parseInputs()` call with individual `Config.*` reads backed by `ActionsConfigProvider`. Replace `@actions/github` context with `ActionEnvironment` (part of CoreServices, auto-provided by `Action.run`). Update test files to remove stale `@actions/core` mocks and use `CommandRunnerTest` where possible.

**Tech Stack:** Effect-TS, `@savvy-web/github-action-effects` v0.11.12, Vitest

**Spec:** `docs/superpowers/specs/2026-03-25-library-api-migration-design.md`

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/utils/input.ts` | Parse multiline GitHub Action inputs into arrays | Create |
| `src/utils/input.test.ts` | Tests for `parseMultiValueInput` | Create |
| `src/main.ts` | Action orchestrator with input parsing, context, log level | Modify |
| `src/services/lockfile.test.ts` | Lockfile service tests | Modify (remove mock) |
| `src/main.effect.test.ts` | `runCommands` tests | Modify (CommandRunnerTest) |
| `.claude/design/` | Architecture documentation | Modify |

Files NOT changed: `src/layers/app.ts`, all domain services, `main.test.ts`, `report.test.ts`, `branch.test.ts`, `config-deps.test.ts`, `regular-deps.test.ts`, `pnpm-upgrade.test.ts`.

Note on `pnpm-upgrade.test.ts`: The spec identified this for `CommandRunnerTest` migration, but analysis shows the tests require dynamic side effects (writing `package.json` during simulated `corepack use` calls). `CommandRunnerTest.layer(responses)` only supports static response maps. The existing `Layer.succeed(CommandRunner, ...)` pattern is correct for this use case.

---

### Task 1: Create parseMultiValueInput Helper

**Files:**

- Create: `src/utils/input.ts`
- Create: `src/utils/input.test.ts`

- [ ] **Step 1: Write tests for parseMultiValueInput**

Create `src/utils/input.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { parseMultiValueInput } from "./input.js";

describe("parseMultiValueInput", () => {
 it("returns empty array for empty string", () => {
  expect(parseMultiValueInput("")).toEqual([]);
 });

 it("returns empty array for whitespace-only string", () => {
  expect(parseMultiValueInput("   ")).toEqual([]);
 });

 it("splits newline-separated values", () => {
  expect(parseMultiValueInput("a\nb\nc")).toEqual(["a", "b", "c"]);
 });

 it("trims whitespace from newline-separated values", () => {
  expect(parseMultiValueInput("  a  \n  b  \n  c  ")).toEqual(["a", "b", "c"]);
 });

 it("strips bullet prefixes", () => {
  expect(parseMultiValueInput("* a\n* b\n* c")).toEqual(["a", "b", "c"]);
 });

 it("filters comment lines", () => {
  expect(parseMultiValueInput("# comment\na\nb")).toEqual(["a", "b"]);
 });

 it("filters empty lines", () => {
  expect(parseMultiValueInput("a\n\nb\n\n")).toEqual(["a", "b"]);
 });

 it("splits comma-separated values", () => {
  expect(parseMultiValueInput("a, b, c")).toEqual(["a", "b", "c"]);
 });

 it("parses JSON array", () => {
  expect(parseMultiValueInput('["a", "b", "c"]')).toEqual(["a", "b", "c"]);
 });

 it("falls through on invalid JSON", () => {
  expect(parseMultiValueInput("[not valid json")).toEqual(["[not valid json"]);
 });

 it("handles single value (no delimiter)", () => {
  expect(parseMultiValueInput("@scope/pkg")).toEqual(["@scope/pkg"]);
 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/utils/input.test.ts`
Expected: FAIL — `./input.js` does not exist

- [ ] **Step 3: Write parseMultiValueInput implementation**

Create `src/utils/input.ts`:

```typescript
/**
 * Parse a multi-value GitHub Action input string.
 *
 * Supports multiple formats:
 * - Newline-separated: "a\nb\nc"
 * - Bullet lists: "* a\n* b\n* c"
 * - Comma-separated: "a, b, c"
 * - JSON arrays: '["a", "b", "c"]'
 * - Comment lines stripped (# prefix)
 *
 * @module utils/input
 */

export const parseMultiValueInput = (raw: string): string[] => {
 const trimmed = raw.trim();
 if (!trimmed) return [];

 // JSON array
 if (trimmed.startsWith("[")) {
  try {
   const parsed = JSON.parse(trimmed);
   if (Array.isArray(parsed)) {
    return parsed.map((s: unknown) => String(s).trim()).filter(Boolean);
   }
  } catch {
   // Not valid JSON, fall through to other formats
  }
 }

 // Newline or bullet list (supports # comments)
 if (trimmed.includes("\n")) {
  return trimmed
   .split("\n")
   .map((s) => s.trim().replace(/^\*\s*/, ""))
   .filter((s) => s.length > 0 && !s.startsWith("#"));
 }

 // Comma-separated
 return trimmed
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/utils/input.test.ts`
Expected: PASS — all 11 tests

- [ ] **Step 5: Commit**

```bash
git add src/utils/input.ts src/utils/input.test.ts
git commit -m "feat: add parseMultiValueInput helper for Config API migration"
```

---

### Task 2: Migrate main.ts Input Parsing and Context

**Files:**

- Modify: `src/main.ts`

**Key changes:**

1. Remove `import { context } from "@actions/github"`
2. Replace `Action.parseInputs()` with `Config.*` calls
3. Replace `context.sha` with `ActionEnvironment`
4. Replace `Action.setLogLevel` with `Logger.withMinimumLogLevel`
5. Update `Action.run(program, GitHubAppLive)` to `Action.run(program, { layer: GitHubAppLive })`
6. Remove type cast workaround for multiline inputs (no longer needed)

**Reference files to read:**

- Current `src/main.ts` (lines 25-441)
- Spec sections 1-4
- Library types: `GitHubApp.withToken(appId: string, privateKey: string, ...)`
- Library types: `ActionEnvironment.github` -> `GitHubContext.sha`

- [ ] **Step 1: Update imports**

In `src/main.ts`, replace the import block (lines 25-47):

Remove:

```typescript
import { context } from "@actions/github";
```

Update the `@savvy-web/github-action-effects` import to add
`ActionEnvironment` (keep `LogLevelInput` — it's used as a type cast
in Step 2):

```typescript
import {
 Action,
 ActionEnvironment,
 ActionInputError,
 ActionOutputs,
 CheckRun,
 CommandRunner,
 GitHubApp,
 GitHubAppLive,
 LogLevelInput,
} from "@savvy-web/github-action-effects";
```

Update the `effect` imports — add `Config`, `LogLevel`, `Secret`;
keep `type { Layer }` (still used by `innerProgram` parameter);
remove `Schema` (no longer needed after removing `parseInputs`):

```typescript
import type { Layer } from "effect";
import { Config, Duration, Effect, LogLevel, Secret } from "effect";
```

Add new import:

```typescript
import { parseMultiValueInput } from "./utils/input.js";
```

- [ ] **Step 2: Replace Action.parseInputs with Config calls**

Replace the `Action.parseInputs(...)` block (lines 110-141) and the
subsequent log level / cast code (lines 143-178) with:

```typescript
// Step 1: Parse inputs via Config API
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
const autoMerge = yield* Config.string("auto-merge").pipe(Config.withDefault(""));
const dryRun = yield* Config.boolean("dry-run").pipe(Config.withDefault(false));
const logLevel = yield* Config.string("log-level").pipe(Config.withDefault("auto"));
const timeout = yield* Config.integer("timeout").pipe(Config.withDefault(180));

// Cross-validate: at least one update type must be active
if (configDependencies.length === 0 && dependencies.length === 0 && !updatePnpm) {
 yield* Effect.fail(
  new ActionInputError({
   inputName: "config-dependencies",
   reason: "At least one update type must be active",
   rawValue: undefined,
  }),
 );
}

// Resolve log level
const resolvedLogLevel = Action.resolveLogLevel(logLevel as LogLevelInput);
```

- [ ] **Step 3: Update withToken call**

Replace the `ghApp.withToken` call to use `Secret.value`:

```typescript
yield* ghApp
 .withToken(appId, Secret.value(appPrivateKey), (token) =>
```

- [ ] **Step 4: Remove multiline type cast and simplify innerProgram call**

The old code cast multiline inputs:

```typescript
yield* innerProgram(
 {
  ...inputs,
  "config-dependencies": inputs["config-dependencies"] as unknown as ReadonlyArray<string>,
  dependencies: inputs.dependencies as unknown as ReadonlyArray<string>,
  run: inputs.run as unknown as ReadonlyArray<string>,
 },
 dryRun,
 appLayer,
);
```

Replace with direct variable passing (they're already `string[]` from `parseMultiValueInput`):

```typescript
yield* innerProgram(
 {
  branch,
  "config-dependencies": configDependencies,
  dependencies,
  "update-pnpm": updatePnpm,
  changesets,
  "auto-merge": autoMerge as "" | "merge" | "squash" | "rebase",
  run,
 },
 dryRun,
 appLayer,
);
```

- [ ] **Step 5: Replace context.sha with ActionEnvironment**

`ActionEnvironment` is part of CoreServices provided by `Action.run`,
so it's available in `program` (outer scope) but NOT inside
`innerProgram` unless it's passed through or provided by `appLayer`.

**Option A (simplest):** Read the SHA in `program` before entering
`withToken`, and pass it to `innerProgram` as a parameter:

In `program` (outer scope), before the `ghApp.withToken` call:

```typescript
const env = yield* ActionEnvironment;
const github = yield* env.github;
const headSha = github.sha;
```

Then pass `headSha` to `innerProgram` and update its signature to
accept it. In `innerProgram`, remove the old `context.sha` reference.

**Option B:** Access it inside `innerProgram`'s outer `Effect.gen`
(the one provided `appLayer`). Since `appLayer` doesn't provide
`ActionEnvironment`, it must be satisfied by the outer scope. Check
if Effect propagates unsatisfied requirements — if not, use Option A.

- [ ] **Step 6: Remove Action.setLogLevel**

Remove these lines (around lines 146-148):

```typescript
const resolvedLogLevel = Action.resolveLogLevel(inputs["log-level"]);
yield* Action.setLogLevel(resolvedLogLevel);
```

The `resolvedLogLevel` is already set in Step 2. The log level is now
applied via `Logger.withMinimumLogLevel` on the inner program. Add the
mapping after the `resolvedLogLevel` assignment:

```typescript
const effectLogLevel =
 resolvedLogLevel === "debug"
  ? LogLevel.Debug
  : resolvedLogLevel === "verbose"
   ? LogLevel.Info
   : LogLevel.Warning;
```

Then apply to the `innerProgram` call (wrap the existing timeout pipe):

```typescript
yield* ghApp
 .withToken(appId, Secret.value(appPrivateKey), (token) =>
  Effect.gen(function* () {
   const appLayer = makeAppLayer(token, dryRun);
   yield* innerProgram(...).pipe(
    Logger.withMinimumLogLevel(effectLogLevel),
   );
  }),
 )
 .pipe(
  Effect.timeoutFail({
   duration: Duration.seconds(timeout),
   onTimeout: () => new Error(`Action timed out after ${timeout} seconds`),
  }),
 );
```

- [ ] **Step 7: Update Action.run call**

At the bottom of the file, replace:

```typescript
Action.run(program, GitHubAppLive);
```

with:

```typescript
Action.run(program, { layer: GitHubAppLive });
```

- [ ] **Step 8: Clean up debug logging**

Update the debug log that referenced `inputs` object to use the new
individual variables:

```typescript
yield* Effect.logDebug(
 `Parsed inputs: ${JSON.stringify({
  branch,
  configDependencies,
  dependencies,
  updatePnpm,
  dryRun,
 })}`,
);
```

- [ ] **Step 9: Run typecheck**

Run: `pnpm run typecheck`
Expected: PASS — no type errors

- [ ] **Step 10: Run tests**

Run: `pnpm run test`
Expected: All existing tests pass (main.ts is `v8 ignore`d so no
direct test coverage; domain service tests should be unaffected)

- [ ] **Step 11: Commit**

```bash
git add src/main.ts
git commit -m "feat: migrate to Config API, ActionEnvironment, and new Action.run signature

Replace Action.parseInputs() with individual Config.* calls.
Replace @actions/github context.sha with ActionEnvironment.
Replace Action.setLogLevel with Logger.withMinimumLogLevel.
Update Action.run to use ActionRunOptions { layer }."
```

---

### Task 3: Remove @actions/core Mock from lockfile.test.ts

**Files:**

- Modify: `src/services/lockfile.test.ts`

- [ ] **Step 1: Remove the vi.mock block**

In `src/services/lockfile.test.ts`, remove lines 5-12:

```typescript
// Mock @actions/core to suppress ::debug:: output from logging.ts
vi.mock("@actions/core", () => ({
 debug: vi.fn(),
 info: vi.fn(),
 warning: vi.fn(),
 getInput: vi.fn(() => ""),
 getBooleanInput: vi.fn(() => false),
}));
```

Also remove `vi` from the vitest import if it's no longer used (check
if `vi.hoisted` and `vi.mock("@pnpm/lockfile.fs")` still need it —
they do, so keep `vi`).

- [ ] **Step 2: Run lockfile tests**

Run: `pnpm vitest run src/services/lockfile.test.ts`
Expected: PASS — all 23 tests. The mock was only needed because
`@actions/github` (now removed from main.ts) had a transitive dep
on `@actions/core`.

- [ ] **Step 3: Commit**

```bash
git add src/services/lockfile.test.ts
git commit -m "test: remove stale @actions/core mock from lockfile tests"
```

---

### Task 4: Migrate main.effect.test.ts to CommandRunnerTest

**Files:**

- Modify: `src/main.effect.test.ts`

The current `makeTestRunner` helper manually constructs a
`CommandRunner` service. The tests use simple static responses or
argument-based dispatch. Migrate to `CommandRunnerTest` for the
static cases; keep `Layer.succeed` for the dynamic dispatch test.

- [ ] **Step 1: Update imports**

Replace:

```typescript
import type { CommandRunnerError } from "@savvy-web/github-action-effects";
import { CommandRunner } from "@savvy-web/github-action-effects";
```

with:

```typescript
import type { CommandResponse, CommandRunnerError } from "@savvy-web/github-action-effects";
import { CommandRunner, CommandRunnerTest } from "@savvy-web/github-action-effects";
```

- [ ] **Step 2: Replace makeTestRunner for simple cases**

The first test ("returns empty result") uses `makeTestRunner()` with
no overrides. Replace with `CommandRunnerTest.empty()`:

```typescript
it("returns empty result for empty commands", async () => {
 const layer = CommandRunnerTest.empty();
 const result = await Effect.runPromise(
  runCommands([]).pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
 );
 expect(result.successful).toEqual([]);
 expect(result.failed).toEqual([]);
});
```

- [ ] **Step 3: Keep Layer.succeed for dynamic dispatch tests**

The remaining tests ("runs each command sequentially", "collects
failed commands", "continues after failure") use dynamic dispatch
based on command arguments. These require `Layer.succeed` with
custom logic — `CommandRunnerTest` can't express this. Keep the
existing `makeTestRunner` helper but ONLY for these tests.

Alternatively, simplify to inline `Layer.succeed` calls per test
to make the intent clearer.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/main.effect.test.ts`
Expected: PASS — all 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/main.effect.test.ts
git commit -m "test: use CommandRunnerTest.empty() in main.effect tests"
```

---

### Task 5: Run Full Test Suite and Fix Issues

**Files:**

- Potentially any file if issues arise

- [ ] **Step 1: Run full test suite**

Run: `pnpm run test`
Expected: All tests pass

- [ ] **Step 2: Run typecheck**

Run: `pnpm run typecheck`
Expected: No type errors

- [ ] **Step 3: Run linter**

Run: `pnpm run lint`
Expected: No lint errors (or only auto-fixable ones)

- [ ] **Step 4: Fix any issues found**

If tests fail, check:

- `Config.boolean` may not parse `"true"`/`"false"` strings from
  GitHub Actions environment. If so, use
  `Config.string("dry-run").pipe(Config.map(s => s === "true"), Config.withDefault(false))`
- `ActionEnvironment` may fail outside GitHub Actions (tests). If so,
  provide `ActionEnvironmentTest.empty()` in test layers.
- Import paths may need `.js` extension adjustments.

- [ ] **Step 5: Commit fixes if any**

```bash
git add -A
git commit -m "fix: address issues from library API migration"
```

---

### Task 6: Update Design Documentation

**Files:**

- Modify: `.claude/design/pnpm-config-dependency-action/01-dependencies.md`
- Modify: `.claude/design/pnpm-config-dependency-action/02-architecture.md`
- Modify: `.claude/design/pnpm-config-dependency-action/04-module-entry-points.md`
- Modify: `.claude/design/pnpm-config-dependency-action/06-effect-patterns.md`
- Modify: `.claude/design/pnpm-config-dependency-action/08-testing.md`

- [ ] **Step 1: Update 01-dependencies.md**

Remove `@actions/*` packages from the runtime dependencies list.
Add a note that `@actions/*` packages are no longer needed — the
library implements the GitHub Actions runtime protocol natively.

Remove these entries:

```json
"@actions/cache": "^4.1.0",
"@actions/core": "^3.0.0",
"@actions/exec": "^3.0.0",
"@actions/github": "^9.0.0",
"@actions/io": "^3.0.2",
```

Update the `@savvy-web/github-action-effects` version reference from
`^0.4.0` to `^0.11.12`.

Update Key Packages section:

- Remove `@actions/core` entry (no longer a transitive dependency)
- Remove `@actions/github` entry
- Update the `@savvy-web/github-action-effects` entry to describe
  the new API surface (Config, ActionEnvironment, etc.)

- [ ] **Step 2: Update 04-module-entry-points.md**

Replace the `Action.parseInputs` code block with the new `Config.*`
pattern. Update the token lifecycle section to show
`Secret.value(appPrivateKey)`. Update the `Action.run` call at the
bottom.

- [ ] **Step 3: Update 06-effect-patterns.md**

Update the "Running the Effect Program" section to show the new
`Action.run(program, { layer: GitHubAppLive })` pattern.

- [ ] **Step 4: Update 08-testing.md**

Remove the note about `vi.mock("@actions/core")` usage. Update
test patterns to reference `CommandRunnerTest` where applicable.

- [ ] **Step 5: Commit**

```bash
git add .claude/design/
git commit -m "docs: update design docs for library API migration"
```
