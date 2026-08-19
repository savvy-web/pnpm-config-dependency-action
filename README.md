# Silk Update Action

[![License: MIT](https://img.shields.io/badge/License-MIT-4caf50.svg)](https://opensource.org/licenses/MIT)
[![GitHub Action](https://img.shields.io/badge/GitHub-Action-blue?logo=github)](https://github.com/savvy-web/silk-update-action)
[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-green?logo=node.js)](https://nodejs.org)

A GitHub Action that updates pnpm config dependencies, workspace dependencies and peer dependency ranges, then opens a pull request with the changes. Dependabot does not understand [pnpm config dependencies](https://pnpm.io/config-dependencies), which is where this action fills the gap — it keeps versions centralized across a monorepo.

## Features

- Updates config dependencies via direct npm queries and YAML editing, staying within a conservative range of the current major
- Updates workspace dependencies (across `dependencies`, `devDependencies`, and `optionalDependencies`) within the semver ranges declared in `package.json`, with glob pattern support
- Honors pnpm's [`minimumReleaseAge`](https://pnpm.io/settings#minimumreleaseage) gate at resolution time, holding back versions published inside the age window instead of proposing an update the install step would reject
- Syncs peer dependency ranges with configurable lock/minor strategies
- Creates verified, signed commits through GitHub App authentication, signed off as the App's own bot identity
- Integrates with Changesets for automated versioning of affected packages
- Runs custom post-update commands (linting, testing, building)
- Produces detailed per-package PR summaries with dependency change tables

## Quick start

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
      - uses: actions/checkout@v7
        with:
          # Full history is required when changesets are enabled: the changeset
          # step diffs against the base branch (merge-base), which a shallow
          # (fetch-depth: 1) checkout cannot resolve.
          fetch-depth: 0
      - uses: pnpm/action-setup@v4
      - uses: savvy-web/silk-update-action@v4
        with:
          app-client-id: ${{ secrets.APP_CLIENT_ID }}
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

At least one update type must be active: `config-dependencies`, `dependencies`, a non-`false` `upgrade-package-manager`, or one of the `upgrade-runtime-*` inputs. A workflow that configures none of them fails with `At least one update type must be active`.

Values are validated as they are read. An input whose value cannot be parsed — a non-boolean `dry-run`, a non-integer `timeout`, a `runtime-data` outside `offline`/`live`, an `upgrade-*` value that is neither a keyword nor a semver range — fails the run rather than falling back to its default. Omitting an input still takes the documented default.

| Input | Required | Default | Description |
| ------- | ---------- | --------- | ------------- |
| `app-client-id` | Yes | -- | GitHub App client ID for authentication |
| `app-private-key` | Yes | -- | GitHub App private key (PEM format) |
| `branch` | No | `pnpm/config-deps` | Branch name for the update PR |
| `source-branch` | No | `main` | Branch the update branch is created from and reset to; the PR also targets it unless `target-branch` is set |
| `target-branch` | No | `""` | Branch the PR merges into; leave empty to follow `source-branch` |
| `config-dependencies` | No | `""` | Config dependencies to update (one per line) |
| `dependencies` | No | `""` | Workspace dependencies to update across `dependencies`, `devDependencies`, and `optionalDependencies` (one per line, supports globs) |
| `peer-lock` | No | `""` | Peer ranges that sync on every version bump (one per line) |
| `peer-minor` | No | `""` | Peer ranges that sync on minor+ bumps only (one per line) |
| `upgrade-package-manager` | No | `false` | Upgrade the detected package manager (pnpm, bun or npm) — hash-pinned for the corepack-managed ones (pnpm, npm), bare for bun: `false`, `true`/`auto`, or a semver range (e.g. `^11`) for the detected manager |
| `upgrade-runtime-node` | No | `false` | Upgrade the Node.js entry in `devEngines.runtime` (never adds a missing entry; always writes an exact version): `false`, `auto`, or a semver range (e.g. `^22`) |
| `upgrade-runtime-deno` | No | `false` | Upgrade the Deno entry in `devEngines.runtime` (never adds a missing entry; always writes an exact version): `false`, `auto`, or a semver range (e.g. `^2`) |
| `upgrade-runtime-bun` | No | `false` | Upgrade the Bun entry in `devEngines.runtime` (never adds a missing entry; always writes an exact version): `false`, `auto`, or a semver range (e.g. `^1`) |
| `runtime-data` | No | `offline` | Runtime version data source: `offline` (bundled cache) or `live` (fetch latest, fall back to cache) |
| `run` | No | `""` | Commands to run after updates (one per line) |
| `changesets` | No | `true` | Create changesets when `.changeset/` exists. Requires a full-history checkout (`fetch-depth: 0`) so the base-branch diff can be computed |
| `dry-run` | No | `false` | Detect changes without committing |
| `timeout` | No | `180` | Maximum time in seconds before cancelling |
| `auto-merge` | No | `""` | Enable auto-merge (`merge`, `squash`, or `rebase`) |

## Outputs

| Output | Description |
| -------- | ------------- |
| `pr-number` | Pull request number (if created or updated) |
| `pr-url` | Pull request URL (if created or updated) |
| `updates-count` | Number of dependencies updated |
| `has-changes` | Whether any dependencies were updated |
| `result` | The whole run as a JSON document ([schema](./docs/schema/run-result.schema.json)) |

Every output is set on every exit path. `result` is always valid JSON — a run that did nothing publishes an empty-run document rather than an empty string, so a consuming step can call `fromJSON()` without guarding. See [Configuration](./docs/02-configuration.md#result).

## Authentication

The action authenticates as a GitHub App. It runs in three phases: a pre step provisions a short-lived installation token, the main step performs the dependency updates and the post step revokes the token. Tokens are revoked automatically once the run completes.

> [!IMPORTANT]
> The `app-id` input has been renamed to `app-client-id`. Update your workflow and pass the App's client ID rather than its numeric App ID.

The App needs `contents: write`, `pull-requests: write` and `checks: write` permissions. The pre step verifies these up front, so a failure before any updates run usually means the App is missing one of these scopes.

## Documentation

- [Getting started](./docs/01-getting-started.md) — Set up the action in your repository from scratch.
- [Configuration](./docs/02-configuration.md) — Every input, output and usage pattern.
- [GitHub App setup](./docs/03-github-app-setup.md) — Create and configure the required GitHub App.
- [Architecture overview](./docs/04-architecture.md) — The three phases and what the main update workflow does.
- [Execution phases](./docs/05-execution-phases.md) — Step-by-step breakdown of the main-phase workflow.
- [Troubleshooting](./docs/06-troubleshooting.md) — Common issues and their solutions.

## License

[MIT](LICENSE)
