---
"silk-update-action": patch
---

## Bug Fixes

* Changeset dependency tables no longer escape version specifiers or package names. A `~0.2.0` specifier was previously written as `\~0.2.0`, and a package named `some_pkg` as `some\_pkg`, because table cells were passed through a markdown stringifier that escaped anything capable of opening a markdown construct. Fixed by bumping `@savvy-web/silk-effects` to `4.2.5`.
* Dependency and peer bumps flowing through a hook-injected pnpm catalog (e.g. a catalog like `catalog:effect:peers` injected by a config-dependency `pnpmfile` rather than declared inline in `pnpm-workspace.yaml`) now produce a changeset. Previously both sides of the diff fell back to the same raw, unresolved specifier, compared equal, and the action silently wrote zero changesets even though the dependency had moved. Fixed by bumping `@effected/workspaces` to `0.7.0` (consumed via `@savvy-web/silk-effects` 4.2.5).

Neither fix changes any `action.yml` input or output — no workflow changes are required to benefit.
