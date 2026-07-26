---
"silk-update-action": minor
---

## Bug Fixes

### `upgrade-package-manager` now defaults to `"false"`

Leaving `upgrade-package-manager` unset used to imply `"true"` — the action would
upgrade the detected package manager (pnpm/bun/npm) on every run. It now defaults
to `"false"`, matching the opt-in behavior of the `upgrade-runtime-*` inputs.

Workflows that relied on the implicit default must now set the input explicitly:

```yaml
- uses: savvy-web/silk-update-action@v5
  with:
    upgrade-package-manager: "true" # or "auto", or an explicit semver range
```

A workflow that configures no update type at all (no `config-dependencies`, no
`dependencies`, no `upgrade-package-manager`, no `upgrade-runtime-*`) now fails
fast with `At least one update type must be active` instead of silently running
a package-manager-only upgrade.

### Malformed inputs now fail instead of falling back to defaults

Input values are read through a proper input layer rather than a plain config
lookup. A typo like `dry-run: maybe` used to be silently treated as `dry-run:
false` — running for real when a dry run was intended — and is now a hard
failure. Inputs that are genuinely absent still take their documented defaults;
only malformed *present* values are rejected.

## Refactoring

Migrated the action off the now-deleted `@savvy-web/github-action-effects`
library onto the `@effected/*` kit (`github-actions`, `github`, `commands`,
`npm`) plus `@savvy-web/silk-effects` 5.0.0. All action inputs are now read
through the kit's `ActionInput` accessors — the mechanism behind both breaking
changes above.

Consequences for consumers:

* The `pre`/`post` bundles are roughly 20% smaller (the previous octokit
  auth-app strategy is no longer bundled).
* Bundled third-party license attribution is restored inline in the built
  `dist` output.
* Test suite relocated to `__test__/unit/**` and partially converted to
  `@effect/vitest`; the documented multi-value input grammar (bulleted lists,
  JSON arrays, comma-separated values) is unchanged and still enforced by tests.

## Dependencies

| Dependency | Type | Action | From | To |
| :--- | :--- | :--- | :--- | :--- |
| @savvy-web/github-action-effects | dependency | removed | ^3.1.0 | — |
| @effected/commands | dependency | added | — | ^0.1.0 |
| @effected/github | dependency | added | — | ^0.1.0 |
| @effected/github-actions | dependency | added | — | ^0.1.0 |
| @effected/lockfiles | dependency | updated | ^0.2.0 | ^0.2.1 |
| @effected/npm | dependency | updated | ^0.4.0 | ^0.5.0 |
| @effected/workspaces | dependency | updated | ^0.8.0 | ^0.9.0 |
| @savvy-web/silk-effects | dependency | updated | ^4.2.6 | ^5.0.0 |
| @effect/vitest | devDependency | added | — | 4.0.0-beta.101 |
| @savvy-web/github-action-builder | devDependency | updated | ^2.0.6 | ^2.1.0 |
| @savvy-web/silk | devDependency | updated | ^3.2.3 | ^3.2.4 |
