# Testing Strategy

[Back to index](./_index.md)

## Unit Testing

**Test Framework:** Vitest with Effect integration

**Test Layer Pattern:**

Tests use library-provided test layers from `@savvy-web/github-action-effects` instead
of `vi.mock("@actions/core")` for mocking action I/O. Each test layer provides an
in-memory implementation of the corresponding service:

- `ActionInputsTest.layer(inputs)` - Provides inputs from a `Record<string, string>`
- `ActionOutputsTest.layer(state)` - Captures outputs, secrets, summaries, failures
- `ActionStateTest.layer(state)` - In-memory state store (save/load)
- `ActionLoggerTest.layer(state)` - Captures log messages by level

```typescript
import {
 ActionInputsTest, ActionOutputsTest,
 ActionStateTest, ActionLoggerTest,
} from "@savvy-web/github-action-effects";
import { Effect, Layer, LogLevel, Logger } from "effect";

const makeTestLayer = (inputs: Record<string, string>) => {
 const outputState = ActionOutputsTest.empty();
 const stateState = ActionStateTest.empty();
 const layer = Layer.mergeAll(
  ActionInputsTest.layer(inputs),
  ActionOutputsTest.layer(outputState),
  ActionLoggerTest.layer(ActionLoggerTest.empty()),
  ActionStateTest.layer(stateState),
 );
 return { outputState, stateState, layer };
};

// Run program with test layers, suppress log output
const runProgram = (layer: Layer.Layer<never, never, never>) =>
 Effect.runPromise(
  Effect.exit(program.pipe(
   Effect.provide(layer),
   Logger.withMinimumLogLevel(LogLevel.None),
  ))
 );
```

**Mocking `Action.run`:** Entry point tests (pre.test.ts, post.test.ts, main.test.ts)
mock `Action.run` via `vi.mock("@savvy-web/github-action-effects")` to prevent
module-level execution, then test the exported `program` Effect directly.

**Remaining `vi.mock("@actions/core")` usage:** Some test files (services, branch, auth,
lockfile) still mock `@actions/core` because `@actions/github` (which is still directly
imported for repository context) has a transitive dependency on it. These mocks prevent
`@actions/core` from throwing in non-GitHub-Actions environments.

**Key Test Suites:**

1. **Pre-action** (`src/pre.test.ts`)

   - Token generation and state saving
   - StartTime state persistence
   - Missing app-id failure
   - Token generation error handling

2. **Post-action** (`src/post.test.ts`)

   - Token revocation from state
   - Skip revocation flag
   - Missing token graceful handling

3. **Main action** (`src/main.test.ts`, `src/main.effect.test.ts`)

   - Full orchestration with mock services
   - PR body generation with config/regular dependency tables
   - Commit message generation with app slug
   - Dry-run mode behavior

4. **Input Parsing** (`src/lib/inputs.test.ts`)

   - Valid inputs via `ActionInputsTest.layer()`
   - Missing required inputs
   - Invalid input formats
   - Empty dependency lists
   - Deleted utility function tests removed

5. **Error Types** (`src/lib/schemas/errors.test.ts`)

   - Error construction
   - Error matching
   - Error serialization

6. **GitHub Auth** (`src/lib/github/auth.test.ts`)

   - JWT generation
   - Installation token creation
   - Token expiration handling
   - Authentication failures

7. **Branch Management** (`src/lib/github/branch.test.ts`)

   - Create new branch
   - Rebase existing branch
   - Handle conflicts
   - Already up-to-date

8. **Config Dependency Updates** (`src/lib/pnpm/config.test.ts`)
   - Successful updates
   - Update failures
   - Version parsing
   - Error accumulation

9. **Regular Dependency Updates** (`src/lib/pnpm/regular.test.ts`) - 22 tests
   - `matchesPattern` (6 tests): exact match, exact mismatch, scoped wildcard, scoped mismatch, bare wildcard, dot metacharacter safety
   - `parseSpecifier` (6 tests): caret, tilde, exact, catalog:, catalog:named, workspace:
   - `updateRegularDeps` Effect integration (10 tests): empty patterns, single dep newer version,
     already latest, wildcard matching multiple deps, catalog: skip, multi-file updates,
     npm query failure resilience, tilde prefix preservation, exact version preservation,
     deduplication across dep fields

10. **pnpm Self-Upgrade** (`src/lib/pnpm/upgrade.test.ts`) - 30 tests
    - `parsePnpmVersion` (11 tests): exact version, sha suffix, caret prefix, caret+sha, non-pnpm packageManager, empty string, invalid semver; devEngines exact, caret, empty, invalid
    - `formatPnpmVersion` (2 tests): with and without caret
    - `resolveLatestInRange` (6 tests): highest in range, already latest, pre-release filtering, no match, empty versions, no major jump
    - `upgradePnpm` Effect integration (11 tests): no pnpm fields, non-pnpm packageManager, newer version available, already latest, devEngines update, caret preservation, devEngines-only (no packageManager), non-pnpm devEngines skip, tab indentation preservation, space indentation preservation, no newer version

11. **PR Body Generation** (`src/main.effect.test.ts`)
    - Includes tests for pnpm upgrade appearing in Config Dependencies table

**Coverage Exclusions:**

`src/lib/pnpm/upgrade.ts` is excluded from per-file coverage thresholds in `vitest.config.ts` due to
v8 function counting issues with Effect error callback patterns. The module is still tested
thoroughly via `upgrade.test.ts`.

## Integration Testing

**Test Repository Setup:**

Create a test repository with:

- pnpm workspace configuration
- Multiple packages
- Changesets enabled
- Config dependencies defined

**Integration Test Scenarios:**

1. **Full Workflow** - End-to-end test of entire action
2. **No Changes** - Verify early exit when already up-to-date
3. **Partial Failures** - Some updates succeed, some fail
4. **Branch Rebase** - Handle existing branch that needs rebase
5. **Changeset Creation** - Verify correct changeset files generated

**Mock GitHub API:**

Use `nock` or MSW to mock GitHub API calls:

```typescript
import nock from "nock";

describe("Pull Request Creation", () => {
 beforeEach(() => {
  nock("https://api.github.com")
   .post("/repos/owner/repo/pulls")
   .reply(201, {
    number: 123,
    html_url: "https://github.com/owner/repo/pull/123"
   });
 });

 it("should create PR successfully", async () => {
  // Test implementation
 });
});
```

## Test Fixtures

**Fixture Structure:**

```text
tests/
├── fixtures/
│   ├── repositories/
│   │   ├── basic/                # Simple repo, no changesets
│   │   ├── monorepo/             # Monorepo with changesets
│   │   └── no-updates/           # All deps already latest
│   ├── responses/
│   │   ├── github-api/           # Mocked GitHub API responses
│   │   └── pnpm/                 # Mocked pnpm command outputs
│   └── expectations/
│       ├── pr-descriptions/      # Expected PR descriptions
│       └── changesets/           # Expected changeset files
└── helpers/
    ├── setup-repo.ts             # Create test repo from fixture
    ├── mock-github.ts            # GitHub API mocking utilities
    └── assert-effects.ts         # Effect assertion helpers
```
