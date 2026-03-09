# Testing Strategy

[Back to index](./_index.md)

## Unit Testing

**Test Framework:** Vitest with v8 coverage, forks pool for Effect-TS compatibility

**Key Test Suites (13 test files, 235 tests total):**

1. **Main action** (`src/main.test.ts`) - 24 tests

   - Full orchestration with mock services
   - Input parsing and validation
   - Dry-run mode behavior
   - Error handling

2. **Report service** (`src/main.effect.test.ts`) - 12 tests

   - PR body generation with config/regular dependency tables
   - Commit message generation
   - Summary text generation
   - pnpm upgrade appearing in Config Dependencies table

3. **Domain schemas** (`src/schemas/domain.test.ts`) - 11 tests

   - Schema validation for all domain types
   - BranchResult, DependencyUpdateResult, PullRequestResult, etc.

4. **Error types** (`src/errors/errors.test.ts`) - 33 tests

   - Error construction and message formatting
   - Error matching via `_tag`
   - Error utility functions (isRetryable, getErrorMessage)

5. **BranchManager service** (`src/services/branch.test.ts`) - 8 tests

   - Create new branch via GitBranch service
   - Delete and recreate existing branch
   - Commit changes via GitCommit service
   - No-changes detection

6. **ConfigDeps service** (`src/services/config-deps.test.ts`) - 16 tests

   - Config entry parsing (version + integrity hash)
   - npm query and YAML editing
   - Version comparison and skip logic
   - Missing dependency handling

7. **RegularDeps service** (`src/services/regular-deps.test.ts`) - 22 tests

   - `matchesPattern` (6 tests): exact match, scoped wildcard, bare wildcard, dot metacharacter safety
   - `parseSpecifier` (6 tests): caret, tilde, exact, catalog:, catalog:named, workspace:
   - `updateRegularDeps` Effect integration (10 tests): empty patterns, single dep,
     already latest, wildcard matching, catalog: skip, multi-file updates,
     npm query failure resilience, prefix preservation, deduplication

8. **PnpmUpgrade service** (`src/services/pnpm-upgrade.test.ts`) - 34 tests

   - `parsePnpmVersion`: exact version, sha suffix, caret prefix, caret+sha, non-pnpm, empty, invalid
   - `formatPnpmVersion`: with and without caret
   - `resolveLatestInRange`: highest in range, already latest, pre-release filtering, no match
   - `upgradePnpm` Effect integration: no pnpm fields, non-pnpm, newer available, already latest,
     devEngines update, caret preservation, indentation preservation

9. **WorkspaceYaml service** (`src/services/workspace-yaml.test.ts`) - 18 tests

   - Array sorting, key sorting, configDependencies sorting
   - YAML stringify options
   - Round-trip formatting

10. **Lockfile service** (`src/services/lockfile.test.ts`) - 23 tests

    - Catalog snapshot comparison
    - Package importer comparison
    - No-change detection
    - Missing lockfile handling

11. **Changesets service** (`src/services/changesets.test.ts`) - 21 tests

    - Changeset file generation
    - Root workspace changesets
    - Multiple affected packages

12. **Report service** (`src/services/report.test.ts`) - tests for PR/summary

    - PR creation/update via PullRequest service
    - Commit message formatting
    - Summary generation

13. **Test fixtures** (`src/utils/fixtures.test.ts`) - shared test utilities

## Test Patterns

**Mocking `Action.run`:** Main test files mock `@savvy-web/github-action-effects`
via `vi.mock()` to prevent module-level `Action.run` execution, then test the
exported `program` Effect directly.

**Mock service layers:** Domain service tests create mock library services via
`Layer.succeed()`:

```typescript
const mockNpmRegistry = Layer.succeed(NpmRegistry, {
 getLatestVersion: vi.fn((pkg) =>
  Effect.succeed({ version: "1.2.3", integrity: "sha512-..." }),
 ),
});
```

Domain service tests provide the mock library layer to the service's Live layer:

```typescript
const testLayer = ConfigDepsLive.pipe(Layer.provide(mockNpmRegistry));
```

**Remaining `vi.mock("@actions/core")` usage:** Some test files still mock
`@actions/core` because `@actions/github` (directly imported for `context.sha`)
has a transitive dependency on it.

## Coverage

**Coverage Exclusions:**

`src/services/pnpm-upgrade.ts` is excluded from per-file coverage thresholds in
`vitest.config.ts` due to v8 function counting issues with Effect error callback
patterns. The module is still tested thoroughly via `pnpm-upgrade.test.ts`.

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
