# Testing Strategy

[Back to index](./_index.md)

## Unit Testing

**Test Framework:** Vitest with Effect integration

**Key Test Suites:**

1. **Input Parsing** (`src/lib/inputs.test.ts`)

   - Valid inputs
   - Missing required inputs
   - Invalid input formats
   - Empty dependency lists

2. **Error Types** (`src/lib/errors/types.test.ts`)

   - Error construction
   - Error matching
   - Error serialization

3. **GitHub Auth** (`src/lib/github/auth.test.ts`)

   - JWT generation
   - Installation token creation
   - Token expiration handling
   - Authentication failures

4. **Branch Management** (`src/lib/github/branch.test.ts`)

   - Create new branch
   - Rebase existing branch
   - Handle conflicts
   - Already up-to-date

5. **Config Dependency Updates** (`src/lib/pnpm/config.test.ts`)
   - Successful updates
   - Update failures
   - Version parsing
   - Error accumulation

6. **Regular Dependency Updates** (`src/lib/pnpm/regular.test.ts`) - 22 tests
   - `matchesPattern` (6 tests): exact match, exact mismatch, scoped wildcard, scoped mismatch, bare wildcard, dot metacharacter safety
   - `parseSpecifier` (6 tests): caret, tilde, exact, catalog:, catalog:named, workspace:
   - `updateRegularDeps` Effect integration (10 tests): empty patterns, single dep newer version,
     already latest, wildcard matching multiple deps, catalog: skip, multi-file updates,
     npm query failure resilience, tilde prefix preservation, exact version preservation,
     deduplication across dep fields

7. **pnpm Self-Upgrade** (`src/lib/pnpm/upgrade.test.ts`) - 30 tests
   - `parsePnpmVersion` (11 tests): exact version, sha suffix, caret prefix, caret+sha, non-pnpm packageManager, empty string, invalid semver; devEngines exact, caret, empty, invalid
   - `formatPnpmVersion` (2 tests): with and without caret
   - `resolveLatestInRange` (6 tests): highest in range, already latest, pre-release filtering, no match, empty versions, no major jump
   - `upgradePnpm` Effect integration (11 tests): no pnpm fields, non-pnpm packageManager, newer version available, already latest, devEngines update, caret preservation, devEngines-only (no packageManager), non-pnpm devEngines skip, tab indentation preservation, space indentation preservation, no newer version

8. **PR Body Generation** (`src/main.effect.test.ts`)
   - Includes tests for pnpm upgrade appearing in Config Dependencies table

**Coverage Exclusions:**

`src/lib/pnpm/upgrade.ts` is excluded from per-file coverage thresholds in `vitest.config.ts` due to
v8 function counting issues with Effect error callback patterns. The module is still tested
thoroughly via `upgrade.test.ts`.

**Example Test:**

```typescript
import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { updateConfigDependency } from "./config.js";
import { PnpmError } from "../errors/types.js";

describe("updateConfigDependency", () => {
 it("should update config dependency successfully", async () => {
  const result = await Effect.runPromise(updateConfigDependency("typescript"));

  expect(result.dependency).toBe("typescript");
  expect(result.type).toBe("config");
  expect(result.from).toBeTruthy();
  expect(result.to).toBeTruthy();
 });

 it("should fail gracefully for non-existent dependency", async () => {
  const result = await Effect.runPromise(
   updateConfigDependency("non-existent-package").pipe(Effect.either)
  );

  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) {
   expect(result.left._tag).toBe("PnpmError");
  }
 });
});
```

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
