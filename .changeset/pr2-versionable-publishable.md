---
"pnpm-config-dependency-action": minor
---

## Features

### Versionable + trigger-driven changeset emission

Changesets now follow precise rules:

- A workspace package gets a changeset only if it is **versionable** (publishable per silk or vanilla mode rules, OR non-publishable with `privatePackages.version: true` in `.changeset/config.json`).
- A versionable package gets a changeset only when at least one **trigger** fires for it: a `dependencies` / `optionalDependencies` / `peerDependencies` specifier change in its own `package.json`, a peer-sync rewrite of one of its peers, or a non-dev catalog reference resolving to a different version after the run.
- `devDependencies`-only changes never produce a changeset (they appear in the table only when a changeset is being written for other reasons).
- Empty changesets are no longer emitted.

## Bug Fixes

### Catalog consumer detection on pnpm v9 lockfiles

`findCatalogConsumers` in the lockfile service now reads catalog specifiers from the importer's flat `specifiers` map (the pnpm v9 lockfile shape) instead of incorrectly looking for a `.specifier` property on the per-dep value (which is just a version string). Previously, catalog changes never surfaced as triggers because consumers were never matched. Catalog reference changes consumed in `dependencies`, `optionalDependencies`, or `peerDependencies` now correctly trigger changesets for the consuming workspace.

### Per-importer per-section catalog change records

`compareCatalogs` now emits one `LockfileChange` per `(catalog change, consuming importer, dep section)` triple instead of a single aggregated record. Each record carries the accurate `type` field, so changes consumed only in `devDependencies` no longer incorrectly produce changesets for those workspaces.

## Maintenance

- Add `ChangesetConfig` service for reading `.changeset/config.json` (mode and `privatePackages.version` detection).
- Add `Publishability` service with mode-aware silk and vanilla rules and a versionable cascade.
- Remove the deprecated `createChangesets`, `analyzeAffectedPackages`, and `formatChangesetSummary` standalone exports from the changesets service. The `Changesets.create` service method is the only entry point.
- Add 13 integration test fixtures under `__test__/integration/fixtures/` covering all changeset emission scenarios end-to-end.
