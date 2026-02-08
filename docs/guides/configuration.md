# Configuration

Complete reference for all action inputs, outputs, and usage patterns.

## Table of Contents

- [Inputs](#inputs)
- [Outputs](#outputs)
- [Authentication](#authentication)
- [Dependency Selection](#dependency-selection)
- [Post-Update Commands](#post-update-commands)
- [Branch Management](#branch-management)
- [Changeset Integration](#changeset-integration)
- [Advanced Patterns](#advanced-patterns)

## Inputs

### Required Inputs

#### `app-id`

The numeric ID of your GitHub App. Found on the GitHub App settings page.

#### `app-private-key`

The private key for your GitHub App in PEM format. Generate this from the GitHub
App settings page and store it as a repository secret.

### Optional Inputs

#### `config-dependencies`

Config dependencies to update, one per line. These correspond to entries in your
`pnpm-workspace.yaml` `configDependencies` section. Each line must be an exact
package name (no glob patterns).

```yaml
config-dependencies: |
  typescript
  @biomejs/biome
```

#### `dependencies`

Regular dependencies to update, one per line. Supports glob patterns for
matching multiple packages.

```yaml
dependencies: |
  effect
  @effect/*
  @savvy-web/*
```

At least one of `config-dependencies` or `dependencies` must be specified.

#### `branch`

The branch name used for the dependency update PR. Default: `pnpm/config-deps`.

The action creates this branch from `main` if it does not exist, or resets it to
`main` before applying updates.

```yaml
branch: deps/weekly-update
```

#### `run`

Shell commands to run after dependency updates, one per line. All commands are
executed sequentially. If any command fails, the action stops and does not create
a PR.

```yaml
run: |
  pnpm lint:fix
  pnpm test
  pnpm build
```

#### `update-pnpm`

When set to `true`, the action checks for a newer pnpm version and updates the
`packageManager` and `devEngines` fields in `package.json` if one is available.
The version change is tracked as a config dependency update. Default: `true`.

```yaml
update-pnpm: false # Disable automatic pnpm upgrades
```

#### `dry-run`

When set to `true`, the action detects changes and reports them in the GitHub
Actions summary but does not commit, push, or create a PR. Useful for testing
configuration. Default: `false`.

#### `log-level`

Controls logging verbosity. Default: `info`.

- `info` -- Standard logging with step progress
- `debug` -- Verbose logging with detailed state dumps (lockfile structure, git
  status, parsed inputs)

#### `skip-token-revoke`

When set to `true`, the GitHub App installation token is not revoked during
cleanup. The token expires automatically after 1 hour regardless. Default:
`false`.

## Outputs

### `token`

The generated GitHub App installation token. Can be used in subsequent workflow
steps for authenticated API calls.

### `pr-number`

The pull request number, if a PR was created or updated. Empty if no PR was
created (e.g., no changes detected or dry-run mode).

### `pr-url`

The pull request URL. Empty if no PR was created.

### `updates-count`

The number of dependencies that were updated (string).

### `has-changes`

Whether any dependency changes were detected (`"true"` or `"false"`).

### Using Outputs

```yaml
- uses: savvy-web/pnpm-config-dependency-action@main
  id: update-deps
  with:
    app-id: ${{ secrets.APP_ID }}
    app-private-key: ${{ secrets.APP_PRIVATE_KEY }}
    config-dependencies: |
      typescript

- name: Comment on PR
  if: steps.update-deps.outputs.has-changes == 'true'
  run: |
    echo "PR created: ${{ steps.update-deps.outputs.pr-url }}"
    echo "Updates: ${{ steps.update-deps.outputs.updates-count }}"
```

## Authentication

The action uses GitHub App authentication for secure, short-lived tokens:

1. **Pre-phase**: Generates a JWT from the app credentials, exchanges it for an
   installation token
2. **Main phase**: Uses the installation token for all GitHub API calls
3. **Post-phase**: Revokes the token (unless `skip-token-revoke` is set)

Tokens are automatically masked in workflow logs using `@actions/core`
`setSecret()`.

## Dependency Selection

### Config Dependencies

[Config dependencies](https://pnpm.io/config-dependencies) are declared in
`pnpm-workspace.yaml` and provide workspace-level tooling. They are updated with
`pnpm add --config <package>`.

```yaml
# pnpm-workspace.yaml
configDependencies:
  typescript: 5.4.0
  "@biomejs/biome": 1.6.1
```

### Regular Dependencies

Regular dependencies in workspace packages are updated with
`pnpm up <pattern> --latest`. Glob patterns follow pnpm's matching rules:

| Pattern | Matches |
| --- | --- |
| `effect` | Exact package `effect` |
| `@effect/*` | All packages in the `@effect` scope |
| `@savvy-web/*` | All packages in the `@savvy-web` scope |

## Post-Update Commands

Commands specified in the `run` input execute after all dependency updates and
`pnpm install`. Use them to fix formatting, run tests, or rebuild.

- Commands run sequentially in the order listed
- All commands are attempted even if earlier ones fail
- If any command fails, the action reports the failure, updates the check run
  with an error status, and exits without creating a PR
- Commands are executed via `sh -c`, so shell features are available

## Branch Management

The action manages a dedicated branch for dependency updates:

1. If the branch does not exist, it is created from `main`
2. If the branch exists, it is deleted and recreated from `main` to ensure a
   clean state
3. Changes are committed via the GitHub API (not `git commit`) to produce
   verified/signed commits
4. The branch ref is updated directly using the Git Data API

This approach ensures the PR always shows a clean diff against `main` with only
the dependency changes.

## Changeset Integration

If your repository has a `.changeset/` directory, the action automatically
creates changesets for affected packages:

- **Regular dependency changes**: A `patch` changeset is created for each
  workspace package whose dependencies changed
- **Config dependency changes**: An empty changeset (no packages) is created to
  record the update

Changeset summaries include the dependency name and version change for each
affected package.

## Advanced Patterns

### Separate Config and Regular Updates

Run the action twice in the same workflow with different branches:

```yaml
- uses: savvy-web/pnpm-config-dependency-action@main
  with:
    app-id: ${{ secrets.APP_ID }}
    app-private-key: ${{ secrets.APP_PRIVATE_KEY }}
    branch: deps/config
    config-dependencies: |
      typescript
      @biomejs/biome

- uses: savvy-web/pnpm-config-dependency-action@main
  with:
    app-id: ${{ secrets.APP_ID }}
    app-private-key: ${{ secrets.APP_PRIVATE_KEY }}
    branch: deps/regular
    dependencies: |
      effect
      @effect/*
```

### Conditional Updates

Use outputs to gate subsequent steps:

```yaml
- uses: savvy-web/pnpm-config-dependency-action@main
  id: deps
  with:
    app-id: ${{ secrets.APP_ID }}
    app-private-key: ${{ secrets.APP_PRIVATE_KEY }}
    dependencies: |
      effect

- name: Notify Slack
  if: steps.deps.outputs.has-changes == 'true'
  uses: slackapi/slack-github-action@v2
  with:
    payload: |
      {"text": "Dependency PR created: ${{ steps.deps.outputs.pr-url }}"}
```
