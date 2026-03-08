# Testing Strategy

[Back to index](./_index.md)

## Unit Testing

**Test Framework:** Vitest with v8 coverage, forks pool for Effect-TS compatibility

**Key Test Suites (11 test files, ~222 tests total):**

1. **Main action** (`src/main.test.ts`) - 24 tests

   - Full orchestration with mock services
   - Input parsing and validation
   - Dry-run mode behavior
   - Error handling

2. **PR/Summary generation** (`src/main.effect.test.ts`) - 12 tests

   - PR body generation with config/regular dependency tables
   - Commit message generation
   - Summary text generation
   - pnpm upgrade appearing in Config Dependencies table

3. **Schema types** (`src/lib/schemas/index.test.ts`) - 11 tests

   - Schema validation for all domain types
   - BranchResult, DependencyUpdateResult, PullRequest, etc.

4. **Error types** (`src/lib/schemas/errors.test.ts`) - 33 tests

   - Error construction and message formatting
   - Error matching via `_tag`
   - Error utility functions (isRetryable, getErrorMessage)

5. **Branch management** (`src/lib/github/branch.test.ts`) - 8 tests

   - Create new branch via GitBranch service
   - Delete and recreate existing branch
   - Commit changes via GitCommit service
   - No-changes detection

6. **Config dependency updates** (`src/lib/pnpm/config.test.ts`) - 16 tests

   - Config entry parsing (version + integrity hash)
   - npm query and YAML editing
   - Version comparison and skip logic
   - Missing dependency handling

7. **Regular dependency updates** (`src/lib/pnpm/regular.test.ts`) - 22 tests

   - `matchesPattern` (6 tests): exact match, scoped wildcard, bare wildcard, dot metacharacter safety
   - `parseSpecifier` (6 tests): caret, tilde, exact, catalog:, catalog:named, workspace:
   - `updateRegularDeps` Effect integration (10 tests): empty patterns, single dep,
     already latest, wildcard matching, catalog: skip, multi-file updates,
     npm query failure resilience, prefix preservation, deduplication

8. **pnpm self-upgrade** (`src/lib/pnpm/upgrade.test.ts`) - 34 tests

   - `parsePnpmVersion`: exact version, sha suffix, caret prefix, caret+sha, non-pnpm, empty, invalid
   - `formatPnpmVersion`: with and without caret
   - `resolveLatestInRange`: highest in range, already latest, pre-release filtering, no match
   - `upgradePnpm` Effect integration: no pnpm fields, non-pnpm, newer available, already latest,
     devEngines update, caret preservation, indentation preservation

9. **Workspace YAML formatting** (`src/lib/pnpm/format.test.ts`) - 18 tests

   - Array sorting, key sorting, configDependencies sorting
   - YAML stringify options
   - Round-trip formatting

10. **Lockfile comparison** (`src/lib/lockfile/compare.test.ts`) - 23 tests

    - Catalog snapshot comparison
    - Package importer comparison
    - No-change detection
    - Missing lockfile handling

11. **Changeset creation** (`src/lib/changeset/create.test.ts`) - 21 tests

    - Changeset file generation
    - Root workspace changesets
    - Multiple affected packages

## Test Patterns

**Mocking `Action.run`:** Main test files mock `@savvy-web/github-action-effects`
via `vi.mock()` to prevent module-level `Action.run` execution, then test the
exported `program` Effect directly.

**Mock service layers:** Domain module tests create mock `CommandRunner`, `GitBranch`,
`GitCommit` etc. via `Layer.succeed()`:

```typescript
const mockCommandRunner = Layer.succeed(CommandRunner, {
 exec: vi.fn(() => Effect.void),
 execCapture: vi.fn((cmd, args) => {
  // Return mocked output based on command
  if (args.includes("npm view")) {
   return Effect.succeed({ stdout: '"1.2.3"', stderr: "" });
  }
  return Effect.succeed({ stdout: "", stderr: "" });
 }),
});
```

**Remaining `vi.mock("@actions/core")` usage:** Some test files still mock
`@actions/core` because `@actions/github` (directly imported for `context.sha`)
has a transitive dependency on it.

## Coverage

**Coverage Exclusions:**

`src/lib/pnpm/upgrade.ts` is excluded from per-file coverage thresholds in
`vitest.config.ts` due to v8 function counting issues with Effect error callback
patterns. The module is still tested thoroughly via `upgrade.test.ts`.

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
4. **Branch Reset** - Handle existing branch deletion and recreation
5. **Changeset Creation** - Verify correct changeset files generated
