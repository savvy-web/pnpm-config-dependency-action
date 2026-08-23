---
"silk-update-action": minor
---

## Dependencies

| Dependency | Type | Action | From | To |
| :--- | :--- | :--- | :--- | :--- |
| @effected/pnpm-plugin-effect | config | updated | 0.6.3 | 0.6.4 |
| @effected/workspaces | dependency | updated | 0.17.2 | 0.18.0 |
| @savvy-web/silk-effects | dependency | updated | 7.0.1 | 7.1.0 |
| @savvy-web/silk | devDependency | updated | 3.10.0 | 3.10.1 |

Only the config-dependency pin was hand-edited; every other move follows from it
through `catalog:effected` and a lockfile refresh. `@effected/workspaces` also
closes a duplicate resolution that has been open since this action moved to
`^0.17.0` ahead of `@savvy-web/silk-effects` — both now resolve `0.18.0`, and
`pnpm why` reports a single copy of every kit package.

## Features

The dependency-table `Type` vocabulary gained `runtime` and `packageManager`, so
rows this action emits into a pull request now say what they are:

| Dependency | Type | Action | From | To |
| :--- | :--- | :--- | :--- | :--- |
| pnpm | packageManager | updated | 11.22.0 | 11.23.0 |
| node | runtime | updated | 25.6.0 | 26.0.0 |

`runtime` was previously local to this action and could never reach the shared
table. Both are release-neutral, in the same bucket as `devDependency`.

## Bug Fixes

* The package-manager self-upgrade is no longer reported as a config dependency.
  It was tagged `config` and identified by a `dependency === "pnpm"` name match,
  which was wrong twice over: it rendered `| pnpm | config | … |` into consumers'
  pull requests claiming pnpm was a config dependency, and matching by name
  covered neither bun nor npm. Both now follow from the type.
* The commit subject no longer hardcodes `pnpm` when naming the upgraded package
  manager, so a bun or npm self-upgrade is described accurately.

## Breaking Changes

`config` in the `result` output now means pnpm `configDependencies` and nothing
else. A consumer matching `type === "config" && dependency === "pnpm"` to detect
a package-manager upgrade will stop matching — and will do so silently, since
the row is still present under its accurate type. Match `type === "packageManager"`
instead, which also covers bun and npm.

The `DependencyType` enum in `docs/schema/run-result.schema.json` gained
`packageManager`. Existing documents remain valid.

## Tests

* The changeset table-escaping canary now compares against the shipped canonical
  serializer instead of banning backslashes outright. `@effected/markdown@0.6.3`
  makes canonical stringify a stability commitment: cells are escaped and the
  escapes round-trip, so the old assertion rejected correct output. The three
  value assertions beside it never discriminated — `toContain("~0.2.0")` passes
  against `\~0.2.0` — so they were replaced rather than kept.
* `DependencyType` is now asserted at compile time to be a subset of the shared
  vocabulary, so a member this action emits but CSH005 rejects fails the build
  here rather than in the consumer's repository.
* Added an end-to-end round trip proving a `packageManager` row and a `runtime`
  row leave the schema, survive rendering, and land in the pull-request body as
  cells the shared vocabulary decodes.

## Maintenance

Test doubles for `WorkspaceDiscovery` implement the per-call-root members
(`infoIn`, `listPackagesIn`, `refreshIn`) that `@effected/workspaces@0.18.0`
adds, and the `RegenResult` doubles carry the new informational `coexisting`
bucket.
