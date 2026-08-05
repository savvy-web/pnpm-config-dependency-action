---
status: current
module: silk-update-action
category: architecture
created: 2026-02-20
updated: 2026-07-26
last-synced: 2026-07-26
completeness: 95
related:
  - ./_index.md
dependencies: []
implementation-plans: []
---

# Type Definitions

[Back to index](./_index.md)

## Overview

Types are defined using Effect Schema (v4) in `src/schemas/domain.ts`. Error
types use `Schema.TaggedErrorClass` in `src/errors/errors.ts`. Module-level
types (e.g. `PackageManagerUpgradeOutcome`, `DetectedPm`) are defined in their
respective service files.

No barrel re-exports exist. Import directly from the defining module.

Effect v4 Schema spellings used throughout: literal unions are
`Schema.Literals([...])` (was `Schema.Literal(...)`) and refinements attach via
`.check(...)` (e.g. `Schema.String.check(Schema.isMinLength(1))`) rather than
`.pipe(Schema.…)`.

## Domain Schemas (src/schemas/domain.ts)

See `src/schemas/domain.ts` for the full set of `Schema.Struct` definitions
(`BranchResult`, `DependencyChange`, `ChangedPackage`, `ChangesetFile`,
`PullRequestResult`, `CatalogDelta`, `LockfileChange`). Each schema derives its
TypeScript type via `typeof Schema.Type`.

The load-bearing type is the `DependencyType` discriminator, shared by
`DependencyUpdateResult` and `LockfileChange`:

```typescript
/**
 * Dependency type discriminator. The `runtime` member tags
 * devEngines.runtime engine bumps (node/deno/bun) emitted by RuntimeUpgrade;
 * `config` tags both config-dependency updates and the package-manager
 * self-upgrade.
 */
export const DependencyType = Schema.Literals([
 "config",
 "dependency",
 "devDependency",
 "peerDependency",
 "optionalDependency",
 "runtime",
]);

/** One per (path, dep, section) update; carries the precise `type`. */
export const DependencyUpdateResult = Schema.Struct({
 dependency: NonEmptyString,
 from: Schema.NullOr(Schema.String),
 to: NonEmptyString,
 type: DependencyType,
 package: Schema.NullOr(Schema.String),
});

/** One per (catalog change, importer, section) triple from compareLockfiles. */
export const LockfileChange = Schema.Struct({
 type: DependencyType,
 dependency: NonEmptyString,
 from: Schema.NullOr(Schema.String),
 to: NonEmptyString,
 affectedPackages: Schema.Array(Schema.String),
});
```

`CatalogDelta` records one catalog entry's fate in a bun compat-mode merge. On a
plugin bump this table is the actual payload of the run, which is why it is
carried all the way through to the PR body rather than being logged and dropped:

```typescript
export const CatalogDelta = Schema.Struct({
 catalog: NonEmptyString,
 dependency: NonEmptyString,
 from: Schema.NullOr(Schema.String),
 to: Schema.NullOr(Schema.String),
 action: Schema.Literals(["added", "updated", "removed", "kept"]),
});
```

## Package-Manager Types (src/services/package-manager.ts)

```typescript
/**
 * The package managers this action supports. Yarn is detected upstream but
 * rejected here: nothing in the config-dep, install or upgrade paths is wired
 * or tested for it.
 */
export type SupportedPm = "pnpm" | "bun" | "npm";

/** The package manager this run is operating on, resolved once. */
export interface DetectedPm {
 readonly pm: SupportedPm;
 readonly version: string | undefined;
 readonly root: string;
}
```

## Upgrade Outcome Types (src/services/package-manager-upgrade.ts)

`upgrade()` always resolves to an outcome — never `null` — so a caller can report
*why* nothing happened. `kind` is the machine-readable discriminant callers
dispatch on; `reason` is prose for humans and must never be parsed.

```typescript
export type PackageManagerReferenceSource = "devEngines" | "packageManager" | null;

export type PackageManagerSkipKind =
 | "disabled"        // upgrade-package-manager: false. Benign.
 | "no-reference"    // auto mode, no packageManager/devEngines entry to anchor on.
 | "unsatisfiable"   // nothing in THIS pm's release list satisfies the range.
 | "already-current" // the reference is already the newest the range admits.
 | "error";          // read/write failed, folded into an outcome by the caller.

export interface PackageManagerUpgradeApplied {
 readonly applied: true;
 readonly pm: SupportedPm;
 readonly reference: string | null;
 readonly referenceSource: PackageManagerReferenceSource;
 readonly targetRange: string;
 readonly from: string | null;   // null when a field was added
 readonly to: string;
 readonly packageManagerUpdated: boolean;
 readonly devEnginesUpdated: boolean;
 readonly added: boolean;
}

export interface PackageManagerUpgradeSkipped {
 readonly applied: false;
 readonly pm: SupportedPm;
 readonly reference: string | null;
 readonly referenceSource: PackageManagerReferenceSource;
 readonly targetRange: string | null;
 readonly kind: PackageManagerSkipKind;
 readonly reason: string;
}

export type PackageManagerUpgradeOutcome =
 | PackageManagerUpgradeApplied
 | PackageManagerUpgradeSkipped;
```

`unsatisfiable` is the acceptance signal for the whole multi-package-manager
design: it distinguishes "this range names a different package manager than the
one detected" from "already up to date", and is the only skip kind reported at
warning level.

## Module-Level Types (src/services/runtime-upgrade.ts)

```typescript
/**
 * Result of a single runtime upgrade. `from` is always the version the manifest
 * already declared (an upgrade requires an existing entry); `to` is always a
 * bare, exact version (no range operator).
 */
export interface RuntimeUpgradeResult {
 readonly runtime: RuntimeName;
 readonly from: string;
 readonly to: string;
}

/** Per-runtime mode: "false" | "auto" | a semver range. */
export interface RuntimeUpgradeConfig {
 readonly node: string;
 readonly deno: string;
 readonly bun: string;
}
```

## Catalog Types (src/utils/catalogs.ts, src/services/catalog-config-deps.ts)

```typescript
/** catalog name → (dependency → specifier). The default catalog is keyed "". */
export type CatalogMap = Record<string, Record<string, string>>;

/** The updates and catalog deltas produced by one config-dependency pass. */
export interface CatalogConfigDepsResult {
 readonly updates: ReadonlyArray<DependencyUpdateResult>;
 readonly deltas: ReadonlyArray<CatalogDelta>;
}
```

## Release-Age Types (src/services/release-age.ts)

The gate types live upstream in `@effected/npm`: `ReleaseAgeGate` (the combined,
total gate) and `PartialReleaseAgeGate` (a per-source contribution), the latter
re-exported by `src/services/release-age.ts`. The action treats them as opaque
beyond `combine`, `isExcluded` and `filterVersions`.

## Pure Helper Types (src/utils/pnpm.ts, src/utils/runtime.ts)

```typescript
/** Parsed pnpm version info. */
export interface ParsedPnpmVersion {
 readonly version: string;
 readonly hasCaret: boolean;
 readonly hasSha: boolean;
}

/** A JavaScript runtime managed by this action. */
export type RuntimeName = "node" | "deno" | "bun";

/** A single devEngines.runtime entry (extra keys preserved on write). */
export interface RuntimeEntry {
 name?: string;
 version?: string;
 onFail?: string;
 [key: string]: unknown;
}
```

## Effect Error Types (src/errors/errors.ts)

Errors use `Schema.TaggedErrorClass` for typed error handling with rich
metadata. The local `ActionError` union covers:

- `InvalidInputError` — `{ field, value, reason }`. **This is the action's input
  and workspace rejection error.** The deleted `@savvy-web/github-action-effects`
  exported an `ActionInputError`; the kit has no successor (kit inputs are
  `Config` values whose failures are core `ConfigError`), so input validation in
  `program.ts`, the branch-ref preflight in `services/branch.ts`, and the
  yarn/no-workspace rejection in `services/package-manager.ts` all raise this
  local error instead.
- `ChangesetError` — `{ reason, packages? }`.
- `FileSystemError` — `{ operation, path, reason }`.
- `LockfileError` — `{ operation, reason }`.

`getErrorMessage(error)` is the one exported helper over the union.

**Four members were deleted**, along with `isRetryableError` and the
`GitOperation` schema in `schemas/domain.ts` that only `GitError` consumed:
`GitHubApiError`, `GitError`, `PnpmError` and `DependencyUpdateFailures`. None
had a construction site anywhere in `src/` — the only code that ever built one
was the test suite asserting on its retry predicates, so the tests passed
precisely because they were the sole callers. `isRetryableError` dispatched only
on those three tags and had no caller in `src/` either.

`__test__/unit/errors/errors.test.ts` now pins the exported error set, so
re-adding a class without a construction site fails a test rather than passing
silently.

**Every member of the union is raised.** `InvalidInputError` (program, branch,
package-manager), `FileSystemError` (every manifest/YAML writer), `ChangesetError`
(the changesets adapter's error mapping) and `LockfileError` (lockfile
capture/compare). Failures the action does not define itself arrive as the kit's
types: GitHub failures as the single `GitHubError` (discriminated with `hasKind`)
and subprocess failures as `@effected/commands`' `CommandFailedError` /
`CommandOutputError`.

Keep it that way: an error channel with no construction site is a claim the type
system will carry indefinitely and no test can falsify. Demonstrate the failure
path with a test, or leave it out of the signature.
