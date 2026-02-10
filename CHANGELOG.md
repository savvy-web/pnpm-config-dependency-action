# pnpm-config-dependency-action

## 0.4.0

### Minor Changes

- 9f4786b: Add auto-merge support for dependency update PRs. A new `auto-merge` input
  accepts `merge`, `squash`, or `rebase` to enable GitHub's auto-merge via the
  GraphQL API after PR creation. Failures are handled gracefully with a warning
  log, requiring repository-level "Allow auto-merge" and branch protection to
  be configured.

## 0.3.0

### Minor Changes

- 127b7b6: Add auto-merge support for dependency update PRs. A new `auto-merge` input
  accepts `merge`, `squash`, or `rebase` to enable GitHub's auto-merge via the
  GraphQL API after PR creation. Failures are handled gracefully with a warning
  log, requiring repository-level "Allow auto-merge" and branch protection to
  be configured.

## 0.2.0

### Minor Changes

- eec6269: Add pnpm self-upgrade step that detects pnpm versions from `packageManager` and `devEngines.packageManager` fields in root `package.json`, resolves the latest version within the `^` semver range, and upgrades via `corepack use`. Controlled by the new `update-pnpm` input (default: `true`). The upgrade runs before config dependency updates and is reported alongside them in the PR body.

## 0.1.0

### Minor Changes

- 826309a: Initial release of the pnpm Config Dependency Action.

  A GitHub Action that automates updates to pnpm config dependencies and regular
  dependencies, filling the gap left by Dependabot's lack of support for pnpm's
  `configDependencies` feature in `pnpm-workspace.yaml`.

  ### Features

  - **Config dependency updates**: Updates config dependencies via `pnpm add --config`,
    tracking version changes with before/after comparison
  - **Regular dependency updates**: Updates regular dependencies via `pnpm up --latest`
    with glob pattern support (e.g., `effect`, `@effect/*`, `@savvy-web/*`)
  - **Custom post-update commands**: Execute commands after dependency updates via the
    `run` input (e.g., `pnpm lint:fix`, `pnpm test`). All commands run sequentially;
    if any fail, the job fails and no PR is created
  - **Changeset integration**: Automatically creates patch changesets for affected
    packages, with empty changesets for root workspace config dependency updates
  - **Verified commits**: Creates signed/verified commits via the GitHub API using
    GitHub App authentication (no SSH or GPG keys required)
  - **Branch management**: Manages a dedicated update branch with automatic creation
    or reset to the default branch on each run
  - **Lockfile diffing**: Compares `pnpm-lock.yaml` snapshots before and after updates
    to detect actual dependency changes, including catalog entry tracing to identify
    affected workspace packages
  - **Detailed PR summaries**: Generates Dependabot-style PR descriptions with
    dependency tables, npm links, and per-package changeset details
  - **GitHub App authentication**: Uses short-lived installation tokens with
    fine-grained permissions for secure automation
  - **Check run integration**: Creates GitHub check runs for visibility into action
    progress and results
  - **Dry-run mode**: Detect changes without committing, pushing, or creating PRs
  - **Debug logging**: Configurable log levels for troubleshooting

  ### Architecture

  Built with Effect-TS for typed error handling, retry logic, and service-based
  dependency injection. Uses a three-phase execution model (pre/main/post) with
  13 orchestration steps in the main phase.
