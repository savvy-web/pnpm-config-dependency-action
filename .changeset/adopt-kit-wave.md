---
"silk-update-action": minor
---

## Bug Fixes

* Branch management and the post-commit working-tree sync now run at the detected workspace root. They previously ran wherever the action's process happened to be, so invoking the action from a subdirectory could resolve them against unintended repository state.
* The package-manager evidence reported in the run-context log is now the detector's own answer rather than a local re-derivation. The re-derivation could not reproduce the detector's conjunction rules, so a workspace carrying a stray lockfile could be told a confident wrong reason for a decision that was itself correct.

## Features

* Every local git operation now runs through `@effected/git`, including the explicit-refspec fetch that a single-branch `actions/checkout` requires. The action no longer runs two subprocess mechanisms for git.

## Dependencies

| Dependency | Type | Action | From | To |
| :--------- | :--- | :----- | :--- | :-- |
| @effected/workspaces | dependency | updated | 0.12.0 | 0.13.0 |
| @effected/git | dependency | updated | 0.7.0 | 0.8.0 |
| @effected/github | dependency | updated | 0.4.1 | 0.4.2 |
| @effected/github-actions | dependency | updated | 0.6.1 | 0.7.0 |
| @savvy-web/silk-effects | dependency | updated | 5.7.1 | 5.8.1 |
| @savvy-web/silk | devDependency | updated | 3.7.1 | 3.7.4 |

These move together deliberately. Each is a `0.x` package whose caret range pins the minor, so bumping one alone leaves `@savvy-web/silk-effects` on the previous minor and resolves two copies into the bundle — and two copies are two distinct `Context.Service` tags, which surfaces as a service reading unprovided in a graph that visibly provides it.

## Maintenance

* Dropped the bundler workaround comment for `@effected/workspaces`' config-dependency hooks loader; the kit now inlines its own `webpackIgnore` and a clean build emits no `Critical dependency` warning.
