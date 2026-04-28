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

Workspace dependencies to update, one per line. Matches against the
`dependencies`, `devDependencies`, and `optionalDependencies` fields in all
workspace `package.json` files. Supports glob patterns.

```yaml
dependencies: |
  vitest
  @savvy-web/*
```

`peerDependencies` are intentionally not matched here -- peer ranges are
managed by the [`peer-lock`](#peer-lock) and [`peer-minor`](#peer-minor) inputs
instead.

If a package lists the same dependency in multiple sections (for example, both
`dependencies` and `devDependencies`), each section is updated independently
and reported as a separate row in the PR summary.

At least one of `config-dependencies`, `dependencies`, or `update-pnpm: true`
must be active.

#### `peer-lock`

Package names whose `peerDependencies` range syncs on every version bump (patch
and minor). Must be explicit package names (no globs). Each package must also
match a `dependencies` pattern.

```yaml
peer-lock: |
  vitest-agent-reporter
```

When `vitest-agent-reporter` updates from `1.0.0` to `1.0.3`, the peer range
updates from `^1.0.0` to `^1.0.3`. The existing prefix (`^`, `~`, `>=`, etc.)
is preserved.

#### `peer-minor`

Package names whose `peerDependencies` range syncs only on minor or major
version bumps. Patch-only bumps leave the peer range unchanged. Must be explicit
package names (no globs). Each package must also match a `dependencies` pattern.

```yaml
peer-minor: |
  vitest
  @vitest/coverage-v8
```

When `vitest` updates from `3.1.0` to `3.2.5`, the peer range updates to
`^3.2.0` (patch floored to `.0`). When `vitest` updates from `3.1.0` to
`3.1.2`, the peer range stays at `^3.1.0`.

**Validation:**

- A package cannot appear in both `peer-lock` and `peer-minor` (the action
  fails with an error)
- If a `peer-lock` or `peer-minor` entry does not match any `dependencies`
  pattern, a warning is logged

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

#### `changesets`

When set to `true` and a `.changeset/` directory exists, the action creates
changesets for affected packages after dependency updates. Set to `false` to
skip changeset creation entirely, which is useful for repositories that do not
use the changeset release workflow. Default: `true`.

```yaml
changesets: false # Skip changeset creation
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

#### `auto-merge`

Enables GitHub's auto-merge on the dependency update PR after it is created.
Accepted values are `merge`, `squash`, or `rebase`, corresponding to the merge
strategy. Leave empty (the default) to disable auto-merge.

**Prerequisites:**

- The repository must have "Allow auto-merge" enabled in **Settings > General**
- Branch protection rules with required status checks must be configured on the
  base branch

If auto-merge cannot be enabled (e.g., missing prerequisites), the action logs a
warning and continues -- it does not fail the workflow.

```yaml
auto-merge: squash # Enable auto-merge with squash strategy
```

## Outputs

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
3. **Post-phase**: Revokes the token automatically

Tokens are automatically masked in workflow logs using the `ActionOutputs`
service's `setSecret()` method.

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

### Workspace Dependencies

Workspace dependencies are matched against the `dependencies`,
`devDependencies`, and `optionalDependencies` fields in all `package.json`
files. `peerDependencies` are intentionally excluded -- peer ranges are
managed by the `peer-lock` and `peer-minor` inputs.

The action queries the npm registry directly for latest versions (avoids
`pnpm up --latest` which promotes deps to catalogs when `catalogMode: strict`
is enabled). Glob patterns follow Node's `path.matchesGlob`:

| Pattern | Matches |
| --- | --- |
| `vitest` | Exact package `vitest` |
| `@effect/*` | All packages in the `@effect` scope |
| `@savvy-web/*` | All packages in the `@savvy-web` scope |

### Peer Dependency Syncing

Peer dependency ranges can be automatically synced when the corresponding
workspace dependency updates. This is controlled by the `peer-lock` and
`peer-minor` inputs.

**Why sync peers?** Published packages list peer dependencies to declare
compatibility. When you update a dependency like `vitest`, the peer range
should reflect the tested version. `devDependency` changes alone do not
trigger a release (they are stripped from published packages), but peer range
changes are consumer-facing and produce a patch changeset.

**Strategies:**

| Strategy | Behavior | Example |
| --- | --- | --- |
| `peer-lock` | Sync on every bump | `1.0.0` to `1.0.3` updates peer to `^1.0.3` |
| `peer-minor` | Sync on minor+ only | `3.1.0` to `3.1.2` leaves peer at `^3.1.0`; `3.1.0` to `3.2.0` updates to `^3.2.0` |

Version resolution follows semver naturally. If the workspace dependency
specifier is `^3.1.0`, the action resolves the latest version satisfying that
range. There is no special major-version skip rule.

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

If your repository has a `.changeset/` directory and the `changesets` input is
`true` (the default), the action creates changesets based on consumer-facing
changes. A workspace package gets a `patch` changeset only when **both** gates
pass:

1. **Trigger gate** -- at least one consumer-facing change must apply to the
   package:
   - `peerDependency` range update (from `peer-lock` or `peer-minor` syncing)
   - `dependency` or `optionalDependency` change detected in the lockfile

   `devDependency`-only changes are informational rows in the changeset table
   when a sibling trigger exists, but never trigger a changeset on their own
   (dev dependencies are stripped from published packages).

2. **Versionable gate** -- the package must be versionable:
   - **Publishable** packages (detected by `workspaces-effect`'s
     `PublishabilityDetector` -- non-private, or with a `publishConfig`
     targeting a registry), or
   - Private packages opted in via the `versionPrivate` changeset config

   Private packages that are not versionable are skipped silently.

Changeset tables include all changes for a package -- both triggers and
informational dev rows -- using specific type values: `dependency`,
`optionalDependency`, `peerDependency`, `devDependency`. Empty changesets are
not written; config-only updates (`pnpm-workspace.yaml` `configDependencies`)
do not produce a changeset.

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

### Auto-Merge with Squash

Automatically merge the dependency PR once status checks pass:

```yaml
- uses: savvy-web/pnpm-config-dependency-action@main
  with:
    app-id: ${{ secrets.APP_ID }}
    app-private-key: ${{ secrets.APP_PRIVATE_KEY }}
    config-dependencies: |
      typescript
    auto-merge: squash
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
