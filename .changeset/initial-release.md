---
"pnpm-config-dependency-action": minor
---

Initial release of the pnpm Config Dependency Action.

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
