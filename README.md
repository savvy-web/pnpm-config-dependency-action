# pnpm Config Dependency Action

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub Action](https://img.shields.io/badge/GitHub-Action-blue?logo=github)](https://github.com/savvy-web/pnpm-config-dependency-action)
[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-green?logo=node.js)](https://nodejs.org)

Automates updates to pnpm config dependencies and regular dependencies with
automated PR creation. Unlike Dependabot, this action supports
[pnpm config dependencies](https://pnpm.io/config-dependencies), enabling
centralized version management across monorepos.

## Features

- Updates config dependencies via `pnpm add --config` and regular dependencies
  via `pnpm up --latest` with glob pattern support
- Creates verified, signed commits through GitHub App authentication
- Integrates with Changesets for automated versioning of affected packages
- Runs custom post-update commands (linting, testing, building)
- Produces detailed PR summaries with dependency change tables

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
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: savvy-web/pnpm-config-dependency-action@main
        with:
          app-id: ${{ secrets.APP_ID }}
          app-private-key: ${{ secrets.APP_PRIVATE_KEY }}
          config-dependencies: |
            typescript
            @biomejs/biome
          dependencies: |
            effect
            @effect/*
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
| `dependencies` | No | `""` | Regular dependencies to update (one per line, supports globs) |
| `run` | No | `""` | Commands to run after updates (one per line) |
| `dry-run` | No | `false` | Detect changes without committing |
| `log-level` | No | `info` | Logging verbosity (`info` or `debug`) |
| `skip-token-revoke` | No | `false` | Skip revoking the GitHub App token on cleanup |

## Outputs

| Output | Description |
| -------- | ------------- |
| `token` | Generated GitHub App installation token |
| `pr-number` | Pull request number (if created or updated) |
| `pr-url` | Pull request URL (if created or updated) |
| `updates-count` | Number of dependencies updated |
| `has-changes` | Whether any dependencies were updated |

## Documentation

For configuration, architecture, and advanced usage, see [docs/](./docs/).

## License

[MIT](./LICENSE)
