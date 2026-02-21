# Library Modules (src/lib/)

[Back to index](./_index.md)

## src/lib/inputs.ts

Parse and validate action inputs from `action.yml`.

Uses Effect Schema (`src/lib/schemas/index.ts`) for type-safe validation and decoding.
The `ActionInputs` schema has 9 fields including the `updatePnpm: Schema.Boolean` field,
the `autoMerge` field (values: `""`, `"merge"`, `"squash"`, or `"rebase"`), and the
`changesets: Schema.Boolean` field (default: `true`).

**Validation Logic:**

The action requires at least one update type to be active. The validation allows the action
to run with only `updatePnpm: true` even if both `configDependencies` and `dependencies`
arrays are empty. This means any of the following are valid configurations:

- `configDependencies` is non-empty
- `dependencies` is non-empty
- `updatePnpm` is `true` (default)
- Any combination of the above

```typescript
export const parseInputs: Effect.Effect<ActionInputs, InvalidInputError> = Effect.gen(function* () {
 const appId = yield* getRequiredInput("app-id");
 const appPrivateKey = yield* getRequiredInput("app-private-key");
 const branch = yield* getInput("branch").pipe(Effect.map((b) => b || "pnpm/config"));
 const updatePnpm = yield* getBooleanInput("update-pnpm"); // default: true

 const configDeps = yield* getMultilineInput("config-dependencies").pipe(
  Effect.map((lines) => lines.filter((line) => line.trim().length > 0))
 );

 const deps = yield* getMultilineInput("dependencies").pipe(
  Effect.map((lines) => lines.filter((line) => line.trim().length > 0))
 );

 // Validate at least one update type is specified
 // updatePnpm: true alone is sufficient
 if (configDeps.length === 0 && deps.length === 0 && !updatePnpm) {
  return yield* Effect.fail(
   new InvalidInputError({
    field: "inputs",
    value: { configDeps, deps, updatePnpm },
    reason: "Must specify at least one of: config-dependencies, dependencies, or update-pnpm"
   })
  );
 }

 const autoMerge = yield* getInput("auto-merge").pipe(
  Effect.map((val) => {
   const normalized = val.trim().toLowerCase();
   if (normalized === "" || normalized === "merge" || normalized === "squash" || normalized === "rebase") {
    return normalized as "" | "merge" | "squash" | "rebase";
   }
   return ""; // default to disabled for invalid values
  })
 );

 const changesets = yield* getBooleanInput("changesets"); // default: true

 return {
  appId, appPrivateKey, branch, updatePnpm, autoMerge, changesets,
  configDependencies: configDeps, dependencies: deps, run: []
 };
});
```

## src/lib/github/auth.ts

GitHub App authentication:

```typescript
export const createAuthenticatedClient: Effect.Effect<
 AuthenticatedClient,
 AuthenticationError | GitHubApiError
> = Effect.gen(function* () {
 // Token should be set by pre.ts
 const token = yield* getEnvVar("GITHUB_TOKEN").pipe(
  Effect.catchAll(() =>
   Effect.fail(
    new AuthenticationError({
     reason: "GITHUB_TOKEN not found. Ensure pre.ts ran successfully."
    })
   )
  )
 );

 const octokit = new Octokit({ auth: token });

 // Verify authentication by getting installation ID
 const installationId = yield* getInstallationId(octokit);

 return { octokit, installationId };
});
```

## src/lib/github/branch.ts

Branch management with create/rebase logic:

```typescript
export const manageBranch = (
 client: AuthenticatedClient,
 context: GitHubContext,
 branchName: string
): Effect.Effect<BranchResult, GitHubApiError | GitError> =>
 Effect.gen(function* () {
  const exists = yield* branchExists(client, context, branchName);

  if (!exists) {
   // Create new branch from default branch
   yield* createBranch(client, context, branchName, context.defaultBranch);
   yield* gitCheckout(branchName);
   return {
    branch: branchName,
    created: true,
    upToDate: true,
    baseRef: context.defaultBranch
   };
  }

  // Branch exists - check if up-to-date with main
  const needsRebase = yield* branchNeedsRebase(context.defaultBranch, branchName);

  if (needsRebase) {
   // Rebase onto default branch
   yield* gitCheckout(branchName);
   yield* gitRebase(context.defaultBranch);
   return {
    branch: branchName,
    created: false,
    upToDate: false,
    baseRef: context.defaultBranch
   };
  }

  // Already up-to-date
  yield* gitCheckout(branchName);
  return {
   branch: branchName,
   created: false,
   upToDate: true,
   baseRef: context.defaultBranch
  };
 });
```

## src/lib/pnpm/format.ts

**Purpose:** Format `pnpm-workspace.yaml` consistently to avoid lint-staged hook changes.

The formatting must match the `@savvy-web/lint-staged` PnpmWorkspace handler to ensure
no changes are made by the pre-commit hook after our action commits.

**Formatting Rules:**

1. **Sort arrays alphabetically:** `packages`, `onlyBuiltDependencies`, `publicHoistPattern`
2. **Sort `configDependencies` object keys alphabetically** (entries inserted by
   `pnpm add --config` may not be in order)
3. **Sort top-level keys alphabetically**, but keep `packages` first
4. **YAML stringify options:**
   - `indent: 2` - Two-space indentation
   - `lineWidth: 0` - Disable line wrapping
   - `singleQuote: false` - Use double quotes

**Implementation:**

```typescript
import { parse, stringify } from "yaml";
import { Effect } from "effect";

const SORTABLE_ARRAY_KEYS = new Set(["packages", "onlyBuiltDependencies", "publicHoistPattern"]);
const SORTABLE_MAP_KEYS = new Set(["configDependencies"]);

const STRINGIFY_OPTIONS = {
 indent: 2,
 lineWidth: 0, // Disable line wrapping
 singleQuote: false,
} as const;

interface PnpmWorkspaceContent {
 packages?: string[];
 onlyBuiltDependencies?: string[];
 publicHoistPattern?: string[];
 configDependencies?: Record<string, string>;
 [key: string]: unknown;
}

const sortContent = (content: PnpmWorkspaceContent): PnpmWorkspaceContent => {
 const result: PnpmWorkspaceContent = {};

 // Sort keys alphabetically, but keep 'packages' first
 const keys = Object.keys(content).sort((a, b) => {
  if (a === "packages") return -1;
  if (b === "packages") return 1;
  return a.localeCompare(b);
 });

 for (const key of keys) {
  const value = content[key];
  if (SORTABLE_ARRAY_KEYS.has(key) && Array.isArray(value)) {
   result[key] = [...value].sort();
  } else if (SORTABLE_MAP_KEYS.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
   const sorted: Record<string, unknown> = {};
   for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[k] = (value as Record<string, unknown>)[k];
   }
   result[key] = sorted;
  } else {
   result[key] = value;
  }
 }

 return result;
};

export const formatWorkspaceYaml: Effect.Effect<void, FileSystemError> =
 Effect.gen(function* () {
  const content = yield* readFile("pnpm-workspace.yaml");
  const parsed = parse(content) as PnpmWorkspaceContent;
  const sorted = sortContent(parsed);
  const formatted = stringify(sorted, STRINGIFY_OPTIONS);
  yield* writeFile("pnpm-workspace.yaml", formatted);
 });
```

## src/lib/pnpm/upgrade.ts

**Purpose:** Upgrade pnpm itself to the latest version within the `^` semver range.

Uses `semver` for version parsing, comparison, and range resolution. Updates both the
`packageManager` field (via `corepack use`) and the `devEngines.packageManager.version`
field (via direct JSON manipulation with indentation detection).

**Exported Types:**

- `PnpmUpgradeResult` - Result with `from`, `to`, `packageManagerUpdated`, `devEnginesUpdated`
- `ParsedPnpmVersion` - Parsed version with `version`, `hasCaret`, `hasSha` flags

**Exported Functions:**

- `parsePnpmVersion(raw, stripPnpmPrefix?)` - Parse version from `packageManager` or `devEngines` field
- `formatPnpmVersion(version, hasCaret)` - Format version with optional caret prefix
- `resolveLatestInRange(versions, current)` - Find highest stable version satisfying `^current`
- `upgradePnpm(workspaceRoot?)` - Main upgrade Effect requiring `PnpmExecutor` service

**Algorithm:**

1. Read root `package.json`
2. Parse `packageManager` field (format: `pnpm@10.28.2`, `pnpm@^10.28.2+sha512...`)
3. Parse `devEngines.packageManager` field (name must be `pnpm`, version field parsed)
4. If neither field found, return null
5. Query available pnpm versions via `npm view pnpm versions --json` (uses `PnpmExecutor.run()`)
6. Filter to stable releases only (no pre-release via `semver.prerelease`)
7. Resolve latest version in `^` range via `semver.maxSatisfying`
8. Take highest resolved version across both fields
9. If already up-to-date, return null
10. Run `corepack use pnpm@<version>` to update `packageManager` field
11. Re-read `package.json`, detect indentation (`detectIndent` internal helper), update `devEngines.packageManager.version`
12. Return `PnpmUpgradeResult`

**Effect Signature:**

```typescript
export const upgradePnpm = (
 workspaceRoot?: string
): Effect.Effect<PnpmUpgradeResult | null, FileSystemError, PnpmExecutor>
```

**Version Format Handling:**

| Input | `stripPnpmPrefix` | Parsed |
| --- | --- | --- |
| `pnpm@10.28.2` | `true` | `{ version: "10.28.2", hasCaret: false, hasSha: false }` |
| `pnpm@^10.28.2+sha512...` | `true` | `{ version: "10.28.2", hasCaret: true, hasSha: true }` |
| `^10.28.2` | `false` | `{ version: "10.28.2", hasCaret: true, hasSha: false }` |
| `yarn@4.0.0` | `true` | `null` (not pnpm) |

## src/lib/pnpm/config.ts

Config dependency updates:

```typescript
export const updateConfigDependencies = (
 dependencies: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<DependencyUpdateResult>, DependencyUpdateFailures> =>
 Effect.gen(function* () {
  const results: Array<DependencyUpdateResult> = [];
  const failures: Array<{ dependency: string; error: PnpmError }> = [];

  // Update each config dependency sequentially (not parallel)
  for (const dep of dependencies) {
   const result = yield* updateConfigDependency(dep).pipe(
    Effect.catchAll((error) =>
     Effect.gen(function* () {
      failures.push({ dependency: dep, error });
      return yield* Effect.succeed(null);
     })
    )
   );

   if (result !== null) {
    results.push(result);
   }
  }

  // If all failed, return error
  if (failures.length > 0 && results.length === 0) {
   return yield* Effect.fail(new DependencyUpdateFailures({ failures, successful: [] }));
  }

  // If some failed, log warnings but continue
  if (failures.length > 0) {
   yield* logWarning(
    `Failed to update ${failures.length} config dependencies`,
    failures.map((f) => f.dependency)
   );
  }

  return results;
 });

const updateConfigDependency = (dependency: string): Effect.Effect<DependencyUpdateResult, PnpmError> =>
 Effect.gen(function* () {
  const before = yield* getConfigDependencyVersion(dependency).pipe(
   Effect.catchAll(() => Effect.succeed(null))
  );

  yield* execPnpm(["add", "--config", dependency]);

  const after = yield* getConfigDependencyVersion(dependency);

  return {
   dependency,
   from: before,
   to: after,
   type: "config" as const,
   package: null
  };
 });
```

## src/lib/pnpm/regular.ts

**Purpose:** Update regular (non-config) dependencies by querying npm directly instead of
using `pnpm up --latest`. This avoids the `catalogMode: strict` issue where `pnpm up`
promotes non-catalog dependencies to the default catalog and rewrites specifiers to
`catalog:` references.

**Exported Functions:**

- `matchesPattern(depName, pattern)` - Glob matching via Node's native `path.matchesGlob`
- `parseSpecifier(specifier)` - Parse version specifier into `{ prefix, version }`,
  returns `null` for `catalog:` and `workspace:` specifiers
- `updateRegularDeps(patterns, workspaceRoot?)` - Main Effect function

**Algorithm:**

1. Find all workspace `package.json` paths via `workspace-tools` `getPackageInfosAsync()`
   plus the root `package.json`
2. For each `package.json`, scan `dependencies`, `devDependencies`, `optionalDependencies`
   for deps matching any pattern
3. Skip deps with `catalog:` or `workspace:` specifiers
4. Deduplicate entries per path+dep (a dep may appear in both `dependencies` and
   `devDependencies` of the same file)
5. Collect unique dependency names across all files
6. For each unique dep, query `npm view <pkg> dist-tags.latest --json` via `PnpmExecutor.run()`
7. Compare latest vs current: if newer, construct new specifier (preserve prefix + latest)
8. Update each `package.json` with new specifiers (preserve indentation via `detectIndent`
   from `upgrade.ts`)
9. Return `DependencyUpdateResult[]` with from/to specifiers and affected packages

**Effect Signature:**

```typescript
export const updateRegularDeps = (
 patterns: ReadonlyArray<string>,
 workspaceRoot?: string,
): Effect.Effect<ReadonlyArray<DependencyUpdateResult>, never, PnpmExecutor>
```

**Key Design Decisions:**

- Queries npm registry directly instead of relying on `pnpm up` to avoid catalog promotion
- Uses Node's native `path.matchesGlob` for pattern matching (avoids regex metacharacter
  injection with package names containing `.`, `+`, etc.)
- Preserves specifier prefix (`^`, `~`, or exact) from existing `package.json`
- Skips `catalog:` and `workspace:` specifiers entirely (leave catalog-managed deps to
  the config dependency update path)
- Deduplicates per path+dep to avoid duplicate PR table rows when a dep appears in
  multiple dep fields of the same `package.json`
- Gracefully handles npm query failures per-dependency (logs warning, continues with others)
- Reuses `detectIndent` from `upgrade.ts` for consistent `package.json` formatting

## src/lib/lockfile/compare.ts

**Purpose:** Compare lockfile snapshots before and after updates to detect changes.

Uses pnpm's official packages instead of manual parsing:

```typescript
import { readWantedLockfile } from "@pnpm/lockfile.fs";
import type { LockfileObject, CatalogSnapshots } from "@pnpm/lockfile.types";
import { getWorkspaceInfosAsync } from "workspace-tools";
import { Effect } from "effect";

interface LockfileChange {
 readonly type: "config" | "regular";
 readonly dependency: string;
 readonly from: string | null;
 readonly to: string;
 readonly affectedPackages: ReadonlyArray<string>;
}

/**
 * Captures lockfile state for later comparison.
 */
export const captureLockfileState = (
 workspaceRoot: string
): Effect.Effect<LockfileObject | null, FileSystemError> =>
 Effect.tryPromise({
  try: () => readWantedLockfile(workspaceRoot, { ignoreIncompatible: true }),
  catch: (error) => new FileSystemError({
   operation: "read",
   path: "pnpm-lock.yaml",
   reason: String(error)
  })
 });

/**
 * Compares two lockfile states to detect dependency changes.
 */
export const compareLockfiles = (
 before: LockfileObject | null,
 after: LockfileObject | null,
 workspaceRoot: string
): Effect.Effect<ReadonlyArray<LockfileChange>, never> =>
 Effect.gen(function* () {
  if (!before || !after) {
   return [];
  }

  const changes: LockfileChange[] = [];

  // Compare catalog snapshots (config dependencies)
  const catalogChanges = yield* compareCatalogs(
   before.catalogs ?? {},
   after.catalogs ?? {}
  );
  changes.push(...catalogChanges);

  // Compare package snapshots (regular dependencies)
  const packageChanges = yield* comparePackages(
   before,
   after,
   workspaceRoot
  );
  changes.push(...packageChanges);

  return changes;
 });

/**
 * Compare catalog snapshots to detect config dependency changes.
 */
const compareCatalogs = (
 before: CatalogSnapshots,
 after: CatalogSnapshots
): Effect.Effect<ReadonlyArray<LockfileChange>, never> =>
 Effect.sync(() => {
  const changes: LockfileChange[] = [];

  // Check all catalogs in 'after' for changes/additions
  for (const [catalogName, afterEntries] of Object.entries(after)) {
   const beforeEntries = before[catalogName] ?? {};

   for (const [dep, afterEntry] of Object.entries(afterEntries)) {
    const beforeEntry = beforeEntries[dep];
    const afterVersion = afterEntry.specifier;
    const beforeVersion = beforeEntry?.specifier ?? null;

    if (beforeVersion !== afterVersion) {
     changes.push({
      type: "config",
      dependency: `${dep} (catalog:${catalogName})`,
      from: beforeVersion,
      to: afterVersion,
      affectedPackages: [] // Config deps affect all packages
     });
    }
   }
  }

  return changes;
 });

/**
 * Compare package importers to detect which packages have changed dependencies.
 */
const comparePackages = (
 before: LockfileObject,
 after: LockfileObject,
 workspaceRoot: string
): Effect.Effect<ReadonlyArray<LockfileChange>, never> =>
 Effect.gen(function* () {
  const changes: LockfileChange[] = [];

  // Get workspace package info to map importers to package names
  const workspaceInfos = yield* Effect.tryPromise({
   try: () => getWorkspaceInfosAsync(workspaceRoot),
   catch: () => ({}) // Fallback to empty if detection fails
  });

  // Compare importers (each workspace package)
  for (const [importerId, afterSnapshot] of Object.entries(after.importers ?? {})) {
   const beforeSnapshot = before.importers?.[importerId];
   if (!beforeSnapshot) continue;

   // Find package name from workspace info
   const packageName = findPackageName(importerId, workspaceInfos);

   // Compare dependencies, devDependencies, optionalDependencies
   for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const beforeDeps = beforeSnapshot[field] ?? {};
    const afterDeps = afterSnapshot[field] ?? {};

    for (const [dep, afterVersion] of Object.entries(afterDeps)) {
     const beforeVersion = beforeDeps[dep];
     if (beforeVersion !== afterVersion) {
      changes.push({
       type: "regular",
       dependency: dep,
       from: beforeVersion ?? null,
       to: afterVersion,
       affectedPackages: packageName ? [packageName] : []
      });
     }
    }
   }
  }

  return changes;
 });
```

## src/lib/changeset/analyze.ts

**Purpose:** Determine which workspace packages were affected by dependency changes.

```typescript
import { getWorkspaceInfosAsync, getWorkspacePackagePathsAsync } from "workspace-tools";
import { Effect } from "effect";

interface AffectedPackage {
 readonly name: string;
 readonly path: string;
 readonly version: string;
 readonly changes: ReadonlyArray<{
  dependency: string;
  from: string | null;
  to: string;
 }>;
}

/**
 * Analyzes which packages are affected by dependency changes.
 */
export const analyzeAffectedPackages = (
 workspaceRoot: string,
 changes: ReadonlyArray<LockfileChange>
): Effect.Effect<ReadonlyArray<AffectedPackage>, FileSystemError> =>
 Effect.gen(function* () {
  const workspaceInfos = yield* Effect.tryPromise({
   try: () => getWorkspaceInfosAsync(workspaceRoot),
   catch: (error) => new FileSystemError({
    operation: "read",
    path: "workspace",
    reason: `Failed to get workspace info: ${error}`
   })
  });

  // Group changes by affected package
  const packageChanges = new Map<string, AffectedPackage["changes"][number][]>();

  // Config dependency changes affect all packages
  const configChanges = changes.filter((c) => c.type === "config");
  const regularChanges = changes.filter((c) => c.type === "regular");

  // For each workspace package
  const affected: AffectedPackage[] = [];
  for (const [name, info] of Object.entries(workspaceInfos)) {
   const pkgChanges: AffectedPackage["changes"][number][] = [];

   // Add config changes (they affect everyone)
   for (const change of configChanges) {
    pkgChanges.push({
     dependency: change.dependency,
     from: change.from,
     to: change.to
    });
   }

   // Add regular changes specific to this package
   for (const change of regularChanges) {
    if (change.affectedPackages.includes(name)) {
     pkgChanges.push({
      dependency: change.dependency,
      from: change.from,
      to: change.to
     });
    }
   }

   if (pkgChanges.length > 0) {
    affected.push({
     name,
     path: info.packageJsonPath.replace("/package.json", ""),
     version: info.packageJson.version ?? "0.0.0",
     changes: pkgChanges
    });
   }
  }

  return affected;
 });
```

## src/lib/changeset/create.ts

Changeset generation:

```typescript
export const createChangesets = (
 changedPackages: ReadonlyArray<ChangedPackage>
): Effect.Effect<ReadonlyArray<ChangesetFile>, ChangesetError> =>
 Effect.gen(function* () {
  const changesets: Array<ChangesetFile> = [];

  if (changedPackages.length === 0) {
   // Only root/config changed - create empty changeset
   const emptyChangeset = yield* createEmptyChangeset();
   changesets.push(emptyChangeset);
  } else {
   // Create changeset for each changed package
   for (const pkg of changedPackages) {
    const changeset = yield* createPackageChangeset(pkg);
    changesets.push(changeset);
   }
  }

  // Write changeset files to .changeset/
  yield* Effect.all(changesets.map((cs) => writeChangesetFile(cs)));

  return changesets;
 });

const createPackageChangeset = (pkg: ChangedPackage): Effect.Effect<ChangesetFile, ChangesetError> =>
 Effect.gen(function* () {
  const depList = pkg.dependencies
   .map((dep) => `  - ${dep.dependency}: ${dep.from || "new"} → ${dep.to}`)
   .join("\n");

  const summary = `Update dependencies in ${pkg.name}:\n\n${depList}`;

  return {
   packages: [pkg.name],
   type: "patch" as const,
   summary
  };
 });
```
