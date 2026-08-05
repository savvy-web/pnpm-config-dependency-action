---
"silk-update-action": minor
---

## Features

### Structured `result` output

The complete run is now published as a JSON document on a new `result` output, alongside the four existing outputs — which are unchanged.

A consuming workflow reads it with `fromJSON()` **unconditionally**: on every exit path, including a failure before any work began, `result` is a valid document rather than an empty string.

```yaml
- uses: savvy-web/silk-update-action@v4
  id: update
- run: echo "${{ fromJSON(steps.update.outputs.result).updates.length }} update(s)"
```

It carries the run's disposition (`hasChanges`, `dryRun`), its context (`packageManager`, `workspaceRoot`, `branch`, `targetBranch`) and five collections: `updates`, `catalogDeltas`, `lockfileChanges`, `changesets` and `pullRequest`. Arrays are empty rather than omitted, so a consumer can iterate without a presence check — an empty array still has no element `0`, so check `updates.length` before indexing. `pullRequest` and `packageManager` are `null` when genuinely absent rather than carrying a placeholder.

A JSON Schema is published at `docs/schema/run-result.schema.json` and regenerated with `pnpm generate-schema`.

## Bug Fixes

**None of these produced an error.** Each was a silent wrong answer — the action reported success while quietly doing less than it claimed, so no user could have known.

### Custom commands ran in the wrong directory

Every command in the `run` input inherited the action's process directory rather
than the detected workspace root. When the action is invoked from a
subdirectory those are different trees, so a configured `pnpm test` or
`pnpm build` linted, tested or built something other than what the run had just
edited — and passed, reporting green about the wrong tree.

### Glob patterns in `peer-lock` / `peer-minor` silently did nothing

`dependencies` entries are globs; peer entries are matched as exact package
names. A `@scope/*` in `peer-lock` therefore matched nothing, no peer range was
synced, and the run reported success. Those inputs now fail with a clear error
naming the offending entries.

### Files silently missing from commits

- A **renamed** file never reached the commit at all. The status parser read `R old.ts -> new.ts` as a single path, failed to read it, and dropped the change with a warning. Renames are now committed as a delete of the old path plus content at the new one.
- A **deletion whose index and worktree status disagreed** (`AD`, `RD`) was treated as a modification, failed the same read, and was dropped the same way.
- A **copy** is now distinguished from a rename, so its origin is no longer deleted along with it.

### Git commands running in the wrong directory

When the action is invoked from a subdirectory of the workspace, two paths resolved against the process directory instead of the detected workspace root:

- `commitChanges` resolved changed-file paths there, so files could be read from the wrong place or not at all.
- `ensureBaseHistory` ran its merge-base probe and recovery fetches there, so the changeset diff could resolve against the wrong repository state.

### Release-age gate silently disabled by a hook that logged

A config-dependency `pnpmfile` hook that wrote anything to stdout corrupted the parse of the replay child's output. Because that path fails open by design, the run continued with **no release-age gate at all** — after which the action could propose a version pnpm rejects at install with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`. That is precisely the failure the gate exists to prevent, produced by the gate's own error handling. The payload is now framed so hook output cannot corrupt it.

### Release-age gate: one narrow case now loses the gate

Gate discovery moved to `@effected/workspaces`, whose replay reads its child's
payload from the last line of stdout. A config-dependency `pnpmfile` hook that
writes to stdout **after** that payload — cleanup logging from a
`process.on("exit")` handler, for instance — now makes discovery fail, and the
action falls back to running with no release-age gate (logged as a warning).

A hook that logs during execution, which is the ordinary case, is unaffected.
This is narrower than the bug fixed above but it is the same failure mode, so it
is called out rather than left to be discovered: if your workspace uses a
config dependency whose pnpmfile logs on exit, the gate will not apply and pnpm
will enforce it at install instead.

Tracked upstream as [spencerbeggs/effected#292](https://github.com/spencerbeggs/effected/issues/292).

### The `result` document described the wrong run on two exit paths

A run that ended at the no-changes exit, or because a custom command failed,
published the *pre-run baseline* document — `packageManager: null`,
`workspaceRoot: ""` — even though detection had already succeeded. It parsed,
every field was present, and nothing in the log distinguished it from a run that
genuinely never detected anything. Both exits now encode the run's real context.

### Outputs missing on failure paths

Every declared output is now published on every exit path. Previously a run that failed early set none of them, so a downstream `if: steps.x.outputs.has-changes == 'false'` compared against an empty string rather than `false`.

## Dependencies

| Dependency | Type | Action | From | To |
| :--- | :--- | :--- | :--- | :--- |
| @effected/schemastore | devDependency | added | — | 0.2.1 |
| tsx | devDependency | added | — | ^4.23.5 |
| @effected/workspaces | dependency | updated | ^0.9.5 | ^0.10.0 |
| @effected/commands | dependency | updated | ^0.2.1 | ^0.3.0 |
| @effected/npm | dependency | updated | ^0.8.2 | ^0.8.3 |
| @effected/git | dependency | added | — | ^0.5.2 |

## Refactoring

- The `git status` reads behind the change verdict and the commit file list now
  go through `@effected/git`, which models the two porcelain columns separately.
  The local porcelain parser is deleted — the rename, `AD`/`RD` and copy defects
  above become unrepresentable rather than merely fixed. `core.fileMode=false` is
  written to the checkout's own git config once per run instead of being passed
  per command, so the two readers cannot drift apart.
- **Every domain service layer moved from an `XLive` constant to a `static layer`
  on its class**, matching the `@effected` kit's own convention:
  `BranchManager.layer`, `ReleaseAge.layer` (plus `ReleaseAge.layerNoop`),
  `Report.layer`, `Changesets.layer`, `ConfigDeps.layer`,
  `CatalogConfigDeps.layer`, `RegularDeps.layer`, `RuntimeUpgrade.layer`,
  `PackageManagerUpgrade.layer` and `Lockfile.layer`. None was part of a
  documented public API — the action ships as a bundle, not a library.
- `WorkspaceYamlLive` and its `WorkspaceYaml` tag were **deleted** rather than
  renamed: nothing outside their own test suite ever wired them. The standalone
  `formatWorkspaceYaml` / `readWorkspaceYaml` helpers are unchanged and are what
  the action actually calls.
