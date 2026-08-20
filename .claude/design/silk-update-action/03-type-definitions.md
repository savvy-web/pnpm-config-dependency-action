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

Types are defined using Effect Schema (v4) in `src/schema/domain.ts`. Error
types use `Schema.TaggedError` in `src/errors/errors.ts`. Module-level
types (e.g. `PackageManagerUpgradeOutcome`, `DetectedPm`) are defined in their
respective service files.

No barrel re-exports exist. Import directly from the defining module.

Effect v4 Schema spellings used throughout: literal unions are
`Schema.Literals([...])` (was `Schema.Literal(...)`) and refinements attach via
`.check(...)` (e.g. `Schema.String.check(Schema.isMinLength(1))`) rather than
`.pipe(Schema.…)`.

## Domain Schemas (src/schema/domain.ts)

See `src/schema/domain.ts` for the full set of `Schema.Struct` definitions
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
]).annotate({
 // Load-bearing: reused by two structs, so the JSON Schema lowering hoists it
 // into $defs. Without this it is named positionally (`Union_`).
 identifier: "DependencyType",
 title: "Dependency Type",
});

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

`PeerIssue` records one unsatisfied peer. `found` is the version actually
resolved, or `null` when nothing resolved at all:

```typescript
export const PeerIssue = Schema.Struct({
 importer: Schema.String,
 dependency: NonEmptyString,
 wanted: NonEmptyString,
 found: Schema.NullOr(Schema.String),
 optional: Schema.Boolean,
 parents: Schema.Array(Schema.String),
}).annotate({ identifier: "PeerIssue", title: "Peer Issue" });
```

**`found: null` IS the "missing" case** — there is deliberately no separate
discriminant. A second field encoding the same fact can contradict the first, and
a consumer would have no way to know which to trust. The visible half of that
decision is a rendering rule: `report.ts` must never print the raw `null` into
someone else's pull request, which is pinned by a test asserting the body
contains no `null`.

`parents` is flattened to `name@version` strings here, from the kit's structured
`PeerParent` path. The chain is the actionable half of the report — *"react is
wrong"* is not a bug report, *"react-dom wants a react you do not have"* is.

**It is *a* route, not the set of routes.** Where an importer reaches one
declaring package by two different chains, `pnpm peers check` reports the peer
**once** carrying one chain, and `@effected/workspaces` matches that deliberately
(measured against the oracle, `@effected/workspaces@0.15.0`). This matters here
and not upstream, because this repo *renders* the chain into someone else's pull
request: a reader must not infer the displayed path is the only one, and a second
route existing is **not** a missing row.

## The structured `result` output (src/schema/domain.ts)

`RunResultDocument` is the whole run as one machine-readable document, published
as the `result` action output **alongside — never instead of** — the four scalar
outputs, which are unchanged.

```typescript
export const RunResultDocument = Schema.Struct({
 schemaVersion: Schema.Literal(1),
 hasChanges: Schema.Boolean,
 dryRun: Schema.Boolean,
 packageManager: Schema.NullOr(Schema.Literals(["pnpm", "bun", "npm"])),
 workspaceRoot: Schema.String,
 branch: Schema.String,
 targetBranch: Schema.String,
 updates: Schema.Array(DependencyUpdateResult),
 catalogDeltas: Schema.Array(CatalogDelta),
 lockfileChanges: Schema.Array(LockfileChange),
 changesets: Schema.Array(ChangesetFile),
 pullRequest: Schema.NullOr(PullRequestResult),
});
```

Three properties are load-bearing, each with what would falsify it:

- **Composed from the schemas the run already produces**, not a parallel
  reporting shape. Two shapes would drift, and the drift would be invisible
  because both would still serialize. *Falsified if* a field here stops
  referencing a domain schema and starts restating one.
- **The baseline is an empty-run document, not an empty string** — so a consumer
  runs `fromJSON(...)` unconditionally rather than guarding. Pinned by
  `__test__/unit/schema/outputs.test.ts`, which asserts it parses **and decodes
  against this schema**. *Falsified if* `initialOutputs.result` becomes `""`.
- **`packageManager` is nullable, not a placeholder.** A run that ended before
  detection has no package manager, and a value that decodes, serializes and is
  false is worse than an absent one: a consumer branching on it cannot tell it is
  branching on a lie. `pullRequest: null` already establishes absence-is-null here.

`PullRequestResult.number` is `Schema.Int`, not `Schema.Number`. The ajv strict
gate forced this and was right — `Schema.Number` renders as an `anyOf` modelling
`NaN`/`Infinity` as strings, so the `> 0` refinement landed in a typeless
`allOf` branch. We had been modelling a PR number as possibly `NaN`.

### The generated JSON Schema

`lib/scripts/generate-schema.ts` serializes `RunResultDocument` to
`docs/schema/run-result.schema.json` via `@effected/schemastore` (a devDependency),
using its `SchemaPipeline.run` (structural lint + ajv strict gate + content-compare write).
It lives in `lib/scripts/` rather than `scripts/` because that path is
cache-invalidating for turbo. Run with `pnpm generate-schema`.

**Every shared schema must carry an explicit `identifier` annotation.** From
`effect@4.0.0-beta.107` the lowering **hoists a sub-schema used in more than one
place into `$defs`** and `$ref`s it, where it previously inlined the same enum at
each use site. With no identifier to use, it invents a positional one:
`DependencyType` — referenced by both `DependencyUpdateResult.type` and
`LockfileChange.type` — first lowered to `$defs/Union_`.

That is validation-equivalent for a consumer, which is exactly why it is worth a
note: nothing fails, and a generated name lands in a document published at a
public `$id`. It is also *positional*, so introducing a second anonymous union
would renumber it to `Union_1` and silently rename a key consumers may `$ref`.
`DependencyType` now annotates `identifier` + `title` like every other shared
schema in `domain.ts`, so it lowers to `$defs/DependencyType`.

**A `$defs` key matching `Union_`/`Struct_` and friends is a missing annotation
at the definition site**, not an artifact to commit. The drift test will report
the change as `contract` either way — it classifies that a consumer-visible
region moved, not whether the new name is a good one.

`__test__/unit/generate-schema.test.ts` imports the generator's **own exported
`targets`** and runs `SchemaPipeline.check` — the identical walk without writing.
Importing the same constant is the point: a test that rebuilt its own target list
would pass while the generator wrote something else. It asserts three things, and
two exist because `wouldWrite: false` alone is not sufficient evidence:

| assertion | what it catches |
| --- | --- |
| `targets.length > 0` | `check([])` trivially reports no drift |
| `wouldWrite === false` | the actual staleness |
| `blocked === false` | a schema so broken it can *never* generate also reports no pending write |

The pipeline classifies a write as `contract` (consumer-visible break) or
`annotations` (documentation only) — verified end to end by driving the
generator, since vitest truncates the message before it renders.

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

## Pure Helper Types (src/utils/runtime.ts)

```typescript
/** A JavaScript runtime managed by this action. */
export type RuntimeName = "node" | "deno" | "bun";

/** A single devEngines.runtime entry (extra keys preserved on write). */
export interface RuntimeEntry {
 name?: string;
 version?: string;
 onFail?: string;
 [key: string]: unknown;
}

/**
 * A located `devEngines.runtime` entry and the JSONC path to its `version`.
 * `locateRuntimeEntry` returns both from one walk.
 */
export interface LocatedRuntimeEntry {
 /** The entry as parsed — read the current version; do NOT mutate it. */
 readonly entry: RuntimeEntry;
 /** Path for `PackageJsonFile.modify`. Shape-dependent — see below. */
 readonly versionPath: ReadonlyArray<string | number>;
}
```

`versionPath` is returned rather than rebuilt by the caller because
`devEngines.runtime` is legally either a single object or an array, so the path
is `["devEngines","runtime","version"]` in one case and
`["devEngines","runtime",<index>,"version"]` in the other. One walker produces
the entry and the path together; two walkers would drift.

**`src/utils/pnpm.ts` no longer contributes a type here.** It exported
`ParsedPnpmVersion` alongside `parsePnpmVersion` / `formatPnpmVersion`; all three
are **deleted**. `PackageManagerUpgrade` parsed with a module-private
`ParsedPmVersion` of the same shape, generalized over all three package managers,
which superseded the pnpm-only original during the multi-package-manager work —
the exports simply outlived their last caller.

That is the **same argument that removed four error classes** from
`errors/errors.ts` (see the note at the end of this document): an export with no
construction site is a claim the type system carries indefinitely and no test can
falsify. Worth recording how this one surfaced, because the order is unusual and
reusable: **a documentation pass found it.** Reconciling the
`@effected/package-json` record required checking, call site by call site, which
of four helpers the adoption had actually replaced — and that check found both
that these two had no callers *and* that the justification for keeping them
(the kit rejecting a caret `packageManager` pin) had independently expired. The
source deletion followed from the doc work rather than the other way round.

`utils/pnpm.ts` now exports only `detectIndent`, which carries no type. The
module retains a comment block where each deleted export was, so the reasoning
is discoverable from the source and not only from here.

**`ParsedPmVersion` is gone too, and it is worth reading as a coda to the
paragraph above rather than as a second instance of it.** It had a caller and
was doing work — but `hasCaret` and `hasSha`, two of its three fields, had **no
reader anywhere**: `PackageManagerUpgrade` consumed `.version` and null-ness and
nothing else. So the interface was two-thirds dead while the export around it
looked live, which is the variant a grep for unused *exports* does not find. The
whole shape collapsed to `string | null` when the parse moved onto
`@effected/npm`'s `PackageManagerPin` (issue #290); the pin's own
`InvalidPackageManagerPinError` carries a `reason` discriminant (`format` /
`name` / `version` / `integrity`) that the local parser could not, and this
repo's caller still reads it as "reference or not".

## Effect Error Types (src/errors/errors.ts)

Errors use `Schema.TaggedError` for typed error handling with rich
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
