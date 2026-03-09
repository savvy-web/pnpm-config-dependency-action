# v0.5.0 Library Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Replace custom implementations with `@savvy-web/github-action-effects`
v0.5.0 services, removing ~150 lines of boilerplate and 3 direct dependencies.

**Architecture:** Module-by-module migration in dependency order. Each task
produces a working, tested commit. Custom pnpm-specific code stays as-is.

**Tech Stack:** Effect-TS, `@savvy-web/github-action-effects` v0.5.0, Vitest

**Design doc:** `docs/plans/2026-03-09-v050-library-migration-design.md`

---

## Task 0: Bump library and remove unused dependencies

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml` (regenerated)

### Step 1: Update package.json

In `package.json`, make these changes to `dependencies`:

```jsonc
// Change:
"@savvy-web/github-action-effects": "^0.4.0",
// To:
"@savvy-web/github-action-effects": "^0.5.0",

// Remove these three lines:
"@octokit/request": "^10.0.7",
"@octokit/rest": "^22.0.1",
"semver": "^7.7.4",
```

### Step 2: Install

Run: `pnpm install`

Expected: Clean install, no peer dependency warnings for packages we use.

### Step 3: Verify build

Run: `pnpm run typecheck`

Expected: PASS (no type errors yet, we haven't changed imports).

### Step 4: Commit

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(deps): bump github-action-effects to ^0.5.0, remove semver and octokit"
```

---

## Task 1: Replace semver with SemverResolver in upgrade.ts

**Files:**

- Modify: `src/lib/pnpm/upgrade.ts`
- Modify: `src/lib/pnpm/upgrade.test.ts`

**Context:** `upgrade.ts` imports `semver` directly for `valid`, `prerelease`,
`maxSatisfying`, and `gt`. Replace with `SemverResolver` namespace from the
library. `SemverResolver` methods return Effects, so `resolveLatestInRange`
changes from a pure function to an Effect. `parsePnpmVersion` stays pure
(string parsing only) but its `semver.valid` call must change.

### Step 1: Update imports in upgrade.ts

Replace:

```typescript
import * as semver from "semver";
```

With:

```typescript
import { SemverResolver } from "@savvy-web/github-action-effects";
```

### Step 2: Update parsePnpmVersion

The function uses `semver.valid(value)` to validate. Since `parsePnpmVersion`
is a pure sync function, we cannot call `SemverResolver.parse` (which returns
an Effect). Instead, use a simple regex to validate semver format:

```typescript
// Replace: if (!semver.valid(value)) return null;
// With:
if (!/^\d+\.\d+\.\d+/.test(value)) return null;
```

This is sufficient because `parsePnpmVersion` only needs to verify the string
looks like a version, not do full semver validation. The actual semver
operations happen later in `resolveLatestInRange`.

### Step 3: Convert resolveLatestInRange to an Effect

Replace the current pure function:

```typescript
export const resolveLatestInRange = (versions: ReadonlyArray<string>, current: string): string | null => {
 const stableVersions = versions.filter((v) => !semver.prerelease(v));
 const result = semver.maxSatisfying(stableVersions, `^${current}`);
 return result;
};
```

With an Effect-based version:

```typescript
export const resolveLatestInRange = (
 versions: ReadonlyArray<string>,
 current: string,
): Effect.Effect<string | null, never, never> =>
 Effect.gen(function* () {
  // Filter out pre-release versions using SemverResolver.parse
  const stableVersions: string[] = [];
  for (const v of versions) {
   const parsed = yield* SemverResolver.parse(v).pipe(Effect.option);
   if (parsed._tag === "Some" && !parsed.value.prerelease) {
    stableVersions.push(v);
   }
  }

  if (stableVersions.length === 0) return null;

  // Find the highest version satisfying ^current
  const result = yield* SemverResolver.latestInRange(stableVersions, `^${current}`).pipe(
   Effect.catchAll(() => Effect.succeed(null as string | null)),
  );
  return result;
 });
```

### Step 4: Update callers of resolveLatestInRange in upgradePnpm

Since `resolveLatestInRange` now returns an Effect, update the two call sites
in `upgradePnpm`:

```typescript
// Replace:
const pmResolved = packageManagerParsed ? resolveLatestInRange(allVersions, packageManagerParsed.version) : null;
const deResolved = devEnginesParsed ? resolveLatestInRange(allVersions, devEnginesParsed.version) : null;

// With:
const pmResolved = packageManagerParsed
 ? yield* resolveLatestInRange(allVersions, packageManagerParsed.version)
 : null;
const deResolved = devEnginesParsed
 ? yield* resolveLatestInRange(allVersions, devEnginesParsed.version)
 : null;
```

### Step 5: Replace semver.gt calls

Two places use `semver.gt` for comparing versions. Replace with
`SemverResolver.compare`:

```typescript
// Replace (two locations):
resolved = semver.gt(pmResolved, deResolved) ? pmResolved : deResolved;
// With:
const cmp = yield* SemverResolver.compare(pmResolved, deResolved).pipe(
 Effect.catchAll(() => Effect.succeed(0 as -1 | 0 | 1)),
);
resolved = cmp > 0 ? pmResolved : deResolved;
```

Same pattern for the `currentVersion` IIFE (which also uses `semver.gt`).
Convert the IIFE to a yielded Effect:

```typescript
// Replace the currentVersion IIFE:
const currentVersion = (() => {
 const pmVersion = packageManagerParsed?.version;
 const deVersion = devEnginesParsed?.version;
 if (pmVersion && deVersion) {
  return semver.gt(pmVersion, deVersion) ? pmVersion : deVersion;
 }
 return pmVersion ?? deVersion ?? resolved;
})();

// With:
const currentVersion = yield* Effect.gen(function* () {
 const pmVersion = packageManagerParsed?.version;
 const deVersion = devEnginesParsed?.version;
 if (pmVersion && deVersion) {
  const cmp = yield* SemverResolver.compare(pmVersion, deVersion).pipe(
   Effect.catchAll(() => Effect.succeed(0 as -1 | 0 | 1)),
  );
  return cmp > 0 ? pmVersion : deVersion;
 }
 return pmVersion ?? deVersion ?? resolved;
});
```

### Step 6: Update tests

In `upgrade.test.ts`, update the `resolveLatestInRange` tests. They currently
call it as a pure function and check the return value. Now they need to run
Effects:

```typescript
// Replace:
it("returns highest version in range", () => {
 const result = resolveLatestInRange(["10.0.0", "10.1.0", "10.2.0", "11.0.0"], "10.0.0");
 expect(result).toBe("10.2.0");
});

// With:
it("returns highest version in range", async () => {
 const result = await Effect.runPromise(resolveLatestInRange(["10.0.0", "10.1.0", "10.2.0", "11.0.0"], "10.0.0"));
 expect(result).toBe("10.2.0");
});
```

Apply the same async/Effect.runPromise pattern to all `resolveLatestInRange`
tests (there are 4: highest in range, already latest, pre-release filtering,
no match).

The `parsePnpmVersion` and `formatPnpmVersion` tests stay unchanged (still
pure functions).

### Step 7: Run tests

Run: `pnpm vitest run src/lib/pnpm/upgrade.test.ts`

Expected: All tests pass.

### Step 8: Run full suite

Run: `pnpm run test`

Expected: All tests pass. No other module imports from `semver` directly.

### Step 9: Commit

```bash
git add src/lib/pnpm/upgrade.ts src/lib/pnpm/upgrade.test.ts
git commit -m "refactor: replace semver with SemverResolver in upgrade.ts"
```

---

## Task 2: Replace CommandRunner npm queries with NpmRegistry in config.ts

**Files:**

- Modify: `src/lib/pnpm/config.ts`
- Modify: `src/lib/pnpm/config.test.ts`

**Context:** `config.ts` has a `queryConfigVersion` helper that shells out to
`npm view <pkg>@latest version dist.integrity --json` via `CommandRunner` and
manually parses JSON. Replace with `NpmRegistry.getPackageInfo(pkg)` which
returns `{ name, version, distTags, integrity, tarball }`.

### Step 1: Update imports in config.ts

Replace:

```typescript
import { CommandRunner } from "@savvy-web/github-action-effects";
```

With:

```typescript
import { NpmRegistry } from "@savvy-web/github-action-effects";
```

### Step 2: Replace queryConfigVersion

Replace the entire `queryConfigVersion` function (lines 61-90):

```typescript
const queryConfigVersion = (
 packageName: string,
): Effect.Effect<{ version: string; integrity: string } | null, never, NpmRegistry> =>
 Effect.gen(function* () {
  const registry = yield* NpmRegistry;
  const info = yield* registry.getPackageInfo(packageName).pipe(
   Effect.catchAll(() => Effect.succeed(null)),
  );
  if (!info || !info.integrity) return null;
  return { version: info.version, integrity: info.integrity };
 });
```

### Step 3: Update updateConfigDeps signature

Change the service requirement from `CommandRunner` to `NpmRegistry`:

```typescript
// Replace:
): Effect.Effect<ReadonlyArray<DependencyUpdateResult>, never, CommandRunner> =>

// With:
): Effect.Effect<ReadonlyArray<DependencyUpdateResult>, never, NpmRegistry> =>
```

### Step 4: Update tests

In `config.test.ts`, replace the `CommandRunner` mock pattern with
`NpmRegistryTest`. The current tests use `makeRunner()` with a mock
`execCapture` that returns JSON strings. Replace with `NpmRegistryTest`.

First, check how `NpmRegistryTest` works. Based on the library's test layer
pattern, it should be a namespace with `empty()` and `layer()`:

```typescript
import type { NpmRegistry as NpmRegistryService } from "@savvy-web/github-action-effects";
import { NpmRegistry, NpmRegistryTest } from "@savvy-web/github-action-effects";
```

Replace the test helpers:

```typescript
// Remove makeExecCapture, defaultExecCapture, makeRunner, runWithRunner

// New helper:
const makeNpmRegistry = (
 packages: Record<string, { version: string; integrity?: string }>,
): NpmRegistryService => ({
 getLatestVersion: (pkg) =>
  packages[pkg]
   ? Effect.succeed(packages[pkg].version)
   : Effect.fail(new Error(`Not found: ${pkg}`) as any),
 getDistTags: (pkg) =>
  packages[pkg]
   ? Effect.succeed({ latest: packages[pkg].version })
   : Effect.fail(new Error(`Not found: ${pkg}`) as any),
 getPackageInfo: (pkg) =>
  packages[pkg]
   ? Effect.succeed({
     name: pkg,
     version: packages[pkg].version,
     distTags: { latest: packages[pkg].version },
     integrity: packages[pkg].integrity,
     tarball: undefined,
    })
   : Effect.fail(new Error(`Not found: ${pkg}`) as any),
 getVersions: (pkg) =>
  packages[pkg]
   ? Effect.succeed([packages[pkg].version])
   : Effect.fail(new Error(`Not found: ${pkg}`) as any),
});

const runWithRegistry = <A, E>(
 effect: Effect.Effect<A, E, NpmRegistry>,
 packages?: Record<string, { version: string; integrity?: string }>,
) => {
 const layer = Layer.succeed(NpmRegistry, makeNpmRegistry(packages ?? {}));
 return Effect.runPromise(
  effect.pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
 );
};
```

Then update each test to use `runWithRegistry` instead of `runWithRunner`.
For example:

```typescript
// Replace:
it("updates single dep when newer version available", async () => {
 // ...
 const result = await runWithRunner(
  updateConfigDeps(["@savvy-web/silk"], tempDir),
  makeExecCapture((_cmd, args) => {
   const argStr = args?.join(" ") ?? "";
   if (argStr.includes("npm view @savvy-web/silk")) {
    return makeNpmViewResponse("0.7.0", "sha512-newHash==");
   }
   return "ok";
  }),
 );
 // ...
});

// With:
it("updates single dep when newer version available", async () => {
 // ...
 const result = await runWithRegistry(
  updateConfigDeps(["@savvy-web/silk"], tempDir),
  { "@savvy-web/silk": { version: "0.7.0", integrity: "sha512-newHash==" } },
 );
 // ...
});
```

Update all tests similarly. The `makeNpmViewResponse` helper and
`makeExecCapture`/`defaultExecCapture`/`makeRunner` helpers are removed.

For the error test ("continues when npm query fails for one dep"), use a
registry that only has "good-pkg":

```typescript
it("continues when npm query fails for one dep", async () => {
 writeWorkspaceYaml(`configDependencies:\n  "bad-pkg": "1.0.0"\n  "good-pkg": "1.0.0"\n`);
 const result = await runWithRegistry(
  updateConfigDeps(["bad-pkg", "good-pkg"], tempDir),
  { "good-pkg": { version: "2.0.0", integrity: "sha512-goodHash==" } },
 );
 expect(result).toHaveLength(1);
 expect(result[0].dependency).toBe("good-pkg");
});
```

### Step 5: Run tests

Run: `pnpm vitest run src/lib/pnpm/config.test.ts`

Expected: All tests pass.

### Step 6: Commit

```bash
git add src/lib/pnpm/config.ts src/lib/pnpm/config.test.ts
git commit -m "refactor: replace CommandRunner npm queries with NpmRegistry in config.ts"
```

---

## Task 3: Replace CommandRunner npm queries with NpmRegistry in regular.ts

**Files:**

- Modify: `src/lib/pnpm/regular.ts`
- Modify: `src/lib/pnpm/regular.test.ts`

**Context:** `regular.ts` has a `queryLatestVersion` helper that shells out to
`npm view <pkg> dist-tags.latest --json` via `CommandRunner`. Replace with
`NpmRegistry.getLatestVersion(pkg)`. The module also uses `workspace-tools`
for finding package.json files — that stays.

### Step 1: Update imports in regular.ts

Replace:

```typescript
import { CommandRunner } from "@savvy-web/github-action-effects";
```

With:

```typescript
import { NpmRegistry } from "@savvy-web/github-action-effects";
```

### Step 2: Replace queryLatestVersion

Replace the entire function (lines 64-82):

```typescript
const queryLatestVersion = (packageName: string): Effect.Effect<string | null, never, NpmRegistry> =>
 Effect.gen(function* () {
  const registry = yield* NpmRegistry;
  const version = yield* registry.getLatestVersion(packageName).pipe(
   Effect.catchAll(() => Effect.succeed(null as string | null)),
  );
  return version;
 });
```

### Step 3: Update updateRegularDeps signature

```typescript
// Replace:
): Effect.Effect<ReadonlyArray<DependencyUpdateResult>, never, CommandRunner> =>

// With:
): Effect.Effect<ReadonlyArray<DependencyUpdateResult>, never, NpmRegistry> =>
```

### Step 4: Update tests

Same pattern as Task 2. Replace `CommandRunner` mocks with `NpmRegistry` mocks.
The test helper is simpler since regular.ts only needs `getLatestVersion`:

```typescript
import type { NpmRegistry as NpmRegistryService } from "@savvy-web/github-action-effects";
import { NpmRegistry } from "@savvy-web/github-action-effects";

const makeNpmRegistry = (
 versions: Record<string, string>,
): NpmRegistryService => ({
 getLatestVersion: (pkg) =>
  versions[pkg]
   ? Effect.succeed(versions[pkg])
   : Effect.fail(new Error(`Not found: ${pkg}`) as any),
 getDistTags: (pkg) =>
  versions[pkg]
   ? Effect.succeed({ latest: versions[pkg] })
   : Effect.fail(new Error(`Not found: ${pkg}`) as any),
 getPackageInfo: (pkg) =>
  versions[pkg]
   ? Effect.succeed({
     name: pkg,
     version: versions[pkg],
     distTags: { latest: versions[pkg] },
     integrity: undefined,
     tarball: undefined,
    })
   : Effect.fail(new Error(`Not found: ${pkg}`) as any),
 getVersions: (pkg) =>
  versions[pkg]
   ? Effect.succeed([versions[pkg]])
   : Effect.fail(new Error(`Not found: ${pkg}`) as any),
});

const runWithRegistry = <A, E>(
 effect: Effect.Effect<A, E, NpmRegistry>,
 versions?: Record<string, string>,
) => {
 const layer = Layer.succeed(NpmRegistry, makeNpmRegistry(versions ?? {}));
 return Effect.runPromise(
  effect.pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.None)),
 );
};
```

Update each test. For example:

```typescript
// Replace:
it("updates single dep to latest", async () => {
 // ... setup ...
 const result = await runWithRunner(
  updateRegularDeps(["effect"], tempDir),
  makeExecCapture((_cmd, args) => {
   if (args?.join(" ").includes("npm view effect")) return '"3.1.0"';
   return "ok";
  }),
 );
 // ...
});

// With:
it("updates single dep to latest", async () => {
 // ... setup ...
 const result = await runWithRegistry(
  updateRegularDeps(["effect"], tempDir),
  { effect: "3.1.0" },
 );
 // ...
});
```

### Step 5: Run tests

Run: `pnpm vitest run src/lib/pnpm/regular.test.ts`

Expected: All tests pass.

### Step 6: Commit

```bash
git add src/lib/pnpm/regular.ts src/lib/pnpm/regular.test.ts
git commit -m "refactor: replace CommandRunner npm queries with NpmRegistry in regular.ts"
```

---

## Task 4: Replace commitChanges with GitCommit.commitFiles in branch.ts

**Files:**

- Modify: `src/lib/github/branch.ts`
- Modify: `src/lib/github/branch.test.ts`

**Context:** `commitChanges` is a 50-line function that reads `git status`,
reads file contents from disk, builds tree entries, calls
`createTree`/`createCommit`/`updateRef`, and skips deleted files with a
warning. Replace the plumbing with `GitCommit.commitFiles(branch, message,
fileChanges)` which handles tree/commit/ref in one call AND supports file
deletions via `{ path, sha: null }`.

### Step 1: Update imports in branch.ts

Remove:

```typescript
import { readFileSync, statSync } from "node:fs";
import { relative } from "node:path";
```

Keep:

```typescript
import type { CommandRunnerError, GitBranchError, GitCommitError } from "@savvy-web/github-action-effects";
import { CommandRunner, GitBranch, GitCommit } from "@savvy-web/github-action-effects";
import { Effect } from "effect";
```

Add the `FileChange` type import:

```typescript
import type { CommandRunnerError, GitBranchError, GitCommitError } from "@savvy-web/github-action-effects";
import type { FileChange } from "@savvy-web/github-action-effects";
import { CommandRunner, GitBranch, GitCommit } from "@savvy-web/github-action-effects";
import { Effect } from "effect";
```

Note: check if `FileChange` is exported from the main entry point. If not,
it may be at `@savvy-web/github-action-effects/schemas/GitTree` or similar.
The `commitFiles` method accepts `Array<FileChange>` per the service
interface. Import from wherever the library exports it.

### Step 2: Rewrite commitChanges

Replace the entire function body (lines 114-202):

```typescript
export const commitChanges = (
 message: string,
 branchName: string,
): Effect.Effect<void, GitCommitError | CommandRunnerError, GitCommit | CommandRunner> =>
 Effect.gen(function* () {
  const commit = yield* GitCommit;
  const cmd = yield* CommandRunner;

  // Check if there are changes to commit
  const statusResult = yield* cmd.execCapture("git", ["status", "--porcelain"]);
  const lines = statusResult.stdout.split("\n").filter((l) => l.trim().length > 0);

  if (lines.length === 0) {
   yield* Effect.logInfo("No changes to commit");
   return;
  }

  yield* Effect.logInfo("Committing changes via GitHub API...");

  // Build FileChange entries from git status
  const fileChanges: FileChange[] = [];
  const cwd = process.cwd();

  for (const line of lines) {
   const status = line.substring(0, 2).trim();
   const filePath = line.substring(3);
   const absolutePath = filePath.startsWith("/") ? filePath : `${cwd}/${filePath}`;

   if (status === "D") {
    // Deleted file
    fileChanges.push({ path: filePath, sha: null });
    yield* Effect.logDebug(`Deleting file: ${filePath}`);
   } else {
    // Added or modified file — read content
    try {
     const { readFileSync } = await import("node:fs");
     const content = readFileSync(absolutePath, "utf-8");
     fileChanges.push({ path: filePath, content });
    } catch {
     yield* Effect.logWarning(`Could not read file: ${filePath}, skipping`);
    }
   }
  }

  if (fileChanges.length === 0) {
   yield* Effect.logInfo("No file changes to commit");
   return;
  }

  yield* Effect.logDebug(`File changes: ${fileChanges.length}`);

  // Commit all files in one API call
  const commitSha = yield* commit.commitFiles(branchName, message, fileChanges);
  yield* Effect.logInfo(`Created commit: ${commitSha}`);

  // Fetch the new commit locally so git status is clean
  yield* cmd.exec("git", ["fetch", "origin"]);
  yield* cmd.exec("git", ["checkout", "-B", branchName, `origin/${branchName}`]);
 });
```

Note: The signature changes — `GitBranch` is no longer required (was only
used for `getSha` to get HEAD, which `commitFiles` handles internally). The
error type changes from `GitBranchError | GitCommitError | CommandRunnerError`
to `GitCommitError | CommandRunnerError`.

Also: using `await import("node:fs")` inside the try block is awkward in an
Effect generator. Better to keep the static import at the top of the file
but only import `readFileSync`:

```typescript
import { readFileSync } from "node:fs";
```

And use it directly in the loop without the dynamic import.

### Step 3: Remove pushBranch

Delete the `pushBranch` function entirely (lines 97-103). It's a no-op and
not called from main.ts (API commits update refs directly). If it's imported
anywhere, remove those imports too.

Check: `grep -r "pushBranch" src/` to verify no callers.

### Step 4: Update tests

In `branch.test.ts`, update the commit-related tests. The mock setup changes:

- Remove mock `GitBranch` from commit tests (no longer needed for
  `commitChanges`)
- Mock `GitCommit.commitFiles` instead of `createTree`/`createCommit`/
  `updateRef`
- The mock should verify the `FileChange` array passed to `commitFiles`

```typescript
// Example updated test:
it("commits changed files via commitFiles", async () => {
 const capturedFiles: FileChange[] = [];

 const commitLayer = Layer.succeed(GitCommit, {
  createTree: () => Effect.die("not used"),
  createCommit: () => Effect.die("not used"),
  updateRef: () => Effect.die("not used"),
  commitFiles: (_branch, _message, files) => {
   capturedFiles.push(...files);
   return Effect.succeed("abc123");
  },
 });

 const cmdLayer = Layer.succeed(CommandRunner, {
  exec: () => Effect.succeed(0),
  execCapture: (_cmd, _args) =>
   Effect.succeed({
    exitCode: 0,
    stdout: " M package.json\n D obsolete.txt\n",
    stderr: "",
   }),
  execJson: () => Effect.die("not used"),
  execLines: () => Effect.succeed([]),
 });

 await Effect.runPromise(
  commitChanges("test commit", "test-branch").pipe(
   Effect.provide(Layer.mergeAll(commitLayer, cmdLayer)),
   Logger.withMinimumLogLevel(LogLevel.None),
  ),
 );

 expect(capturedFiles).toHaveLength(2);
 // Modified file has content
 expect(capturedFiles.find((f) => f.path === "package.json")).toHaveProperty("content");
 // Deleted file has sha: null
 expect(capturedFiles.find((f) => f.path === "obsolete.txt")).toEqual({
  path: "obsolete.txt",
  sha: null,
 });
});
```

### Step 5: Run tests

Run: `pnpm vitest run src/lib/github/branch.test.ts`

Expected: All tests pass.

### Step 6: Commit

```bash
git add src/lib/github/branch.ts src/lib/github/branch.test.ts
git commit -m "refactor: replace commitChanges plumbing with GitCommit.commitFiles"
```

---

## Task 5: Rename PullRequest schema to PullRequestResult

**Files:**

- Modify: `src/lib/schemas/index.ts`
- Modify: `src/types/index.ts`
- Modify: `src/main.ts`
- Modify: `src/main.effect.test.ts`
- Modify: `src/lib/schemas/index.test.ts` (if PullRequest is tested by name)

**Context:** Our `PullRequest` schema conflicts with the library's
`PullRequest` service tag. Rename to `PullRequestResult` since it represents
the result of a PR creation/update operation.

### Step 1: Rename in schemas/index.ts

```typescript
// Replace:
export const PullRequest = Schema.Struct({
// With:
export const PullRequestResult = Schema.Struct({

// Replace:
}).annotations({
 identifier: "PullRequest",
 title: "Pull Request",
});
export type PullRequest = typeof PullRequest.Type;
// With:
}).annotations({
 identifier: "PullRequestResult",
 title: "Pull Request Result",
});
export type PullRequestResult = typeof PullRequestResult.Type;
```

### Step 2: Update types/index.ts re-export

```typescript
// Replace PullRequest with PullRequestResult in the export list
export type {
 BranchResult,
 ChangedPackage,
 ChangesetFile,
 DependencyChange,
 DependencyUpdateResult,
 LockfileChange,
 PullRequestResult,
} from "../lib/schemas/index.js";
```

### Step 3: Update all references in main.ts and main.effect.test.ts

Search and replace `PullRequest` (as our schema type) with `PullRequestResult`
in these files. Be careful not to replace the library's `PullRequest` service
import (added in Task 6).

### Step 4: Update schema tests

In `src/lib/schemas/index.test.ts`, rename any test referencing the
`PullRequest` schema to use `PullRequestResult`.

### Step 5: Run tests

Run: `pnpm run test`

Expected: All tests pass.

### Step 6: Commit

```bash
git add src/lib/schemas/index.ts src/types/index.ts src/main.ts \
  src/main.effect.test.ts src/lib/schemas/index.test.ts
git commit -m "refactor: rename PullRequest schema to PullRequestResult"
```

---

## Task 6: Replace createOrUpdatePR with PullRequest service in main.ts

**Files:**

- Modify: `src/main.ts`
- Modify: `src/main.effect.test.ts`
- Modify: `src/main.test.ts` (if PR mocks exist)

**Context:** Replace the 110-line `createOrUpdatePR` function (with its
Octokit type-cast hack) with `PullRequest.getOrCreate`. Also consolidate
auto-merge — the `autoMerge` option on `PullRequest.create`/`getOrCreate`
replaces the separate `AutoMerge.enable()` call.

### Step 1: Update imports in main.ts

Remove:

```typescript
AutoMerge,
GitHubGraphQLLive,
GitHubClient,
```

Add:

```typescript
import {
 PullRequest as PullRequestService,
 PullRequestLive,
 NpmRegistryLive,
} from "@savvy-web/github-action-effects";
```

Note: We alias the library's `PullRequest` service as `PullRequestService` to
distinguish from our `PullRequestResult` schema type. Alternatively, if we've
already renamed our schema in Task 5, we can import the library's
`PullRequest` directly without alias. Check if there's still a name collision.

After Task 5, our schema is `PullRequestResult`, so we can import the
library's `PullRequest` directly:

```typescript
import {
 PullRequest,
 PullRequestLive,
 NpmRegistryLive,
} from "@savvy-web/github-action-effects";
```

### Step 2: Replace createOrUpdatePR function

Replace the entire function (lines 109-219) with:

```typescript
export const createOrUpdatePR = (
 branch: string,
 updates: ReadonlyArray<DependencyUpdateResult>,
 changesets: ReadonlyArray<ChangesetFile>,
 autoMerge?: "" | "merge" | "squash" | "rebase",
): Effect.Effect<PullRequestResult, never, PullRequest> =>
 Effect.gen(function* () {
  const pr = yield* PullRequest;

  const title = "chore(deps): update pnpm config dependencies";
  const body = generatePRBody(updates, changesets);

  const mergeMethod = autoMerge && autoMerge !== ""
   ? (autoMerge as "merge" | "squash" | "rebase")
   : undefined;

  const result = yield* pr.getOrCreate({
   head: branch,
   base: "main",
   title,
   body,
   autoMerge: mergeMethod ?? false,
  }).pipe(
   Effect.catchAll((error) =>
    Effect.gen(function* () {
     yield* Effect.logWarning(`PR operation failed: ${error}`);
     return {
      number: 0,
      url: "",
      nodeId: "",
      title: "",
      state: "open" as const,
      head: branch,
      base: "main",
      draft: false,
      merged: false,
      created: false,
     };
    }),
   ),
  );

  if (result.number > 0) {
   const verb = result.created ? "Created" : "Updated";
   yield* Effect.logInfo(`${verb} PR #${result.number}: ${result.url}`);
  }

  return {
   number: result.number,
   url: result.url,
   created: result.created,
   nodeId: result.nodeId,
  } as PullRequestResult;
 });
```

### Step 3: Update layer composition

In the `program` function, update the `appLayer`:

```typescript
const appLayer = Layer.mergeAll(
 ghClient,
 GitBranchLive.pipe(Layer.provide(ghClient)),
 GitCommitLive.pipe(Layer.provide(ghClient)),
 CheckRunLive.pipe(Layer.provide(ghClient)),
 PullRequestLive.pipe(Layer.provide(ghClient)),
 NpmRegistryLive,
 CommandRunnerLive,
 DryRunLive(dryRun),
);
```

### Step 4: Remove auto-merge code in innerProgram

Find the section that calls `AutoMerge.enable()` after PR creation and remove
it. The auto-merge is now handled by `PullRequest.getOrCreate`'s `autoMerge`
option. Pass `inputs["auto-merge"]` to `createOrUpdatePR`:

```typescript
// Replace:
const pr = yield* createOrUpdatePR(inputs.branch, allUpdates, changesetFiles);
// ... later ...
if (inputs["auto-merge"] && pr && pr.nodeId) {
 const mergeMethod = inputs["auto-merge"].toUpperCase() as "MERGE" | "SQUASH" | "REBASE";
 yield* AutoMerge.enable(pr.nodeId, mergeMethod).pipe(...);
}

// With:
const pr = yield* createOrUpdatePR(
 inputs.branch,
 allUpdates,
 changesetFiles,
 inputs["auto-merge"],
);
```

### Step 5: Update main.effect.test.ts

Replace the `makeTestGitHubClient` pattern with `PullRequestTest` or a simple
`Layer.succeed(PullRequest, ...)` mock.

The `createOrUpdatePR` tests need to provide a `PullRequest` service mock
instead of a `GitHubClient` mock:

```typescript
const makePullRequestMock = (options?: {
 existingPR?: { number: number; url: string; nodeId: string };
}) => Layer.succeed(PullRequest, {
 get: () => Effect.die("not used"),
 list: () => Effect.die("not used"),
 create: (opts) => Effect.succeed({
  number: 1,
  url: "https://github.com/test/repo/pull/1",
  nodeId: "node-1",
  title: opts.title,
  state: "open" as const,
  head: opts.head,
  base: opts.base,
  draft: false,
  merged: false,
 }),
 update: () => Effect.die("not used"),
 getOrCreate: (opts) => {
  if (options?.existingPR) {
   return Effect.succeed({
    ...options.existingPR,
    title: opts.title,
    state: "open" as const,
    head: opts.head,
    base: opts.base,
    draft: false,
    merged: false,
    created: false,
   });
  }
  return Effect.succeed({
   number: 1,
   url: "https://github.com/test/repo/pull/1",
   nodeId: "node-1",
   title: opts.title,
   state: "open" as const,
   head: opts.head,
   base: opts.base,
   draft: false,
   merged: false,
   created: true,
  });
 },
 merge: () => Effect.die("not used"),
 addLabels: () => Effect.die("not used"),
 requestReviewers: () => Effect.die("not used"),
});
```

### Step 6: Run tests

Run: `pnpm run test`

Expected: All tests pass.

### Step 7: Build and verify

Run: `pnpm run typecheck && pnpm run lint && pnpm ci:build`

Expected: All pass. The ncc build should work since we're using well-typed
library services instead of manual Octokit casts.

### Step 8: Rebuild dist/

Run: `pnpm run build`

Then verify the built files are updated:

```bash
git diff --stat dist/ .github/actions/local/dist/
```

### Step 9: Commit

```bash
git add src/main.ts src/main.effect.test.ts src/main.test.ts \
  dist/main.js .github/actions/local/dist/main.js
git commit -m "refactor: replace createOrUpdatePR hack with PullRequest service"
```

---

## Task 7: Final cleanup and verification

**Files:**

- Modify: `docs/plans/2026-03-09-v050-library-migration-design.md` (optional)
- Modify: `.claude/design/pnpm-config-dependency-action/01-dependencies.md`
- Modify: `.claude/design/pnpm-config-dependency-action/05-module-library.md`

### Step 1: Run full test suite with coverage

Run: `pnpm ci:test`

Expected: All tests pass, coverage thresholds met.

### Step 2: Run full build

Run: `pnpm ci:build`

Expected: ncc build succeeds.

### Step 3: Update design docs

Update `01-dependencies.md` to remove `semver`, `@octokit/request`,
`@octokit/rest` from the dependencies list. Add note about v0.5.0 services.

Update `05-module-library.md` to reflect:

- `config.ts` now requires `NpmRegistry` not `CommandRunner`
- `regular.ts` now requires `NpmRegistry` not `CommandRunner`
- `branch.ts` `commitChanges` now uses `GitCommit.commitFiles`
- `pushBranch` removed

### Step 4: Commit

```bash
git add .claude/design/ docs/plans/
git commit -m "docs: update design docs for v0.5.0 library migration"
```

### Step 5: Push

```bash
git push origin feat/github-action-effects
```
