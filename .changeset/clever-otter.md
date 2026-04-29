---
"pnpm-config-dependency-action": patch
---

## Bug Fixes

### Match dependencies across all writable sections

The `dependencies` input now matches against `dependencies`,
`devDependencies`, and `optionalDependencies` of each workspace
package's `package.json`. Previously, only `devDependencies` were
scanned, so deps declared in `dependencies` (e.g. a runtime dep of a
publishable package) or `optionalDependencies` were silently skipped
even when they matched a configured pattern.

`peerDependencies` remain intentionally excluded — peer ranges are
managed by the `peer-lock` and `peer-minor` inputs via `syncPeers`.

A dependency that appears in more than one section of the same
package (e.g. both `dependencies` and `devDependencies`) is now
updated in every section it appears in, with one update record per
section.

### Accurate dependency type reporting

`DependencyUpdateResult.type` now reflects the actual section a dep
was found in (`dependency` / `devDependency` / `optionalDependency`)
instead of always reporting `devDependency`. `Changesets.create`
routes these by `update.type`: `dependency` and `optionalDependency`
trigger changeset emission for the affected workspace package, and
`devDependency` remains informational only. Catalog-resolved peer
changes and peer-sync rewrites continue to trigger as before.

## Refactoring

Removed the local `Workspaces` service wrapper now that
`workspaces-effect@0.5.1` exposes `WorkspaceDiscovery.listPackages(cwd)`
and `WorkspaceDiscovery.importerMap(cwd)` upstream. Domain services
yield `WorkspaceDiscovery` directly; `makeAppLayer` wires
`WorkspaceDiscoveryLive` and `WorkspaceRootLive` with `NodeContext.layer`.
No user-facing API changes.
