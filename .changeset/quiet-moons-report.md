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
- run: echo "${{ fromJSON(steps.update.outputs.result).updates[0].dependency }}"
```

It carries the run's disposition (`hasChanges`, `dryRun`), its context (`packageManager`, `workspaceRoot`, `branch`, `targetBranch`) and five collections: `updates`, `catalogDeltas`, `lockfileChanges`, `changesets` and `pullRequest`. Arrays are empty rather than omitted, so a consumer can index without guarding; `pullRequest` and `packageManager` are `null` when genuinely absent rather than carrying a placeholder.

A JSON Schema is published at `docs/schema/run-result.schema.json` and regenerated with `pnpm generate-schema`.

## Bug Fixes

**None of these produced an error.** Each was a silent wrong answer — the action reported success while quietly doing less than it claimed, so no user could have known.

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

### Outputs missing on failure paths

Every declared output is now published on every exit path. Previously a run that failed early set none of them, so a downstream `if: steps.x.outputs.has-changes == 'false'` compared against an empty string rather than `false`.

## Dependencies

| Dependency | Type | Action | From | To |
| :--- | :--- | :--- | :--- | :--- |
| @effected/schemastore | devDependency | added | — | 0.2.1 |
| tsx | devDependency | added | — | ^4.23.5 |
