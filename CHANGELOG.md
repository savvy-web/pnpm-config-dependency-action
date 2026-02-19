# pnpm-config-dependency-action

## 0.5.1

### Bug Fixes

* [`c223a90`](https://github.com/savvy-web/pnpm-config-dependency-action/commit/c223a9077669478c82f4c7783cf51cca35cb6f45) Supports @savvy-web/vitest

## 0.5.0

### Bug Fixes

* [`e36fba1`](https://github.com/savvy-web/pnpm-config-dependency-action/commit/e36fba14758a90bd7b98d83b842170d7151f695b) Fix missing dependency detection for catalog resolved version changes.

When a clean install resolves a newer version within the same semver range (e.g., `^2.8.4` stays unchanged but resolves `2.8.6` to `2.8.7`), the action now correctly detects and reports the change. Previously, `compareCatalogs()` only compared the `specifier` field of catalog entries, ignoring the `version` (resolved) field. This caused changes that stayed within the declared semver range to fall through both the catalog and importer comparison paths undetected, resulting in 0 reported changes and an empty PR body.

The fix compares both `specifier` and `version` fields of `ResolvedCatalogEntry`. When only the resolved version changed, the reported from/to values use the concrete resolved versions (e.g., `2.8.6` to `2.8.7`). When the specifier itself changed, existing behavior is preserved (e.g., `^2.8.4` to `^2.9.0`).

## 0.4.0

### Minor Changes

* 85f1c06: Add `changesets` input option (default: `true`) to control whether changesets are created during dependency updates. When set to `false`, the action skips changeset creation, which is useful for repos that don't need the release cycle and just want a dependency update PR.

## 0.3.0

### Minor Changes

* 127b7b6: Add auto-merge support for dependency update PRs. A new `auto-merge` input
  accepts `merge`, `squash`, or `rebase` to enable GitHub's auto-merge via the
  GraphQL API after PR creation. Failures are handled gracefully with a warning
  log, requiring repository-level "Allow auto-merge" and branch protection to
  be configured.

## 0.2.0

### Minor Changes

* eec6269: Add pnpm self-upgrade step that detects pnpm versions from `packageManager` and `devEngines.packageManager` fields in root `package.json`, resolves the latest version within the `^` semver range, and upgrades via `corepack use`. Controlled by the new `update-pnpm` input (default: `true`). The upgrade runs before config dependency updates and is reported alongside them in the PR body.

## 0.1.0

### Minor Changes

* 826309a: Initial release of the pnpm Config Dependency Action.

  A GitHub Action that automates updates to pnpm config dependencies and regular
  dependencies, filling the gap left by Dependabot's lack of support for pnpm's
  `configDependencies` feature in `pnpm-workspace.yaml`.

  ### Features

  * **Config dependency updates**: Updates config dependencies via `pnpm add --config`,
    tracking version changes with before/after comparison
  * **Regular dependency updates**: Updates regular dependencies via `pnpm up --latest`
    with glob pattern support (e.g., `effect`, `@effect/*`, `@savvy-web/*`)
  * **Custom post-update commands**: Execute commands after dependency updates via the
    `run` input (e.g., `pnpm lint:fix`, `pnpm test`). All commands run sequentially;
    if any fail, the job fails and no PR is created
  * **Changeset integration**: Automatically creates patch changesets for affected
    packages, with empty changesets for root workspace config dependency updates
  * **Verified commits**: Creates signed/verified commits via the GitHub API using
    GitHub App authentication (no SSH or GPG keys required)
  * **Branch management**: Manages a dedicated update branch with automatic creation
    or reset to the default branch on each run
  * **Lockfile diffing**: Compares `pnpm-lock.yaml` snapshots before and after updates
    to detect actual dependency changes, including catalog entry tracing to identify
    affected workspace packages
  * **Detailed PR summaries**: Generates Dependabot-style PR descriptions with
    dependency tables, npm links, and per-package changeset details
  * **GitHub App authentication**: Uses short-lived installation tokens with
    fine-grained permissions for secure automation
  * **Check run integration**: Creates GitHub check runs for visibility into action
    progress and results
  * **Dry-run mode**: Detect changes without committing, pushing, or creating PRs
  * **Debug logging**: Configurable log levels for troubleshooting

  ### Architecture

  Built with Effect-TS for typed error handling, retry logic, and service-based
  dependency injection. Uses a three-phase execution model (pre/main/post) with
  13 orchestration steps in the main phase.
