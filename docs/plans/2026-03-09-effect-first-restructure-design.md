# Effect-First src/ Restructure Design

## Goal

Restructure `src/` from a flat `lib/` layout with function modules into an
Effect-first architecture with proper `Context.Tag` services, dedicated layers,
and clear separation of schemas, errors, services, layers, and utilities.
Eliminate barrel re-exports.

## Architecture

Replace function-module imports with Effect service injection. Each domain
concern becomes a service with `Context.Tag`, a Live layer (wired to library
services from `@savvy-web/github-action-effects`), and test helpers via
`Layer.succeed`. Pure helper functions move to `src/utils/`. Layer composition
moves to `src/layers/app.ts`. `main.ts` stays as the orchestrator but becomes a
thin ~200-line file making single-line service calls.

## Folder Structure

### Before

```text
src/
  main.ts                           # 690+ lines: inputs, layers, orchestration, PR/summary generation
  lib/
    __test__/fixtures.ts
    errors/types.ts                  # Barrel re-export of schemas/errors.ts
    schemas/
      index.ts                      # Domain schemas + primitive schemas
      errors.ts                     # TaggedError classes
    github/branch.ts                # manageBranch, commitChanges functions
    pnpm/
      config.ts                     # updateConfigDeps function
      regular.ts                    # updateRegularDeps function
      upgrade.ts                    # upgradePnpm function
      format.ts                     # formatWorkspaceYaml, readWorkspaceYaml functions
    lockfile/compare.ts             # captureLockfileState, compareLockfiles functions
    changeset/create.ts             # createChangesets function
  types/index.ts                    # Barrel re-export of schemas
```

### After

```text
src/
  main.ts                           # ~200 lines: inputs, orchestration via service calls
  schemas/
    domain.ts                       # Domain schemas (BranchResult, DependencyUpdateResult, etc.)
    domain.test.ts
  errors/
    errors.ts                       # All TaggedError classes, ActionError union, utilities
    errors.test.ts
  services/
    branch.ts                       # BranchManager service
    branch.test.ts
    pnpm-upgrade.ts                 # PnpmUpgrade service
    pnpm-upgrade.test.ts
    config-deps.ts                  # ConfigDeps service
    config-deps.test.ts
    regular-deps.ts                 # RegularDeps service
    regular-deps.test.ts
    workspace-yaml.ts               # WorkspaceYaml service
    workspace-yaml.test.ts
    lockfile.ts                     # Lockfile service
    lockfile.test.ts
    changesets.ts                   # Changesets service
    changesets.test.ts
    report.ts                       # Report service
    report.test.ts
  layers/
    app.ts                          # makeAppLayer(token, dryRun) composition
  utils/
    pnpm.ts                         # parsePnpmVersion, formatPnpmVersion, detectIndent
    semver.ts                       # resolveLatestInRange
    markdown.ts                     # npmUrl, cleanVersion
    deps.ts                         # matchesPattern, parseSpecifier, parseConfigEntry
    fixtures.test.ts                # Shared test fixtures
```

### Deleted

| Path | Reason |
| --- | --- |
| `src/lib/` | Entire directory replaced by `src/services/`, `src/utils/` |
| `src/types/index.ts` | Barrel re-export eliminated; import from `src/schemas/domain.js` directly |
| `src/lib/errors/types.ts` | Barrel re-export eliminated; import from `src/errors/errors.js` directly |

## Service Definitions

Each service follows this pattern:

```typescript
import { Context, Effect, Layer } from "effect";

export interface ConfigDeps {
  readonly updateConfigDeps: (
    deps: ReadonlyArray<string>,
    workspaceRoot?: string,
  ) => Effect.Effect<ReadonlyArray<DependencyUpdateResult>>;
}

export const ConfigDeps = Context.GenericTag<ConfigDeps>("ConfigDeps");

export const ConfigDepsLive = Layer.effect(
  ConfigDeps,
  Effect.gen(function* () {
    const registry = yield* NpmRegistry;
    return ConfigDeps.of({
      updateConfigDeps: (deps, workspaceRoot) =>
        updateConfigDepsImpl(deps, registry, workspaceRoot),
    });
  }),
);
```

### Service Inventory

| Service | Methods | Library Dependencies |
| --- | --- | --- |
| `BranchManager` | `manage`, `commitChanges` | `GitBranch`, `GitCommit`, `CommandRunner` |
| `PnpmUpgrade` | `upgrade` | `CommandRunner` |
| `ConfigDeps` | `updateConfigDeps` | `NpmRegistry` |
| `RegularDeps` | `updateRegularDeps` | `NpmRegistry` |
| `WorkspaceYaml` | `format`, `read` | None (filesystem) |
| `Lockfile` | `capture`, `compare` | None (`@pnpm/*` packages) |
| `Changesets` | `create` | None (filesystem) |
| `Report` | `generatePRBody`, `generateSummary`, `generateCommitMessage`, `createOrUpdatePR` | `PullRequest` (library) |

## Layer Composition

`src/layers/app.ts` exports `makeAppLayer(token, dryRun)`:

```typescript
export const makeAppLayer = (token: string, dryRun: boolean) => {
  const ghClient = GitHubClientLive(token);
  const ghGraphql = GitHubGraphQLLive.pipe(Layer.provide(ghClient));

  const libraryLayers = Layer.mergeAll(
    ghClient,
    GitBranchLive.pipe(Layer.provide(ghClient)),
    GitCommitLive.pipe(Layer.provide(ghClient)),
    CheckRunLive.pipe(Layer.provide(ghClient)),
    PullRequestLive.pipe(Layer.provide(Layer.merge(ghClient, ghGraphql))),
    NpmRegistryLive.pipe(Layer.provide(CommandRunnerLive)),
    CommandRunnerLive,
    DryRunLive(dryRun),
  );

  const domainLayers = Layer.mergeAll(
    BranchManagerLive,
    ConfigDepsLive,
    RegularDepsLive,
    PnpmUpgradeLive,
    WorkspaceYamlLive,
    LockfileLive,
    ChangesetsLive,
    ReportLive,
  );

  return Layer.provideMerge(domainLayers, libraryLayers);
};
```

`main.ts` uses it:

```typescript
yield* ghApp.withToken(appId, privateKey, (token) =>
  Effect.gen(function* () {
    const appLayer = makeAppLayer(token, dryRun);
    yield* innerProgram(inputs, dryRun).pipe(Effect.provide(appLayer));
  }),
);
```

## PullRequestResult Sentinel Fix

The current `createOrUpdatePR` returns `{ number: 0, url: "" }` on failure,
violating the `PullRequestResult` schema constraints (`number: positive()`,
`url: startsWith("https://")`). The `Report` service fixes this by returning
`Effect<PullRequestResult, PullRequestError>` so failures go through the error
channel instead of sentinel values. The orchestrator in `main.ts` handles the
error:

```typescript
const report = yield* Report;
const pr = yield* report
  .createOrUpdatePR(inputs.branch, allUpdates, changesets, autoMerge)
  .pipe(
    Effect.catchAll((error) =>
      Effect.gen(function* () {
        yield* Effect.logWarning(`PR creation failed: ${error.reason}`);
        return null;
      }),
    ),
  );
```

## Utility Functions

Pure helpers move to `src/utils/` with topical files:

| File | Functions |
| --- | --- |
| `src/utils/pnpm.ts` | `parsePnpmVersion`, `formatPnpmVersion`, `detectIndent` |
| `src/utils/semver.ts` | `resolveLatestInRange` (returns Effect) |
| `src/utils/markdown.ts` | `npmUrl`, `cleanVersion` |
| `src/utils/deps.ts` | `matchesPattern`, `parseSpecifier`, `parseConfigEntry` |

## Schemas and Errors

`src/schemas/domain.ts` contains all domain schemas and their derived types.
Primitive schemas used only by errors (`GitOperation`, `FileSystemOperation`,
`LockfileOperation`) move to `src/errors/errors.ts`.

`src/errors/errors.ts` contains all `Schema.TaggedError` classes, the
`ActionError` union, and utility functions (`isRetryableError`,
`getErrorMessage`).

No barrel re-exports. All imports reference the source file directly.

## Testing Strategy

| Test Level | Mocking Approach |
| --- | --- |
| Service tests | Mock underlying library services via `Layer.succeed` |
| Orchestration tests (`main.ts`) | Mock domain services via `Layer.succeed` |
| Schema/error tests | Direct validation, no mocks |
| Utility tests | Pure function tests, no mocks |

Test count stays at ~231, reorganized into new file locations.

## Import Convention

All internal imports use direct paths. No barrel files.

```typescript
// Before (barrel)
import type { DependencyUpdateResult } from "../types/index.js";
import { FileSystemError } from "../lib/errors/types.js";

// After (direct)
import type { DependencyUpdateResult } from "../schemas/domain.js";
import { FileSystemError } from "../errors/errors.js";
```

## What Stays Unchanged

| Item | Reason |
| --- | --- |
| `main.ts` as orchestrator | Natural home for the 16-step workflow |
| `action.yml` | Entry point unchanged |
| External dependencies | No new packages added |
| Effect service pattern from library | `CommandRunner`, `GitBranch`, etc. used as-is |
| Biome, Turbo, Vitest config | Build tooling unchanged |

## Expected Impact

* ~690-line `main.ts` shrinks to ~200 lines
* 8 domain services with proper DI via `Context.Tag`
* Layer composition extracted to single file
* No barrel re-exports
* `PullRequestResult` sentinel violation fixed
* Same test count (~231), better organized
