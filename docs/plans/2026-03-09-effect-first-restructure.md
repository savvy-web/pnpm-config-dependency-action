# Effect-First src/ Restructure Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restructure `src/` from flat `lib/` layout with function modules into Effect-first architecture with `Context.Tag` services, dedicated layers, and clear separation of schemas, errors, services, layers, and utilities.

**Architecture:** Each domain concern becomes a service with `Context.Tag` + `Live` layer. Pure helpers move to `src/utils/`. Layer composition moves to `src/layers/app.ts`. `main.ts` stays as orchestrator but shrinks to ~200 lines of service calls. No barrel re-exports.

**Tech Stack:** Effect-TS (Context.Tag, Layer, Schema, TaggedError), @savvy-web/github-action-effects v0.5.0, Vitest, Biome

---

## Conventions

* Tabs for indentation (Biome enforced)
* `.js` extensions for relative imports (ESM)
* `node:` protocol for Node.js built-ins
* Separate type imports: `import type { Foo } from './bar.js'`
* No barrel `index.ts` files -- direct imports everywhere
* Tests co-located with source: `foo.ts` and `foo.test.ts` side by side
* Commit messages: conventional commits with DCO signoff

## Task 0: Move schemas and errors to new locations

**Files:**

* Create: `src/schemas/domain.ts`
* Create: `src/schemas/domain.test.ts`
* Create: `src/errors/errors.ts`
* Create: `src/errors/errors.test.ts`
* Delete: `src/lib/schemas/index.ts`
* Delete: `src/lib/schemas/index.test.ts`
* Delete: `src/lib/schemas/errors.ts`
* Delete: `src/lib/schemas/errors.test.ts`
* Delete: `src/lib/errors/types.ts`
* Delete: `src/types/index.ts`
* Modify: All files that import from the old locations

### Step 1: Create `src/schemas/domain.ts`

Copy `src/lib/schemas/index.ts` content to `src/schemas/domain.ts`. Keep everything identical -- same schemas, same type exports.

### Step 2: Create `src/schemas/domain.test.ts`

Copy `src/lib/schemas/index.test.ts` to `src/schemas/domain.test.ts`. Update the import path from `./index.js` to `./domain.js`.

### Step 3: Create `src/errors/errors.ts`

Copy `src/lib/schemas/errors.ts` to `src/errors/errors.ts`. Update the import to reference the new schema location:

```typescript
// Before
import { DependencyUpdateResult, FileSystemOperation, GitOperation, LockfileOperation, NonEmptyString } from "./index.js";

// After
import { DependencyUpdateResult, FileSystemOperation, GitOperation, LockfileOperation, NonEmptyString } from "../schemas/domain.js";
```

### Step 4: Create `src/errors/errors.test.ts`

Copy `src/lib/schemas/errors.test.ts` to `src/errors/errors.test.ts`. Update the import path from `./errors.js` to `./errors.js` (same filename, but now in the new directory). Check the test file for any imports from the old schemas location and update those too.

### Step 5: Update all consumers

Every file that imports from the old locations needs updating. Use these replacements:

| Old import | New import |
| --- | --- |
| `from "../../types/index.js"` | `from "../../schemas/domain.js"` (adjust depth) |
| `from "../types/index.js"` | `from "../schemas/domain.js"` (adjust depth) |
| `from "./types/index.js"` | `from "./schemas/domain.js"` |
| `from "../errors/types.js"` | `from "../errors/errors.js"` (adjust depth) |
| `from "../schemas/errors.js"` | `from "../errors/errors.js"` (adjust depth) |
| `from "./lib/schemas/index.js"` | `from "./schemas/domain.js"` |
| `from "../lib/schemas/index.js"` | `from "../schemas/domain.js"` |

Files to update (check each for old import paths):

* `src/main.ts`
* `src/main.effect.test.ts`
* `src/main.test.ts`
* `src/lib/github/branch.ts`
* `src/lib/github/branch.test.ts`
* `src/lib/pnpm/config.ts`
* `src/lib/pnpm/config.test.ts`
* `src/lib/pnpm/regular.ts`
* `src/lib/pnpm/regular.test.ts`
* `src/lib/pnpm/upgrade.ts`
* `src/lib/pnpm/upgrade.test.ts`
* `src/lib/pnpm/format.ts`
* `src/lib/pnpm/format.test.ts`
* `src/lib/lockfile/compare.ts`
* `src/lib/lockfile/compare.test.ts`
* `src/lib/changeset/create.ts`
* `src/lib/changeset/create.test.ts`
* `src/lib/__test__/fixtures.ts`

### Step 6: Delete old files

Delete:

* `src/lib/schemas/index.ts`
* `src/lib/schemas/index.test.ts`
* `src/lib/schemas/errors.ts`
* `src/lib/schemas/errors.test.ts`
* `src/lib/errors/types.ts`
* `src/types/index.ts`

### Step 7: Run tests and commit

Run: `pnpm vitest run`

Expected: All 231 tests pass.

Run: `pnpm run typecheck`

Expected: Clean.

```bash
git add -A && git commit -m "refactor: move schemas and errors to src/schemas/ and src/errors/

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>"
```

## Task 1: Extract pure helpers to src/utils

**Files:**

* Create: `src/utils/pnpm.ts`
* Create: `src/utils/semver.ts`
* Create: `src/utils/markdown.ts`
* Create: `src/utils/deps.ts`
* Create: `src/utils/fixtures.test.ts`
* Delete: `src/lib/__test__/fixtures.ts`
* Modify: Files that use these helpers

### Step 1: Create `src/utils/pnpm.ts`

Extract from `src/lib/pnpm/upgrade.ts`:

```typescript
/**
 * pnpm version parsing and formatting utilities.
 *
 * @module utils/pnpm
 */

/**
 * Parsed pnpm version info.
 */
export interface ParsedPnpmVersion {
 readonly version: string;
 readonly hasCaret: boolean;
 readonly hasSha: boolean;
}

/**
 * Parse a pnpm version string from `packageManager` or `devEngines.packageManager.version`.
 *
 * Handles formats:
 * - `pnpm@10.28.2` (packageManager field, exact)
 * - `pnpm@10.28.2+sha512...` (packageManager field, with integrity hash)
 * - `pnpm@^10.28.2` (packageManager field, with caret)
 * - `10.28.2` (devEngines version field, exact)
 * - `^10.28.2` (devEngines version field, with caret)
 */
export const parsePnpmVersion = (raw: string, stripPnpmPrefix = false): ParsedPnpmVersion | null => {
 if (!raw) return null;

 let value = raw.trim();

 if (stripPnpmPrefix) {
  if (!value.startsWith("pnpm@")) return null;
  value = value.slice(5);
 }

 const hasSha = value.includes("+");
 if (hasSha) {
  value = value.split("+")[0];
 }

 const hasCaret = value.startsWith("^");
 if (hasCaret) {
  value = value.slice(1);
 }

 if (!/^\d+\.\d+\.\d+/.test(value)) return null;

 return { version: value, hasCaret, hasSha };
};

/**
 * Format a pnpm version with optional caret prefix.
 */
export const formatPnpmVersion = (version: string, hasCaret: boolean): string => {
 return hasCaret ? `^${version}` : version;
};

/**
 * Detect indentation used in a JSON file (tab or N spaces).
 */
export const detectIndent = (content: string): string | number => {
 const match = content.match(/^(\s+)"/m);
 if (match) {
  const indent = match[1];
  if (indent.includes("\t")) return "\t";
  return indent.length;
 }
 return "\t";
};
```

### Step 2: Create `src/utils/semver.ts`

Extract from `src/lib/pnpm/upgrade.ts`:

```typescript
/**
 * Semver resolution utilities using SemverResolver from the library.
 *
 * @module utils/semver
 */

import { SemverResolver } from "@savvy-web/github-action-effects";
import { Effect } from "effect";

/**
 * Resolve the latest version within a `^` range from available versions.
 *
 * Filters out pre-release versions before resolving.
 */
export const resolveLatestInRange = (
 versions: ReadonlyArray<string>,
 current: string,
): Effect.Effect<string | null, never, never> =>
 Effect.gen(function* () {
  const stableVersions: string[] = [];
  for (const v of versions) {
   const parsed = yield* SemverResolver.parse(v).pipe(Effect.option);
   if (parsed._tag === "Some" && !parsed.value.prerelease) {
    stableVersions.push(v);
   }
  }

  if (stableVersions.length === 0) return null;

  const result = yield* SemverResolver.latestInRange(stableVersions, `^${current}`).pipe(
   Effect.catchAll(() => Effect.succeed(null as string | null)),
  );
  return result;
 });
```

### Step 3: Create `src/utils/markdown.ts`

Extract from `src/main.ts`:

```typescript
/**
 * Markdown and URL formatting utilities.
 *
 * @module utils/markdown
 */

/**
 * Generate npm package URL.
 */
export const npmUrl = (pkg: string): string => `https://www.npmjs.com/package/${pkg}`;

/**
 * Extract clean version from pnpm version string (removes hash suffix).
 */
export const cleanVersion = (version: string | null): string | null => {
 if (!version) return null;
 return version.split("+")[0];
};
```

### Step 4: Create `src/utils/deps.ts`

Extract from `src/lib/pnpm/config.ts` and `src/lib/pnpm/regular.ts`:

```typescript
/**
 * Dependency parsing and matching utilities.
 *
 * @module utils/deps
 */

import { matchesGlob } from "node:path";

/**
 * Check if a dependency name matches a glob pattern.
 *
 * Uses Node's native `path.matchesGlob` for safe pattern matching.
 */
export const matchesPattern = (depName: string, pattern: string): boolean => {
 return matchesGlob(depName, pattern);
};

/**
 * Parse a version specifier into prefix and version.
 *
 * Returns null for catalog: and workspace: specifiers (should be skipped).
 */
export const parseSpecifier = (specifier: string): { prefix: string; version: string } | null => {
 if (specifier.startsWith("catalog:")) return null;
 if (specifier.startsWith("workspace:")) return null;

 const match = specifier.match(/^(\^|~)?(\d+\.\d+\.\d+.*)$/);
 if (!match) return null;

 return {
  prefix: match[1] ?? "",
  version: match[2],
 };
};

/**
 * Parse a config dependency entry from pnpm-workspace.yaml.
 *
 * Config dependency entries have the format `version+sha512-base64hash`
 * or just `version` (no hash).
 */
export const parseConfigEntry = (entry: string): { version: string; hash: string | null } | null => {
 if (!entry || entry.trim().length === 0) return null;

 const shaIndex = entry.indexOf("+sha");
 if (shaIndex === -1) {
  return { version: entry, hash: null };
 }

 return {
  version: entry.substring(0, shaIndex),
  hash: entry.substring(shaIndex + 1),
 };
};
```

### Step 5: Move test fixtures

Copy `src/lib/__test__/fixtures.ts` to `src/utils/fixtures.test.ts`. Update imports:

```typescript
// Before
import type { ChangesetFile, DependencyUpdateResult, LockfileChange, PullRequestResult } from "../../types/index.js";

// After
import type { ChangesetFile, DependencyUpdateResult, LockfileChange, PullRequestResult } from "../schemas/domain.js";
```

### Step 6: Update all consumers

Update imports in every file that used the extracted helpers:

* `src/lib/pnpm/upgrade.ts` -- Remove `parsePnpmVersion`, `formatPnpmVersion`, `detectIndent`, `resolveLatestInRange` definitions. Import from `../../utils/pnpm.js` and `../../utils/semver.js`. Keep `PnpmUpgradeResult` interface and `upgradePnpm` function.
* `src/lib/pnpm/config.ts` -- Remove `parseConfigEntry` definition. Import from `../../utils/deps.js`.
* `src/lib/pnpm/regular.ts` -- Remove `matchesPattern`, `parseSpecifier` definitions. Import from `../../utils/deps.js`. Change `detectIndent` import from `./upgrade.js` to `../../utils/pnpm.js`.
* `src/main.ts` -- Remove `npmUrl`, `cleanVersion` definitions. Import from `./utils/markdown.js`.
* All test files importing from `./lib/__test__/fixtures.js` -- Update to `./utils/fixtures.test.js` or `../utils/fixtures.test.js`.

Delete `src/lib/__test__/fixtures.ts`.

### Step 7: Run tests and commit

Run: `pnpm vitest run`

Expected: All 231 tests pass.

Run: `pnpm run typecheck`

Expected: Clean.

```bash
git add -A && git commit -m "refactor: extract pure helpers to src/utils/

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>"
```

## Task 2: Create WorkspaceYaml, Lockfile, and Changesets services

These three services have no library service dependencies -- they only use filesystem operations and pnpm packages.

**Files:**

* Create: `src/services/workspace-yaml.ts`
* Create: `src/services/workspace-yaml.test.ts`
* Create: `src/services/lockfile.ts`
* Create: `src/services/lockfile.test.ts`
* Create: `src/services/changesets.ts`
* Create: `src/services/changesets.test.ts`
* Delete: `src/lib/pnpm/format.ts`, `src/lib/pnpm/format.test.ts`
* Delete: `src/lib/lockfile/compare.ts`, `src/lib/lockfile/compare.test.ts`
* Delete: `src/lib/changeset/create.ts`, `src/lib/changeset/create.test.ts`

### Step 1: Create `src/services/workspace-yaml.ts`

```typescript
/**
 * WorkspaceYaml service for pnpm-workspace.yaml operations.
 *
 * @module services/workspace-yaml
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Context, Effect, Layer } from "effect";
import { parse, stringify } from "yaml";

import { FileSystemError } from "../errors/errors.js";

// Keep PnpmWorkspaceContent, SORTABLE_ARRAY_KEYS, SORTABLE_MAP_KEYS,
// STRINGIFY_OPTIONS, and sortContent as module-level definitions (unchanged)

export interface WorkspaceYaml {
 readonly format: (workspaceRoot?: string) => Effect.Effect<void, FileSystemError>;
 readonly read: (workspaceRoot?: string) => Effect.Effect<PnpmWorkspaceContent | null, FileSystemError>;
}

export const WorkspaceYaml = Context.GenericTag<WorkspaceYaml>("WorkspaceYaml");

export const WorkspaceYamlLive = Layer.succeed(
 WorkspaceYaml,
 WorkspaceYaml.of({
  format: (workspaceRoot = process.cwd()) => formatWorkspaceYamlImpl(workspaceRoot),
  read: (workspaceRoot = process.cwd()) => readWorkspaceYamlImpl(workspaceRoot),
 }),
);

// Export sortContent and STRINGIFY_OPTIONS for use by ConfigDeps service
export { sortContent, STRINGIFY_OPTIONS };
// Export PnpmWorkspaceContent type
export type { PnpmWorkspaceContent };
```

The `formatWorkspaceYamlImpl` and `readWorkspaceYamlImpl` functions are the existing `formatWorkspaceYaml` and `readWorkspaceYaml` functions renamed. The `sortContent` function stays as-is and is exported for use by the `ConfigDeps` service.

Also export `getConfigDependencyVersion` if it is used elsewhere.

### Step 2: Create `src/services/workspace-yaml.test.ts`

Copy tests from `src/lib/pnpm/format.test.ts`. Tests for `sortContent`, `STRINGIFY_OPTIONS`, and the service methods. For the service methods, use `WorkspaceYamlLive` layer directly since they have no service dependencies -- they are filesystem operations tested with temp dirs.

### Step 3: Create `src/services/lockfile.ts`

```typescript
/**
 * Lockfile service for lockfile comparison operations.
 *
 * @module services/lockfile
 */

import { Context, Effect, Layer } from "effect";
import type { LockfileObject } from "@pnpm/lockfile.types";

import type { LockfileChange } from "../schemas/domain.js";
import { LockfileError } from "../errors/errors.js";

export interface Lockfile {
 readonly capture: (workspaceRoot?: string) => Effect.Effect<LockfileObject | null, LockfileError>;
 readonly compare: (
  before: LockfileObject | null,
  after: LockfileObject | null,
  workspaceRoot?: string,
 ) => Effect.Effect<ReadonlyArray<LockfileChange>, LockfileError>;
}

export const Lockfile = Context.GenericTag<Lockfile>("Lockfile");

export const LockfileLive = Layer.succeed(
 Lockfile,
 Lockfile.of({
  capture: (workspaceRoot = process.cwd()) => captureLockfileStateImpl(workspaceRoot),
  compare: (before, after, workspaceRoot = process.cwd()) => compareLockfilesImpl(before, after, workspaceRoot),
 }),
);

// Export groupChangesByPackage for use by Changesets service
export { groupChangesByPackage };
```

Implementation functions are the existing `captureLockfileState` and `compareLockfiles` renamed.

### Step 4: Create `src/services/lockfile.test.ts`

Copy tests from `src/lib/lockfile/compare.test.ts`. Update imports. Tests use `LockfileLive` directly or test pure functions.

### Step 5: Create `src/services/changesets.ts`

```typescript
/**
 * Changesets service for creating changeset files.
 *
 * @module services/changesets
 */

import { Context, Effect, Layer } from "effect";

import type { ChangesetFile, LockfileChange } from "../schemas/domain.js";
import type { ChangesetError } from "../errors/errors.js";
import { FileSystemError } from "../errors/errors.js";

export interface Changesets {
 readonly create: (
  changes: ReadonlyArray<LockfileChange>,
  workspaceRoot?: string,
 ) => Effect.Effect<ReadonlyArray<ChangesetFile>, ChangesetError | FileSystemError>;
}

export const Changesets = Context.GenericTag<Changesets>("Changesets");

export const ChangesetsLive = Layer.succeed(
 Changesets,
 Changesets.of({
  create: (changes, workspaceRoot = process.cwd()) => createChangesetsImpl(changes, workspaceRoot),
 }),
);

// Export hasChangesets, formatChangesetSummary, analyzeAffectedPackages as utilities
export { hasChangesets, formatChangesetSummary, analyzeAffectedPackages };
```

### Step 6: Create `src/services/changesets.test.ts`

Copy tests from `src/lib/changeset/create.test.ts`. Update imports. The `groupChangesByPackage` import changes from `../lockfile/compare.js` to `./lockfile.js`.

### Step 7: Delete old files

Delete:

* `src/lib/pnpm/format.ts`, `src/lib/pnpm/format.test.ts`
* `src/lib/lockfile/compare.ts`, `src/lib/lockfile/compare.test.ts`
* `src/lib/changeset/create.ts`, `src/lib/changeset/create.test.ts`

### Step 8: Update consumers

Update all imports that referenced the old module paths. Key consumers:

* `src/lib/pnpm/config.ts` -- `readWorkspaceYaml`, `sortContent`, `STRINGIFY_OPTIONS` now from `../services/workspace-yaml.js`
* `src/main.ts` -- `formatWorkspaceYaml`, `readWorkspaceYaml` now from service; `captureLockfileState`, `compareLockfiles` now from service; `createChangesets` now from service

### Step 9: Run tests and commit

Run: `pnpm vitest run`

Expected: All tests pass.

```bash
git add -A && git commit -m "refactor: create WorkspaceYaml, Lockfile, and Changesets services

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>"
```

## Task 3: Create PnpmUpgrade service

**Files:**

* Create: `src/services/pnpm-upgrade.ts`
* Create: `src/services/pnpm-upgrade.test.ts`
* Delete: `src/lib/pnpm/upgrade.ts`, `src/lib/pnpm/upgrade.test.ts`

### Step 1: Create `src/services/pnpm-upgrade.ts`

```typescript
/**
 * PnpmUpgrade service for pnpm self-upgrade operations.
 *
 * @module services/pnpm-upgrade
 */

import { readFileSync, writeFileSync } from "node:fs";
import { CommandRunner, SemverResolver } from "@savvy-web/github-action-effects";
import { Context, Effect, Layer } from "effect";

import { FileSystemError } from "../errors/errors.js";
import { detectIndent, formatPnpmVersion, parsePnpmVersion } from "../utils/pnpm.js";
import { resolveLatestInRange } from "../utils/semver.js";

export interface PnpmUpgradeResult {
 readonly from: string;
 readonly to: string;
 readonly packageManagerUpdated: boolean;
 readonly devEnginesUpdated: boolean;
}

export interface PnpmUpgrade {
 readonly upgrade: (workspaceRoot?: string) => Effect.Effect<PnpmUpgradeResult | null, FileSystemError>;
}

export const PnpmUpgrade = Context.GenericTag<PnpmUpgrade>("PnpmUpgrade");

export const PnpmUpgradeLive = Layer.effect(
 PnpmUpgrade,
 Effect.gen(function* () {
  const runner = yield* CommandRunner;
  return PnpmUpgrade.of({
   upgrade: (workspaceRoot = process.cwd()) => upgradePnpmImpl(runner, workspaceRoot),
  });
 }),
);
```

The `upgradePnpmImpl` function is the existing `upgradePnpm` function, modified to accept a `runner: CommandRunner` parameter instead of `yield* CommandRunner` internally.

### Step 2: Create `src/services/pnpm-upgrade.test.ts`

Copy tests from `src/lib/pnpm/upgrade.test.ts`. Remove tests for `parsePnpmVersion`, `formatPnpmVersion`, `resolveLatestInRange`, `detectIndent` -- those should move to util test files if they exist, or can stay as-is if the test file already tests them via import. Update the `upgradePnpm` effect tests to use `PnpmUpgradeLive` layer with mock `CommandRunner`.

### Step 3: Delete old files, update consumers, run tests, commit

Delete `src/lib/pnpm/upgrade.ts` and `src/lib/pnpm/upgrade.test.ts`.

Update `src/main.ts` to import `PnpmUpgrade` service instead of `upgradePnpm` function.

Run: `pnpm vitest run`

```bash
git add -A && git commit -m "refactor: create PnpmUpgrade service

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>"
```

## Task 4: Create ConfigDeps and RegularDeps services

**Files:**

* Create: `src/services/config-deps.ts`
* Create: `src/services/config-deps.test.ts`
* Create: `src/services/regular-deps.ts`
* Create: `src/services/regular-deps.test.ts`
* Delete: `src/lib/pnpm/config.ts`, `src/lib/pnpm/config.test.ts`
* Delete: `src/lib/pnpm/regular.ts`, `src/lib/pnpm/regular.test.ts`

### Step 1: Create `src/services/config-deps.ts`

```typescript
/**
 * ConfigDeps service for config dependency updates.
 *
 * @module services/config-deps
 */

import { existsSync, writeFileSync } from "node:fs";
import type { NpmRegistry } from "@savvy-web/github-action-effects";
import { NpmRegistry as NpmRegistryTag } from "@savvy-web/github-action-effects";
import { Context, Effect, Layer } from "effect";
import { stringify } from "yaml";

import type { DependencyUpdateResult } from "../schemas/domain.js";
import { FileSystemError } from "../errors/errors.js";
import { STRINGIFY_OPTIONS, sortContent } from "../services/workspace-yaml.js";
import { parseConfigEntry } from "../utils/deps.js";

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
  const registry = yield* NpmRegistryTag;
  const workspace = yield* WorkspaceYaml;
  return ConfigDeps.of({
   updateConfigDeps: (deps, workspaceRoot = process.cwd()) =>
    updateConfigDepsImpl(deps, registry, workspace, workspaceRoot),
  });
 }),
);
```

The `updateConfigDepsImpl` function is the existing `updateConfigDeps`, modified to accept a `registry: NpmRegistry` and `workspace: WorkspaceYaml` parameter. It uses `workspace.read()` instead of calling `readWorkspaceYaml` directly.

### Step 2: Create `src/services/config-deps.test.ts`

Copy tests from `src/lib/pnpm/config.test.ts`. Remove `parseConfigEntry` tests (moved to utils). Update to use `ConfigDepsLive` with mock `NpmRegistry` and `WorkspaceYaml` layers.

### Step 3: Create `src/services/regular-deps.ts`

Same pattern as ConfigDeps, wrapping `updateRegularDeps`. Service depends on `NpmRegistry`.

```typescript
export interface RegularDeps {
 readonly updateRegularDeps: (
  patterns: ReadonlyArray<string>,
  workspaceRoot?: string,
 ) => Effect.Effect<ReadonlyArray<DependencyUpdateResult>>;
}

export const RegularDeps = Context.GenericTag<RegularDeps>("RegularDeps");

export const RegularDepsLive = Layer.effect(
 RegularDeps,
 Effect.gen(function* () {
  const registry = yield* NpmRegistryTag;
  return RegularDeps.of({
   updateRegularDeps: (patterns, workspaceRoot = process.cwd()) =>
    updateRegularDepsImpl(patterns, registry, workspaceRoot),
  });
 }),
);
```

### Step 4: Create `src/services/regular-deps.test.ts`

Copy tests from `src/lib/pnpm/regular.test.ts`. Remove `matchesPattern` and `parseSpecifier` tests (moved to utils). Update to use `RegularDepsLive` with mock `NpmRegistry`.

### Step 5: Delete old files, update consumers, run tests, commit

Delete `src/lib/pnpm/config.ts`, `src/lib/pnpm/config.test.ts`, `src/lib/pnpm/regular.ts`, `src/lib/pnpm/regular.test.ts`.

Update `src/main.ts` to import `ConfigDeps` and `RegularDeps` services.

Run: `pnpm vitest run`

```bash
git add -A && git commit -m "refactor: create ConfigDeps and RegularDeps services

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>"
```

## Task 5: Create BranchManager service

**Files:**

* Create: `src/services/branch.ts`
* Create: `src/services/branch.test.ts`
* Delete: `src/lib/github/branch.ts`, `src/lib/github/branch.test.ts`

### Step 1: Create `src/services/branch.ts`

```typescript
/**
 * BranchManager service for branch management and commit operations.
 *
 * @module services/branch
 */

import { readFileSync } from "node:fs";
import type { CommandRunnerError, FileChange, GitBranchError, GitCommitError } from "@savvy-web/github-action-effects";
import { CommandRunner, GitBranch, GitCommit } from "@savvy-web/github-action-effects";
import { Context, Effect, Layer } from "effect";

import type { BranchResult } from "../schemas/domain.js";

export interface BranchManager {
 readonly manage: (
  branchName: string,
  defaultBranch?: string,
 ) => Effect.Effect<BranchResult, GitBranchError | CommandRunnerError>;
 readonly commitChanges: (
  message: string,
  branchName: string,
 ) => Effect.Effect<void, GitCommitError | CommandRunnerError>;
}

export const BranchManager = Context.GenericTag<BranchManager>("BranchManager");

export const BranchManagerLive = Layer.effect(
 BranchManager,
 Effect.gen(function* () {
  const branch = yield* GitBranch;
  const commit = yield* GitCommit;
  const cmd = yield* CommandRunner;
  return BranchManager.of({
   manage: (branchName, defaultBranch = "main") =>
    manageBranchImpl(branch, cmd, branchName, defaultBranch),
   commitChanges: (message, branchName) =>
    commitChangesImpl(commit, cmd, message, branchName),
  });
 }),
);
```

Implementation functions are the existing `manageBranch` and `commitChanges` modified to accept service instances as parameters.

### Step 2: Create `src/services/branch.test.ts`

Copy tests from `src/lib/github/branch.test.ts`. Update to use `BranchManagerLive` with mock `GitBranch`, `GitCommit`, `CommandRunner` layers.

### Step 3: Delete old files, update consumers, run tests, commit

Delete `src/lib/github/branch.ts` and `src/lib/github/branch.test.ts`.

Update `src/main.ts` to import `BranchManager` service.

Run: `pnpm vitest run`

```bash
git add -A && git commit -m "refactor: create BranchManager service

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>"
```

## Task 6: Create Report service with PR sentinel fix

**Files:**

* Create: `src/services/report.ts`
* Create: `src/services/report.test.ts`
* Modify: `src/main.ts` (remove report functions, import Report service)
* Modify: `src/main.effect.test.ts` (update to use Report service mocks)

### Step 1: Create `src/services/report.ts`

```typescript
/**
 * Report service for PR management and summary generation.
 *
 * @module services/report
 */

import type { PullRequestError } from "@savvy-web/github-action-effects";
import { GithubMarkdown, PullRequest as PullRequestTag } from "@savvy-web/github-action-effects";
import { Context, Effect, Layer } from "effect";

import type { ChangesetFile, DependencyUpdateResult, PullRequestResult } from "../schemas/domain.js";
import { cleanVersion, npmUrl } from "../utils/markdown.js";

export interface Report {
 readonly createOrUpdatePR: (
  branch: string,
  updates: ReadonlyArray<DependencyUpdateResult>,
  changesets: ReadonlyArray<ChangesetFile>,
  autoMerge?: "merge" | "squash" | "rebase",
 ) => Effect.Effect<PullRequestResult, PullRequestError>;
 readonly generatePRBody: (
  updates: ReadonlyArray<DependencyUpdateResult>,
  changesets: ReadonlyArray<ChangesetFile>,
 ) => string;
 readonly generateSummary: (
  updates: ReadonlyArray<DependencyUpdateResult>,
  changesets: ReadonlyArray<ChangesetFile>,
  pr: PullRequestResult | null,
  dryRun: boolean,
 ) => string;
 readonly generateCommitMessage: (
  updates: ReadonlyArray<DependencyUpdateResult>,
  appSlug?: string,
 ) => string;
}

export const Report = Context.GenericTag<Report>("Report");

export const ReportLive = Layer.effect(
 Report,
 Effect.gen(function* () {
  const pullRequest = yield* PullRequestTag;
  return Report.of({
   createOrUpdatePR: (branch, updates, changesets, autoMerge) =>
    createOrUpdatePRImpl(pullRequest, branch, updates, changesets, autoMerge),
   generatePRBody: generatePRBodyImpl,
   generateSummary: generateSummaryImpl,
   generateCommitMessage: generateCommitMessageImpl,
  });
 }),
);
```

**PR sentinel fix:** The `createOrUpdatePRImpl` function now returns `Effect<PullRequestResult, PullRequestError>` instead of catching all errors and returning `{ number: 0, url: "" }`. On success, it maps `PullRequestInfo & { created }` to `PullRequestResult`. On failure, the `PullRequestError` propagates through the error channel.

```typescript
const createOrUpdatePRImpl = (
 pr: PullRequest,
 branch: string,
 updates: ReadonlyArray<DependencyUpdateResult>,
 changesets: ReadonlyArray<ChangesetFile>,
 autoMerge?: "merge" | "squash" | "rebase",
): Effect.Effect<PullRequestResult, PullRequestError> =>
 Effect.gen(function* () {
  const title = "chore(deps): update pnpm config dependencies";
  const body = generatePRBodyImpl(updates, changesets);

  const result = yield* pr.getOrCreate({
   head: branch,
   base: "main",
   title,
   body,
   autoMerge: autoMerge || false,
  });

  const action = result.created ? "Created" : "Updated";
  yield* Effect.logInfo(`${action} PR #${result.number}: ${result.url}`);

  return {
   number: result.number,
   url: result.url,
   created: result.created,
   nodeId: result.nodeId,
  };
 });
```

The `main.ts` orchestrator handles the error:

```typescript
const report = yield* Report;
const pr = yield* report
 .createOrUpdatePR(inputs.branch, allUpdates, changesets, inputs["auto-merge"] || undefined)
 .pipe(
  Effect.catchAll((error) =>
   Effect.gen(function* () {
    yield* Effect.logWarning(`PR creation failed: ${error.reason}`);
    return null;
   }),
  ),
 );
```

### Step 2: Create `src/services/report.test.ts`

Move `createOrUpdatePR` tests from `src/main.effect.test.ts` and `generatePRBody` tests. Use `ReportLive` with `PullRequestTest` layer. Add a test for the error case (PR creation failure returns `PullRequestError` instead of sentinel).

### Step 3: Update `src/main.ts`

Remove `createOrUpdatePR`, `generatePRBody`, `generateSummary`, `generateCommitMessage`, `npmUrl`, `cleanVersion`, and `RunCommandsResult` interface from `main.ts`. Import `Report` service. Update orchestration to use `report.createOrUpdatePR(...)` with `Effect.catchAll` for the null case.

Keep `runCommands` in `main.ts` since it is orchestration logic.

### Step 4: Update `src/main.effect.test.ts`

Remove `createOrUpdatePR` and `generatePRBody` tests (moved to `report.test.ts`). Only `runCommands` tests remain.

### Step 5: Run tests and commit

Run: `pnpm vitest run`

```bash
git add -A && git commit -m "refactor: create Report service with PR error channel fix

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>"
```

## Task 7: Create layers/app.ts and update main.ts

**Files:**

* Create: `src/layers/app.ts`
* Modify: `src/main.ts` (use makeAppLayer, use all services via DI)
* Delete: remaining empty `src/lib/` directories

### Step 1: Create `src/layers/app.ts`

```typescript
/**
 * Application layer composition.
 *
 * Wires library layers and domain service layers together.
 *
 * @module layers/app
 */

import {
 CheckRunLive,
 CommandRunnerLive,
 DryRunLive,
 GitBranchLive,
 GitCommitLive,
 GitHubClientLive,
 GitHubGraphQLLive,
 NpmRegistryLive,
 PullRequestLive,
} from "@savvy-web/github-action-effects";
import { Layer } from "effect";

import { BranchManagerLive } from "../services/branch.js";
import { ChangesetsLive } from "../services/changesets.js";
import { ConfigDepsLive } from "../services/config-deps.js";
import { LockfileLive } from "../services/lockfile.js";
import { PnpmUpgradeLive } from "../services/pnpm-upgrade.js";
import { RegularDepsLive } from "../services/regular-deps.js";
import { ReportLive } from "../services/report.js";
import { WorkspaceYamlLive } from "../services/workspace-yaml.js";

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

### Step 2: Update `src/main.ts`

Replace inline layer composition with `makeAppLayer`:

```typescript
import { makeAppLayer } from "./layers/app.js";

// In program:
yield* ghApp.withToken(appId, privateKey, (token) =>
 Effect.gen(function* () {
  const appLayer = makeAppLayer(token, dryRun);
  yield* innerProgram(inputs, dryRun).pipe(Effect.provide(appLayer));
 }),
);
```

Update `innerProgram` to use services:

```typescript
// Step 3: Manage branch
const branchManager = yield* BranchManager;
const branchResult = yield* branchManager.manage(inputs.branch, "main");

// Step 4: Capture lockfile state (before)
const lockfile = yield* Lockfile;
const lockfileBefore = yield* lockfile.capture();

// Step 5: Upgrade pnpm
const pnpmUpgrade = yield* PnpmUpgrade;
const pnpmResult = yield* pnpmUpgrade.upgrade();

// Step 6: Update config dependencies
const configDeps = yield* ConfigDeps;
const configUpdates = yield* configDeps.updateConfigDeps(inputs["config-dependencies"]);

// Step 7: Update regular dependencies
const regularDeps = yield* RegularDeps;
const regularUpdates = yield* regularDeps.updateRegularDeps(inputs.dependencies);

// Step 9: Format pnpm-workspace.yaml
const workspaceYaml = yield* WorkspaceYaml;
yield* workspaceYaml.format();

// Step 11: Capture lockfile state (after)
const lockfileAfter = yield* lockfile.capture();
const changes = yield* lockfile.compare(lockfileBefore, lockfileAfter);

// Step 13: Create changesets
const changesetService = yield* Changesets;
changesets = yield* changesetService.create(allChangesForChangeset);

// Step 14: Commit
yield* branchManager.commitChanges(commitMessage, inputs.branch);

// Step 15: Create PR
const report = yield* Report;
pr = yield* report
 .createOrUpdatePR(inputs.branch, allUpdates, changesets, inputs["auto-merge"] || undefined)
 .pipe(Effect.catchAll((error) => Effect.gen(function* () {
  yield* Effect.logWarning(`PR creation failed: ${error.reason}`);
  return null;
 })));
```

Remove library service imports from `main.ts` that are no longer used directly (keep `GitHubApp`, `GitHubAppLive`, `Action`, `ActionOutputs`, `CheckRun`, `CommandRunner` for `runCommands`).

### Step 3: Delete remaining `src/lib/` directories

At this point, `src/lib/` should be empty (all files moved). Delete the directory.

```bash
rm -rf src/lib/
```

### Step 4: Run full test suite and commit

Run: `pnpm vitest run`

Expected: All tests pass.

Run: `pnpm run typecheck`

Expected: Clean.

Run: `pnpm run lint:fix`

Expected: Clean.

```bash
git add -A && git commit -m "refactor: create layers/app.ts and update main.ts to use services

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>"
```

## Task 8: Update design docs and final verification

**Files:**

* Modify: `.claude/design/pnpm-config-dependency-action/*.md` (update file paths and architecture)

### Step 1: Run full verification

```bash
pnpm vitest run
pnpm run typecheck
pnpm run lint
pnpm run build
```

All must pass.

### Step 2: Update design documentation

Update the following design docs to reflect the new structure:

* `_index.md` -- Update navigation table with new file paths
* `02-architecture.md` -- Update module structure tree
* `05-module-library.md` -- Update to reflect services instead of function modules
* `06-effect-patterns.md` -- Update layer composition examples
* `08-testing.md` -- Update test file paths and patterns

### Step 3: Commit

```bash
git add -A && git commit -m "docs: update design docs for Effect-first restructure

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>"
```
