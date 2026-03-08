# Library Modules (src/lib/)

[Back to index](./_index.md)

## src/lib/github/branch.ts

Branch management and commit utilities using library services (`GitBranch`, `GitCommit`,
`CommandRunner`) from `@savvy-web/github-action-effects`.

**Branch Strategy:** Delete-and-recreate instead of rebase. When the branch already
exists, it is deleted and recreated from the default branch for a fresh start. This
avoids rebase complexity and conflict resolution.

```typescript
export const manageBranch = (
 branchName: string,
 defaultBranch: string = "main",
): Effect.Effect<BranchResult, GitBranchError | CommandRunnerError, GitBranch | CommandRunner> =>
 Effect.gen(function* () {
  const branch = yield* GitBranch;
  const cmd = yield* CommandRunner;

  const exists = yield* branch.exists(branchName);

  if (!exists) {
   const baseSha = yield* branch.getSha(defaultBranch);
   yield* branch.create(branchName, baseSha);
   yield* cmd.exec("git", ["fetch", "origin"]);
   yield* cmd.exec("git", ["checkout", "-B", branchName, `origin/${branchName}`]);
   return { branch: branchName, created: true, upToDate: true, baseRef: defaultBranch };
  }

  // Branch exists - delete and recreate from default branch
  const baseSha = yield* branch.getSha(defaultBranch);
  yield* branch.delete(branchName).pipe(Effect.catchAll(() => Effect.void));
  yield* branch.create(branchName, baseSha);
  yield* cmd.exec("git", ["fetch", "origin"]);
  yield* cmd.exec("git", ["checkout", "-B", branchName, `origin/${branchName}`]);
  return { branch: branchName, created: false, upToDate: true, baseRef: defaultBranch };
 });
```

**Commit via GitHub API:** The `commitChanges` function uses `GitCommit` service
for verified commits. It reads changed files from `git status --porcelain`, builds
a tree via `GitCommit.createTree()`, creates a commit via `GitCommit.createCommit()`
(without author parameter for verification), and updates the branch ref.

```typescript
export const commitChanges = (
 message: string,
 branchName: string,
): Effect.Effect<void, GitBranchError | GitCommitError | CommandRunnerError, GitBranch | GitCommit | CommandRunner>
```

## src/lib/pnpm/format.ts

**Purpose:** Format `pnpm-workspace.yaml` consistently to avoid lint-staged hook changes.

**Formatting Rules:**

1. **Sort arrays alphabetically:** `packages`, `onlyBuiltDependencies`, `publicHoistPattern`
2. **Sort `configDependencies` object keys alphabetically**
3. **Sort top-level keys alphabetically**, but keep `packages` first
4. **YAML stringify options:**
   - `indent: 2` - Two-space indentation
   - `lineWidth: 0` - Disable line wrapping
   - `singleQuote: false` - Use double quotes

**Exported Functions:**

- `formatWorkspaceYaml(workspaceRoot?)` - Read, sort, and write back the YAML file
- `readWorkspaceYaml(workspaceRoot?)` - Read and parse workspace YAML
- `sortContent(content)` - Sort workspace content (exported for use by `config.ts`)
- `STRINGIFY_OPTIONS` - Consistent YAML stringify options (exported for use by `config.ts`)

## src/lib/pnpm/upgrade.ts

**Purpose:** Upgrade pnpm itself to the latest version within the `^` semver range.

Uses `CommandRunner` for shell execution (replaces the deleted `PnpmExecutor` service).

**Exported Functions:**

- `parsePnpmVersion(raw, stripPnpmPrefix?)` - Parse version from `packageManager` or `devEngines` field
- `formatPnpmVersion(version, hasCaret)` - Format version with optional caret prefix
- `resolveLatestInRange(versions, current)` - Find highest stable version satisfying `^current`
- `upgradePnpm(workspaceRoot?)` - Main upgrade Effect
- `detectIndent(content)` - Detect JSON file indentation (reused by `regular.ts`)

**Effect Signature:**

```typescript
export const upgradePnpm = (
 workspaceRoot?: string
): Effect.Effect<PnpmUpgradeResult | null, FileSystemError, CommandRunner>
```

**Algorithm:**

1. Read root `package.json`
2. Parse `packageManager` field (format: `pnpm@10.28.2`, `pnpm@^10.28.2+sha512...`)
3. Parse `devEngines.packageManager` field (name must be `pnpm`, version field parsed)
4. If neither field found, return null
5. Query available pnpm versions via `npm view pnpm versions --json` (uses `CommandRunner`)
6. Filter to stable releases only (no pre-release via `semver.prerelease`)
7. Resolve latest version in `^` range via `semver.maxSatisfying`
8. Take highest resolved version across both fields
9. If already up-to-date, return null
10. Run `corepack use pnpm@<version>` via `CommandRunner`
11. Re-read `package.json`, detect indentation, update `devEngines.packageManager.version`
12. Return `PnpmUpgradeResult`

## src/lib/pnpm/config.ts

**Purpose:** Update config dependencies by querying npm directly and editing
`pnpm-workspace.yaml` in place. This avoids `pnpm add --config` which promotes
all workspace dependencies to the default catalog when `catalogMode: strict` is enabled.

Uses `CommandRunner` for npm queries (replaces the deleted `PnpmExecutor` service).

**Exported Functions:**

- `parseConfigEntry(entry)` - Parse config dependency entry (version + optional hash)
- `updateConfigDeps(deps, workspaceRoot?)` - Main update Effect

**Effect Signature:**

```typescript
export const updateConfigDeps = (
 deps: ReadonlyArray<string>,
 workspaceRoot?: string,
): Effect.Effect<ReadonlyArray<DependencyUpdateResult>, never, CommandRunner>
```

**Algorithm:**

1. Read `pnpm-workspace.yaml` via `readWorkspaceYaml()`
2. For each config dependency, parse current entry to extract version
3. Query `npm view <pkg>@latest version dist.integrity --json` via `CommandRunner`
4. Compare current version with latest; skip if already up-to-date
5. Construct new entry: `version+integrity`
6. Write back via `sortContent()` + `stringify()` for consistent formatting
7. Return `DependencyUpdateResult[]`

## src/lib/pnpm/regular.ts

**Purpose:** Update regular (non-config) dependencies by querying npm directly.
Avoids `pnpm up --latest` which promotes deps to catalogs when `catalogMode: strict`.

Uses `CommandRunner` for npm queries (replaces the deleted `PnpmExecutor` service).

**Exported Functions:**

- `matchesPattern(depName, pattern)` - Glob matching via Node's native `path.matchesGlob`
- `parseSpecifier(specifier)` - Parse version specifier into `{ prefix, version }`,
  returns `null` for `catalog:` and `workspace:` specifiers
- `updateRegularDeps(patterns, workspaceRoot?)` - Main Effect function

**Effect Signature:**

```typescript
export const updateRegularDeps = (
 patterns: ReadonlyArray<string>,
 workspaceRoot?: string,
): Effect.Effect<ReadonlyArray<DependencyUpdateResult>, never, CommandRunner>
```

**Key Design Decisions:**

- Queries npm registry directly instead of relying on `pnpm up` to avoid catalog promotion
- Uses Node's native `path.matchesGlob` for pattern matching
- Preserves specifier prefix (`^`, `~`, or exact) from existing `package.json`
- Skips `catalog:` and `workspace:` specifiers entirely
- Deduplicates per path+dep to avoid duplicate PR table rows
- Gracefully handles npm query failures per-dependency (logs warning, continues)
- Reuses `detectIndent` from `upgrade.ts` for consistent `package.json` formatting

## src/lib/lockfile/compare.ts

**Purpose:** Compare lockfile snapshots before and after updates to detect changes.

Uses pnpm's official packages (`@pnpm/lockfile.fs`, `@pnpm/lockfile.types`) and
`workspace-tools` for workspace info.

**Exported Functions:**

- `captureLockfileState(workspaceRoot?)` - Read current `pnpm-lock.yaml` snapshot
- `compareLockfiles(before, after, workspaceRoot?)` - Compare two snapshots for changes

Returns `ReadonlyArray<LockfileChange>` with catalog and specifier changes.

## src/lib/changeset/create.ts

**Purpose:** Create changeset files for affected packages after dependency updates.

**Exported Functions:**

- `createChangesets(changes)` - Create changeset files from lockfile changes

Creates patch changesets for each affected workspace package. Config dependency
changes create an empty changeset for the root workspace.
