# pnpm Config Dependency Action

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub Action](https://img.shields.io/badge/GitHub-Action-blue?logo=github)](https://github.com/savvy-web/pnpm-config-dependency-action)
[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-green?logo=node.js)](https://nodejs.org)

Automates updates to pnpm config dependencies, workspace dependencies, and peer
dependency ranges with automated PR creation. Unlike Dependabot, this action
supports [pnpm config dependencies](https://pnpm.io/config-dependencies),
enabling centralized version management across monorepos.

## Features

- Updates config dependencies via direct npm queries and YAML editing
- Updates workspace dependencies (across `dependencies`, `devDependencies`, and
  `optionalDependencies`) via direct npm registry queries with glob pattern support
- Syncs peer dependency ranges with configurable lock/minor strategies
- Creates verified, signed commits through GitHub App authentication
- Integrates with Changesets for automated versioning of affected packages
- Runs custom post-update commands (linting, testing, building)
- Produces detailed per-package PR summaries with dependency change tables

## Quick Start

```yaml
name: Update Dependencies
on:
  schedule:
    - cron: "0 6 * * 1" # Weekly on Monday at 6am
  workflow_dispatch:

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v4
      - uses: savvy-web/pnpm-config-dependency-action@main
        with:
          app-id: ${{ secrets.APP_ID }}
          app-private-key: ${{ secrets.APP_PRIVATE_KEY }}
          config-dependencies: |
            typescript
            @biomejs/biome
          dependencies: |
            vitest
            @savvy-web/*
          peer-lock: |
            vitest-agent-reporter
          peer-minor: |
            vitest
          run: |
            pnpm lint:fix
            pnpm test
```

## Inputs

| Input | Required | Default | Description |
| ------- | ---------- | --------- | ------------- |
| `app-id` | Yes | -- | GitHub App ID for authentication |
| `app-private-key` | Yes | -- | GitHub App private key (PEM format) |
| `branch` | No | `pnpm/config-deps` | Branch name for the update PR |
| `config-dependencies` | No | `""` | Config dependencies to update (one per line) |
| `dependencies` | No | `""` | Workspace dependencies to update across `dependencies`, `devDependencies`, and `optionalDependencies` (one per line, supports globs) |
| `peer-lock` | No | `""` | Peer ranges that sync on every version bump (one per line) |
| `peer-minor` | No | `""` | Peer ranges that sync on minor+ bumps only (one per line) |
| `update-pnpm` | No | `true` | Update pnpm version |
| `run` | No | `""` | Commands to run after updates (one per line) |
| `changesets` | No | `true` | Create changesets when `.changeset/` exists |
| `dry-run` | No | `false` | Detect changes without committing |
| `log-level` | No | `auto` | Logging verbosity |
| `timeout` | No | `180` | Maximum time in seconds before cancelling |
| `auto-merge` | No | `""` | Enable auto-merge (`merge`, `squash`, or `rebase`) |

## Outputs

| Output | Description |
| -------- | ------------- |
| `pr-number` | Pull request number (if created or updated) |
| `pr-url` | Pull request URL (if created or updated) |
| `updates-count` | Number of dependencies updated |
| `has-changes` | Whether any dependencies were updated |

## Documentation

For configuration, architecture, and advanced usage, see [docs](./docs/).

## License

[MIT](./LICENSE)
