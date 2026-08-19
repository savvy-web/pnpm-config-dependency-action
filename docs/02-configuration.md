# Configuration

Complete reference for all action inputs, outputs and usage patterns.

## Table of contents

- [Inputs](#inputs)
- [Outputs](#outputs)
- [Authentication](#authentication)
- [Dependency selection](#dependency-selection)
- [Post-update commands](#post-update-commands)
- [Branch management](#branch-management)
- [Changeset integration](#changeset-integration)
- [Advanced patterns](#advanced-patterns)

## Inputs

### Input value formats

Every input is read and validated before any update runs. Omitting an input takes the default documented below, but supplying a value that cannot be parsed fails the run — a `dry-run` of `maybe`, a `timeout` of `soon`, a `runtime-data` of `cached`, or an `upgrade-runtime-node` of `not-a-range` each abort with an error naming the input, rather than silently falling back to the default.

At least one update type must be active: `config-dependencies`, `dependencies`, a non-`false` `upgrade-package-manager`, or one of the `upgrade-runtime-*` inputs. Since every one of those defaults to off, a workflow that configures none of them fails with `At least one update type must be active`.

The multi-value inputs — `config-dependencies`, `dependencies`, `peer-lock`, `peer-minor` and `run` — accept four forms, and any combination of them in the same value:

- A newline-separated list, one entry per line.
- A newline-separated list with `-` or `*` bullets, so a YAML block scalar can read like a list.
- A JSON array, for example `["vitest", "@savvy-web/*"]`.
- A comma-separated list, for example `vitest, @savvy-web/*`.

An entry whose first character is `#` is a comment and is dropped; blank entries are ignored. A bullet marker is stripped only after the comment check, so `- #tag` is the value `#tag` rather than a comment. These two inputs produce the same list:

```yaml
dependencies: |
  # test tooling
  - vitest
  - @savvy-web/*
```

```yaml
dependencies: '["vitest", "@savvy-web/*"]'
```

### Required inputs

#### `app-client-id`

The client ID of your GitHub App. Found on the GitHub App settings page. This is the App's client ID, not its numeric App ID.

#### `app-private-key`

The private key for your GitHub App in PEM format. Generate this from the GitHub
App settings page and store it as a repository secret.

### Optional inputs

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
`dependencies`, `devDependencies` and `optionalDependencies` fields in all
workspace `package.json` files. Supports glob patterns.

```yaml
dependencies: |
  vitest
  @savvy-web/*
```

`peerDependencies` are intentionally not matched here — peer ranges are
managed by the [`peer-lock`](#peer-lock) and [`peer-minor`](#peer-minor) inputs
instead.

If a package lists the same dependency in multiple sections (for example, both
`dependencies` and `devDependencies`), each section is updated independently
and reported as a separate row in the PR summary.

At least one of `config-dependencies`, `dependencies`, a non-`false`
`upgrade-package-manager`, or an `upgrade-runtime-*` input must be active.

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

The action creates this branch from the source branch if it does not exist, or resets it to the source branch before applying updates (see [`source-branch`](#source-branch)).

```yaml
branch: deps/weekly-update
```

#### `source-branch`

The branch the update branch is created from and reset to on each run. Default: `main`. The pull request also targets this branch unless [`target-branch`](#target-branch) overrides it. Both refs are validated before the destructive branch reset — a missing ref fails the run early.

```yaml
source-branch: dev
```

#### `target-branch`

The branch the pull request merges into. Default: empty, which follows `source-branch`. Set it only to target a different branch than the one the update was cut from — for example, cut from `dev` but merge into `main`. When changesets are enabled, this branch is also the baseline for the changeset diff.

```yaml
source-branch: dev
target-branch: main
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

#### `upgrade-package-manager`

Upgrades the package manager **detected for this workspace** — pnpm, bun or npm
— declared in the `packageManager` and `devEngines.packageManager` fields of the
root `package.json`. Values: `false` (skip), `true`/`auto` (latest within the
current major, favoring the `devEngines` version), or a semver range (e.g. `^11`,
which may cross majors and adds a `packageManager` field when none exists). The
version change is tracked as a config dependency update. Default: `false`.

The upgrade is opt-in, matching the `upgrade-runtime-*` inputs: leaving this input unset means the package manager is left alone. Workflows that relied on the earlier implicit upgrade need to set `true`, `auto` or a range explicitly.

The current version is read from either field as a package-manager pin. A `devEngines.packageManager.version` carrying a range (`^11.0.0`) is accepted and still anchors an `auto` upgrade, because the reference is only ever the anchor a target range is synthesized from. A value that is not a parseable pin — a truncated version, a trailing typo — is reported as no reference found, rather than being read as a version that then satisfies nothing.

pnpm and npm are managed by corepack, so their resolved version is written
hash-pinned (`pnpm@11.0.0+sha512.<hex>`). corepack does not manage bun, so bun is
written as a bare version.

The hash comes from the registry's integrity metadata and is checked before it is written. When the registry supplies no integrity, or one that does not decode to a well-formed SHA-512 digest, the action writes the bare version with a warning instead of a pin that corepack would reject at install time in your repository.

An explicit range is resolved against the **detected** package manager's release
list. A range typed for a different manager (a pnpm-shaped `^11` in a bun repo)
satisfies nothing and is skipped with a warning naming the mismatch.

A package-manager bump also triggers the lockfile regeneration step, whose install
performs the corepack switch to the new version (pnpm, npm).

```yaml
upgrade-package-manager: auto # Latest within the current major
```

#### `upgrade-runtime-node`

Upgrade the Node.js entry in `devEngines.runtime`. Three modes:

- `false` (default) — skip; Node.js runtime is not touched
- `auto` — resolve the latest version within the existing entry's range; no-op if the entry is a static exact pin, if no entry exists, or if the resolved version already matches the current value
- A semver range (e.g. `^22`) — resolve the latest version satisfying that range; the range selects which line to move to and nothing more

In both modes the action **upgrades only an entry the manifest already declares** — it never adds one, and skips with a warning naming the runtime when no entry exists. The resolved version is always written **exact**, with no range operator: an existing `^24.0.0` becomes `24.9.1`, not `^24.9.1`. Downstream consumers of `devEngines.runtime` (such as `silk-runtime-action`) reject range operators, so an operator written here would be a latent failure later in the pipeline.

```yaml
upgrade-runtime-node: auto
```

> **EOL note:** Version resolution only covers currently-maintained (non
> end-of-life) major lines. If the existing entry or an explicit range targets
> an EOL line (e.g. `^20` after Node 20 reaches EOL), resolution fails and the
> runtime bump is skipped with a warning. This applies to both offline and live
> data sources.

#### `upgrade-runtime-deno`

Upgrade the Deno entry in `devEngines.runtime`. Accepts the same values as
`upgrade-runtime-node` (`false`, `auto`, or a semver range such as `^2`).
Default: `false`.

```yaml
upgrade-runtime-deno: auto
```

#### `upgrade-runtime-bun`

Upgrade the Bun entry in `devEngines.runtime`. Accepts the same values as
`upgrade-runtime-node` (`false`, `auto`, or a semver range such as `^1`).
Default: `false`.

```yaml
upgrade-runtime-bun: ^1
```

#### `runtime-data`

Data source used by the runtime version resolver. Default: `offline`.

- `offline` — use only the bundled runtime version cache; no network access
  or authentication required
- `live` — fetch the latest runtime data from the network, falling back to the
  bundled cache on failure

These are the only accepted values. Any other value fails the run naming the input, rather than falling back to `offline`. The fallback described here applies to a `live` *fetch* that fails at runtime, not to an unrecognized input value.

```yaml
runtime-data: live
```

**Example — auto-upgrade Node.js and Deno using the existing ranges:**

If your root `package.json` contains:

```json
{
  "devEngines": {
    "runtime": [
      { "name": "node", "version": "^24.0.0", "onFail": "ignore" },
      { "name": "deno", "version": "^2.0.0", "onFail": "ignore" }
    ]
  }
}
```

With this configuration:

```yaml
upgrade-runtime-node: auto
upgrade-runtime-deno: auto
```

The action resolves the latest Node.js `^24` and Deno `^2` versions (within maintained lines) and rewrites the `version` fields to the exact resolved versions — e.g. `24.16.0` and `2.1.0` — dropping the `^` and preserving the `onFail` field. The bump is included in the PR summary and commit message. It does not trigger a changeset and does not run `pnpm install`.

#### `changesets`

When set to `true` and a `.changeset/` directory exists, the action regenerates
a consolidated dependency changeset for each affected package after the updates.
Set to `false` to skip changeset creation entirely, which is useful for
repositories that do not use the changeset release workflow. Default: `true`.

```yaml
changesets: false # Skip changeset creation
```

The changeset step diffs the working tree against the base branch, so the
checkout must include full history. Set `fetch-depth: 0` on `actions/checkout`
when changesets are enabled — a shallow checkout cannot resolve the merge-base
and the changeset content will be wrong or empty.

#### `dry-run`

When set to `true`, the action detects changes and reports them in the GitHub
Actions summary but does not commit, push or create a PR. Useful for testing
configuration. Default: `false`.

#### `auto-merge`

Enables GitHub's auto-merge on the dependency update PR after it is created.
Accepted values are `merge`, `squash` and `rebase`, matching the merge
strategy. Leave empty (the default) to disable auto-merge.

**Prerequisites:**

- The repository must have "Allow auto-merge" enabled in **Settings > General**
- Branch protection rules with required status checks must be configured on the
  base branch

If auto-merge cannot be enabled (e.g. missing prerequisites), the action logs a
warning and continues — it does not fail the workflow.

```yaml
auto-merge: squash # Enable auto-merge with squash strategy
```

## Outputs

Every declared output is set on **every** exit path, including a run that fails before it does any work. A run that aborts while reading its inputs still publishes `has-changes: "false"`, `updates-count: "0"`, empty PR outputs and an empty-run `result` document. Earlier versions left the outputs unset on an early exit, so a condition such as `if: steps.deps.outputs.has-changes == 'false'` compared against the empty string and did not match; workflows carrying a workaround for that can drop it.

### `pr-number`

The pull request number, if a PR was created or updated. Empty if no PR was
created (no changes detected, or dry-run mode).

### `pr-url`

The pull request URL. Empty if no PR was created.

### `updates-count`

The number of dependencies that were updated (string).

### `has-changes`

Whether any dependency changes were detected (`"true"` or `"false"`).

### `result`

The complete run as a single JSON document. Its shape is published as a JSON Schema at [`docs/schema/run-result.schema.json`](./schema/run-result.schema.json), generated from the action's own types, which is the authoritative field list.

The property to design around: `result` is **always valid JSON**. A run that did nothing, or that failed before it detected anything, publishes an empty-run document rather than an empty string, so a consuming step can call `fromJSON()` unconditionally instead of guarding for the empty case. Every array is present and empty rather than omitted, so **iterating** one is safe without a presence check — `updates` is never `null` and never absent.

Indexing is a different claim, and it does not follow. A present-but-empty array has no element `0`: in a workflow expression `fromJSON(...).updates[0].dependency` quietly evaluates to the empty string, and in a script consumer it throws. Check `updates.length` (or the `updates-count` output) before reaching for an element.

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | `1` | Document format version, incremented only on a breaking change to this shape |
| `hasChanges` | boolean | Whether the run produced any committable change |
| `dryRun` | boolean | Whether the run was a rehearsal that skipped commit, push and PR |
| `packageManager` | `"pnpm"` \| `"bun"` \| `"npm"` \| `null` | The package manager detected for this run; `null` when the run ended before detection |
| `workspaceRoot` | string | Absolute path of the workspace root every step read and wrote at |
| `branch` | string | The update branch this run wrote to |
| `targetBranch` | string | The branch the pull request targets |
| `updates` | array | Every dependency, runtime and package-manager change, one entry per (path, dependency, section) |
| `catalogDeltas` | array | Per-catalog merge outcomes; non-empty only under bun's compat-catalog mode |
| `lockfileChanges` | array | Resolved-version movements between the before and after lockfile snapshots |
| `changesets` | array | Changesets written by the changeset step |
| `pullRequest` | object \| `null` | The pull request opened or updated; `null` on a dry run or a PR step that degraded to a warning |

`packageManager` and `pullRequest` are nullable rather than carrying a placeholder: a value that parses and is false is worse than an absent one, because a consumer branching on it cannot tell that it is branching on a lie.

**When each field is empty or `null` is a contract, not an accident.** There are
three exits, and they differ:

| exit | `packageManager` / `workspaceRoot` | `updates` | `hasChanges` |
| --- | --- | --- | --- |
| completed with changes | the detected values | every change made | `true` |
| completed, nothing to do | the detected values | whatever resolved (often empty) | `false` |
| a `run` command failed | the detected values | the updates made before the failure | `false` |
| aborted before detection | `null` / `""` | `[]` | `false` |

So **`packageManager` is `null` only when the run never got as far as detecting
one** — an invalid input, a missing credential, any failure before the workspace
was inspected. It is not a "nothing happened" marker: a run that detected pnpm,
found no updates and exited reports `"pnpm"`, and a run that updated three
dependencies and then failed `pnpm test` reports those three updates with
`hasChanges: false`.

`hasChanges` means "a commit was made and a pull request opened or updated" —
nothing weaker. Reading it as "did anything happen" will mislead you on the
failed-command exit, where real work sits in the working tree uncommitted.

That last exit is the one to design around: `updates` being non-empty while
`hasChanges` is `false` is a *successful update followed by a failed check*, and
the `updates-count` output carries the same number so the two cannot disagree.

The baseline document — what an abort-before-detection publishes — is exactly
this:

```json
{
  "schemaVersion": 1,
  "hasChanges": false,
  "dryRun": false,
  "packageManager": null,
  "workspaceRoot": "",
  "branch": "",
  "targetBranch": "",
  "updates": [],
  "catalogDeltas": [],
  "lockfileChanges": [],
  "changesets": [],
  "pullRequest": null
}
```

A consumer can therefore parse unconditionally and branch on `packageManager === null` to mean "this run never started properly", which is a different question from `hasChanges === false`.

### Using the `result` document

`result` is a string, so a workflow expression has to parse it with `fromJSON()` before reading a field:

```yaml
- uses: savvy-web/silk-update-action@v4
  id: deps
  with:
    app-client-id: ${{ vars.APP_CLIENT_ID }}
    app-private-key: ${{ secrets.APP_PRIVATE_KEY }}
    dependencies: |
      effect

- name: List what moved
  env:
    RESULT: ${{ steps.deps.outputs.result }}
  run: echo "$RESULT" | jq -r '.updates[] | "\(.dependency) \(.from) -> \(.to)"'
  # effect ^4.0.0 -> ^4.1.0

- name: Notify only when a PR exists
  if: fromJSON(steps.deps.outputs.result).pullRequest != null
  run: echo "Opened ${{ fromJSON(steps.deps.outputs.result).pullRequest.url }}"
  # Opened https://github.com/owner/repo/pull/123
```

Because the document is always parseable, the `if:` condition above needs no guard for the empty case — on a run with no PR it evaluates `null != null` and the step is skipped.

Passing the document through an environment variable, as the `jq` step does, keeps a value out of the shell command line. Reading a field directly in `${{ }}` is fine for a number, a URL or a boolean.

### Using outputs

```yaml
- uses: savvy-web/silk-update-action@v4
  id: update-deps
  with:
    app-client-id: ${{ vars.APP_CLIENT_ID }}
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

The action authenticates as a GitHub App, and the token's lifecycle spans the three phases. The pre phase exchanges the App credentials for a short-lived installation token. The main phase uses that token for every GitHub API call. The post phase revokes it.

The token is masked in workflow logs, so it does not appear in build output even when a step echoes its environment.

## Dependency selection

### Config dependencies

[Config dependencies](https://pnpm.io/config-dependencies) are declared in
`pnpm-workspace.yaml` and provide workspace-level tooling. They are hash-pinned
with no explicit range, so the action upgrades each one within a conservative
range derived from its current major. A config dependency at `>=1.0.0` stays
within its current major; one below `1.0.0` may advance across the `0.x` line
and adopt the first stable major (`1.x`), but never crosses two majors at once.
The action edits the `configDependencies` entry in `pnpm-workspace.yaml` in
place, which avoids the catalog promotion that `pnpm add --config` would
introduce.

```yaml
# pnpm-workspace.yaml
configDependencies:
  typescript: 5.4.0
  "@biomejs/biome": 1.6.1
```

### Workspace dependencies

Workspace dependencies are matched against the `dependencies`,
`devDependencies` and `optionalDependencies` fields in all `package.json`
files. `peerDependencies` are intentionally excluded — peer ranges are
managed by the `peer-lock` and `peer-minor` inputs.

The action resolves each dependency within the semver range already declared in
`package.json`, rather than jumping to npm's absolute latest. A `^4.0.0`
specifier resolves to the highest `4.x` and will not cross to `5.x`; a `~3.0.0`
specifier stays within `3.0.x`; a wider range like `>=4.0.0` may advance across
a major. An exact pin (e.g. `4.0.0`, no operator) is a single-version range and
is left untouched. A caret on a pre-1.0 version is the one exception to plain
caret semantics: `^0.5.2` rolls forward across the `0.x` line and adopts the
first stable `1.x` (resolving within `>=0.5.2 <2.0.0`) rather than being trapped
in `0.5.x` by npm's caret-on-zero rule, mirroring how config dependencies advance
out of `0.x`. A tilde on a pre-1.0 version is unaffected. Prereleases are excluded. Querying the npm registry directly
this way also avoids `pnpm up --latest`, which promotes deps to catalogs when
`catalogMode: strict` is enabled. Glob patterns follow Node's `path.matchesGlob`:

| Pattern | Matches |
| --- | --- |
| `vitest` | Exact package `vitest` |
| `@effect/*` | All packages in the `@effect` scope |
| `@savvy-web/*` | All packages in the `@savvy-web` scope |

### Release-age gating

pnpm's [`minimumReleaseAge`](https://pnpm.io/settings#minimumreleaseage) setting refuses to install versions published less than a given number of minutes ago (`ERR_PNPM_NO_MATURE_MATCHING_VERSION`). The action mirrors that gate at resolution time: when the workspace declares a release-age window, config-dependency and workspace-dependency updates hold back candidate versions published inside it rather than proposing an update the install step would then reject.

The effective settings are read from two sources and combined, with the strictest value winning:

- `minimumReleaseAge` / `minimumReleaseAgeExclude` keys declared inline in `pnpm-workspace.yaml`
- The same keys injected by a config dependency's `pnpmfile` `updateConfig` hook

Held-back versions are logged (`Release-age gate: holding back N version(s) of <pkg> younger than M minutes`) and picked up on a later run once they mature. Packages matching `minimumReleaseAgeExclude` bypass the gate. The gate fails open: when no gate is declared or publish-time data for a package is unavailable, resolution behaves as if there were no gate.

There is no action input for this behavior — it follows the target repository's own pnpm settings.

### Peer dependency syncing

Peer dependency ranges can be automatically synced when the corresponding
workspace dependency updates. This is controlled by the `peer-lock` and
`peer-minor` inputs.

Published packages list peer dependencies to declare compatibility. When you update a dependency like `vitest`, the peer range should reflect the version you tested against. A `devDependency` change alone does not warrant a release, since dev dependencies are stripped from published packages — but a peer range change is consumer-facing and produces a patch changeset.

**Strategies:**

| Strategy | Behavior | Example |
| --- | --- | --- |
| `peer-lock` | Sync on every bump | `1.0.0` to `1.0.3` updates peer to `^1.0.3` |
| `peer-minor` | Sync on minor+ only | `3.1.0` to `3.1.2` leaves peer at `^3.1.0`; `3.1.0` to `3.2.0` updates to `^3.2.0` |

Version resolution follows semver naturally. If the workspace dependency
specifier is `^3.1.0`, the action resolves the highest version satisfying that
range — the highest `3.x`, never crossing into `4.x`. The peer range then syncs
to the resolved version per the chosen strategy.

## Post-update commands

Commands specified in the `run` input execute after all dependency updates and
`pnpm install`. Use them to fix formatting, run tests or rebuild.

- Commands run sequentially in the order listed
- All commands are attempted even if earlier ones fail
- If any command fails, the action reports the failure, updates the check run with an error status and exits without creating a PR
- Commands are executed via `sh -c`, so shell features are available

## Branch management

The action manages a dedicated branch for dependency updates:

1. The `source-branch` and `target-branch` refs are validated up front — a missing ref fails the run before any destructive operation
2. If the branch does not exist, it is created from the source branch (`source-branch`, default `main`)
3. If the branch exists, it is force-reset to the source branch in a single update, so the ref never disappears mid-run
4. Changes are committed via the GitHub API (not `git commit`) to produce verified/signed commits
5. The branch ref is updated directly using the Git Data API

This approach ensures the PR always shows a clean diff against the source branch with only the dependency changes.

## Changeset integration

If your repository has a `.changeset/` directory and the `changesets` input is
`true` (the default), the action regenerates a consolidated dependency changeset
for each affected package. Rather than appending a new changeset every run, it
recomputes the cumulative dependency diff between the base branch and the working
tree, writes a single current `## Dependencies` table per package and deletes any
stale pure-dependency changesets it supersedes. Re-running the action therefore
converges on one table per package instead of piling up duplicates. Hand-authored
changesets that mix a `## Dependencies` table with prose are left untouched.

Because the diff is taken against the base branch, the checkout must include full
history — set `fetch-depth: 0` on `actions/checkout` (see
[Getting started](./01-getting-started.md)). A shallow checkout cannot resolve
the merge-base.

A workspace package gets a `patch` changeset only when **both** conditions hold:

1. **Consumer-facing changes** — the package's dependency diff must contain at least one `dependency`, `optionalDependency` or `peerDependency` change (peer ranges synced by `peer-lock` or `peer-minor` count).

   `devDependency`-only changes never produce a changeset, and dev rows are dropped from the changeset table (dev dependencies are stripped from published packages).

   `devEngines.runtime` upgrades (from `upgrade-runtime-*`) and package-manager self-upgrades (from `upgrade-package-manager`) are tooling-level changes that appear in the PR summary and commit message but never create a changeset.

2. **Versionable** — the package must be publishable (non-private, or with a `publishConfig` targeting a registry) or a private package opted in via `privatePackages.version` in `.changeset/config.json`, and must not be listed in the changeset `ignore` list.

   Packages that are not versionable are skipped silently.

Changeset tables list the package's `dependency`, `optionalDependency` and `peerDependency` changes. Empty changesets are not written; config-only updates (`pnpm-workspace.yaml` `configDependencies`) do not produce a changeset.

## Advanced patterns

### Separate config and regular updates

Run the action twice in the same workflow with different branches:

```yaml
- uses: savvy-web/silk-update-action@v4
  with:
    app-client-id: ${{ vars.APP_CLIENT_ID }}
    app-private-key: ${{ secrets.APP_PRIVATE_KEY }}
    branch: deps/config
    config-dependencies: |
      typescript
      @biomejs/biome

- uses: savvy-web/silk-update-action@v4
  with:
    app-client-id: ${{ vars.APP_CLIENT_ID }}
    app-private-key: ${{ secrets.APP_PRIVATE_KEY }}
    branch: deps/regular
    dependencies: |
      effect
      @effect/*
```

### Auto-merge with squash

Automatically merge the dependency PR once status checks pass:

```yaml
- uses: savvy-web/silk-update-action@v4
  with:
    app-client-id: ${{ vars.APP_CLIENT_ID }}
    app-private-key: ${{ secrets.APP_PRIVATE_KEY }}
    config-dependencies: |
      typescript
    auto-merge: squash
```

### Conditional updates

Use outputs to gate subsequent steps:

```yaml
- uses: savvy-web/silk-update-action@v4
  id: deps
  with:
    app-client-id: ${{ vars.APP_CLIENT_ID }}
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
