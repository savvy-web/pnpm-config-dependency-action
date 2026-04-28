# Testing Strategy

[Back to index](./_index.md)

## Unit Testing

**Test Framework:** Vitest with v8 coverage, forks pool for Effect-TS compatibility

**Key Test Suites (17 test files, ~287 `it`/`test` blocks):**

1. **Main action** (`src/main.test.ts`) — 24 tests

   - Full orchestration with mock services
   - Input parsing and validation
   - Dry-run mode behavior
   - Error handling

2. **Effect program** (`src/main.effect.test.ts`) — 6 tests

   - End-to-end coverage of report-related concerns through the program

3. **Domain schemas** (`src/schemas/domain.test.ts`) — 13 tests

   - Schema validation for all domain types
   - `BranchResult`, `DependencyUpdateResult`, `PullRequestResult`, etc.

4. **Error types** (`src/errors/errors.test.ts`) — 33 tests

   - Error construction and message formatting
   - Error matching via `_tag`
   - Error utility functions (`isRetryable`, `getErrorMessage`)

5. **Input parser** (`src/utils/input.test.ts`) — 11 tests

   - JSON-array, newline + bullet, `#`-comment, comma-separated forms

6. **BranchManager service** (`src/services/branch.test.ts`) — 8 tests

   - Create new branch via `GitBranch` service
   - Delete and recreate existing branch
   - Commit changes via `GitCommit.commitFiles`
   - No-changes detection

7. **ConfigDeps service** (`src/services/config-deps.test.ts`) — 18 tests

   - Config entry parsing (version + integrity hash)
   - npm query and YAML editing
   - Version comparison and skip logic
   - Missing dependency handling

8. **RegularDeps service** (`src/services/regular-deps.test.ts`) — 36 tests

   - `matchesPattern`: exact match, scoped wildcard, bare wildcard, dot
     metacharacter safety
   - `parseSpecifier`: caret, tilde, exact, `catalog:`, `catalog:named`,
     `workspace:`
   - `updateRegularDeps` Effect integration across `dependencies`,
     `devDependencies`, and `optionalDependencies`: empty patterns, single
     dep, already latest, wildcard matching, `catalog:` skip, multi-file
     updates, multi-section updates within one package, npm query failure
     resilience, prefix preservation, deduplication, accurate `type`
     reporting per section.

9. **PeerSync helpers** (`src/services/peer-sync.test.ts`) — 17 tests

   - `computePeerRange` lock vs minor strategies, including patch-only
     suppression and floor-to-`.0` semantics for minor bumps
   - `syncPeers` workspace integration via the upstream `WorkspaceDiscovery`
     Tag from `workspaces-effect`

10. **PnpmUpgrade service** (`src/services/pnpm-upgrade.test.ts`) — 34 tests

    - `parsePnpmVersion`, `formatPnpmVersion`, `resolveLatestInRange`
    - `upgradePnpm` Effect integration: no pnpm fields, non-pnpm, newer
      available, already latest, `devEngines` update, caret preservation,
      indentation preservation

11. **WorkspaceYaml service** (`src/services/workspace-yaml.test.ts`) — 14 tests

    - Array sorting, key sorting, `configDependencies` sorting
    - YAML stringify options
    - Round-trip formatting

12. **Lockfile service** (`src/services/lockfile.test.ts`) — 27 tests

    - Catalog snapshot comparison (per-importer, per-section triple emission)
    - Package importer comparison
    - No-change detection
    - Missing lockfile handling
    - Yields `WorkspaceDiscovery` from `workspaces-effect` directly (no
      local wrapper).

13. **ChangesetConfig service** (`src/services/changeset-config.test.ts`) — 9 tests

    - Mode detection (silk / vanilla / none) for string and array
      `changelog` config shapes
    - `versionPrivate` flag plumbing
    - Per-`workspaceRoot` caching

14. **Publishability layers** (`src/services/publishability.test.ts`) — 14 tests

    - Silk rules (private + targets, shorthand string targets, access
      inheritance)
    - Adaptive dispatch via `ChangesetConfig.mode`

15. **Changesets service** (`src/services/changesets.test.ts`) — 13 tests

    - Trigger vs informational classification (devDeps suppressed)
    - `regularUpdates` routing by `update.type`
      (dependency/optionalDependency/peerDependency are triggers,
      devDependency is informational only)
    - Catalog change in peerDependency triggers a changeset (covers the
      "config dep updates a catalog consumed in peerDependencies"
      scenario)
    - Peer-sync rewrites trigger a changeset (covers the
      "RegularDeps + peer-minor/peer-lock" scenario)
    - Versionable cascade (publishable OR `versionPrivate`)
    - Empty-changeset suppression (no fallback path)
    - Multi-package emission

16. **Report service** (`src/services/report.test.ts`) — 9 tests

    - PR creation/update via `PullRequest` service
    - Commit message formatting
    - Summary generation

17. **Test fixtures** (`src/utils/fixtures.test.ts`) — shared test utilities

The previous `Workspaces service` test file was removed when the local
wrapper was deleted (issue #38). Workspace discovery is now exercised via
the `__test__/integration/workspaces.int.test.ts` integration suite, which
runs `WorkspaceDiscoveryLive` against real fixtures.

## Test Patterns

**Importing the program directly:** The `program` Effect lives in
`src/program.ts`, separated from the module-level `Action.run` call in
`src/main.ts`. Tests import `program` and `runCommands` from
`./program.js` without ever evaluating `main.ts`, so no `vi.mock()` of the
library is needed just to suppress module-level execution. (Tests still mock
specific library services via `Layer.succeed` to inject fakes.)

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

**No `@actions/core` mocking required:** The library implements the GitHub Actions
protocol natively without `@actions/*` package dependencies, so `vi.mock("@actions/core")`
is no longer needed in any test file.

## Coverage

**Coverage Exclusions:**

`src/services/pnpm-upgrade.ts` is excluded from per-file coverage thresholds in
`vitest.config.ts` due to v8 function counting issues with Effect error callback
patterns. The module is still tested thoroughly via `pnpm-upgrade.test.ts`.

## Integration Testing

**In-Repo Integration Suites (`__test__/integration/`):**

Each suite builds its own `discoveryLayer` from `NodeContext.layer` directly:

```typescript
const platform = NodeContext.layer;
const discoveryLayer = WorkspaceDiscoveryLive.pipe(
 Layer.provide(Layer.merge(WorkspaceRootLive.pipe(Layer.provide(platform)), platform)),
);
```

- `workspaces.int.test.ts` — Verifies `WorkspaceDiscovery.listPackages` and
  `importerMap` against real single-leaf and multi-leaf fixtures.
- `lockfile-compare.int.test.ts` — Exercises `compareLockfiles` against
  paired `pnpm-lock.before.yaml` / `pnpm-lock.after.yaml` fixtures
  covering catalog and importer change shapes.
- `changeset-emission.int.test.ts` — Exercises the full
  `Changesets.create` gating cascade against fixtures with varying
  publishability and `versionPrivate` settings.

**External Integration Test Scenarios (live GitHub repo, future work):**

1. **Full Workflow** - End-to-end test of entire action
2. **No Changes** - Verify early exit when already up-to-date
3. **Partial Failures** - Some updates succeed, some fail
4. **Branch Reset** - Handle existing branch deletion and recreation
5. **Changeset Creation** - Verify correct changeset files generated
