# Execution phases

The action runs as three phases — `pre`, `main` and `post` — declared in its `action.yml` under `runs:`. The pre phase provisions the GitHub App token, the main phase does the dependency-update work and the post phase reports duration and revokes the token. This document walks through each phase in order.

## Table of contents

- [Pre phase](#pre-phase)
- [Main phase](#main-phase)
  - [Parse inputs](#parse-inputs)
  - [Detect the package manager](#detect-the-package-manager)
  - [Branch management](#branch-management)
  - [Capture lockfile state (before)](#capture-lockfile-state-before)
  - [Upgrade the package manager](#upgrade-the-package-manager)
  - [Upgrade runtimes](#upgrade-runtimes)
  - [Update config dependencies](#update-config-dependencies)
  - [Update workspace dependencies](#update-workspace-dependencies)
  - [Sync peer dependencies](#sync-peer-dependencies)
  - [Regenerate lockfile and install](#regenerate-lockfile-and-install)
  - [Format pnpm-workspace.yaml](#format-pnpm-workspaceyaml)
  - [Run custom commands](#run-custom-commands)
  - [Capture lockfile state (after)](#capture-lockfile-state-after)
  - [Detect changes](#detect-changes)
  - [Create changesets](#create-changesets)
  - [Commit and push](#commit-and-push)
  - [Create or update PR](#create-or-update-pr)
- [Post phase](#post-phase)

## Pre phase

The pre phase provisions the GitHub App installation token before any updates run.

- Reads the `app-client-id` and `app-private-key` inputs and mints an installation token for the App
- Runs a fail-fast permission check against the scopes the action needs (`contents: write`, `pull-requests: write` and `checks: write`). A missing scope fails the run here, in the pre phase, rather than partway through the main phase
- Records a start time so the post phase can report total duration
- Persists the token to cross-phase state so the main phase can read it back

## Main phase

The main phase reads the token the pre phase provisioned and runs the dependency-update workflow. The steps below run in order, and steps tied to an absent input are skipped.

### Parse inputs

- Parses and validates all action inputs. An input that is present but malformed fails the run here, naming the input; an absent input takes its documented default
- Validates the enumerated inputs against their accepted values — `upgrade-package-manager` and each `upgrade-runtime-*` against their keywords or a parseable semver range, `runtime-data` against `offline` and `live`. An unrecognized value fails rather than falling back
- Validates that at least one update type is active — `config-dependencies`, `dependencies`, a non-`false` `upgrade-package-manager`, or an `upgrade-runtime-*` input. All of these default to off, so a workflow that configures none of them fails at this step
- Validates that `peer-lock` and `peer-minor` do not list the same package
- Warns if a `peer-lock` or `peer-minor` entry does not match any `dependencies` pattern
- Creates a GitHub check run for status visibility in the UI

### Detect the package manager

- Resolves the workspace root and its package manager once, before any other step, and records both in the run context log
- Detection reads the lockfile together with the root manifest. A repository that names a manager only in `devEngines.packageManager`, with no matching lockfile, is detected as npm
- pnpm, bun and npm are supported. Yarn is rejected with an input error, as are workspaces with no resolvable root
- Detection runs inside the check run, so an unsupported workspace fails visibly in the GitHub UI rather than exiting early with no status
- Every step below dispatches on this one value, and every file read or written is anchored at the detected workspace root rather than the process working directory — the action can be invoked from a subdirectory

### Branch management

- Validates that the `source-branch` and `target-branch` refs exist, failing fast before any destructive operation
- Creates the update branch from the source branch (`source-branch`, default `main`) when it does not exist, then fetches and checks it out locally
- Force-resets the branch to the source branch when it does exist, in a single ref update rather than a delete followed by a create, so the ref never disappears mid-run
- This reset strategy guarantees the PR always shows only the dependency changes against the current source branch

### Capture lockfile state (before)

- Reads the lockfile the detected package manager writes — `pnpm-lock.yaml` for pnpm, `bun.lock` for bun, `package-lock.json` for npm — and parses all three into one normalized model
- Stores the lockfile in memory for later comparison
- A missing lockfile is logged and skipped rather than failing the run

### Upgrade the package manager

- Runs when the `upgrade-package-manager` input is non-`false`. The default is `false`, so this step is skipped unless the workflow opts in
- Applies to the package manager detected for the workspace — pnpm, bun or npm — not to pnpm specifically
- Detects the current version from `devEngines.packageManager` in `package.json`, falling back to the `packageManager` field
- Checks for the latest available version of that manager within range. An explicit range typed for a different manager satisfies nothing and is skipped with a warning naming the mismatch
- Updates the `packageManager` and `devEngines` fields when a newer version is available, hash-pinned for the corepack-managed managers (pnpm, npm) and bare for bun
- Records the version change for the PR summary and commit message; it does not create a changeset, but it does trigger the lockfile regeneration step, whose install performs the corepack switch to the new version

### Upgrade runtimes

- Runs when any of `upgrade-runtime-node`, `upgrade-runtime-deno` or `upgrade-runtime-bun` is set to `auto` or a semver range
- Resolves the latest version for the matching `devEngines.runtime` entry and rewrites its `version` to the bare exact version, dropping any range operator
- Upgrades only an entry the manifest already declares; a runtime with no entry is skipped with a warning, in every mode
- Uses the `runtime-data` source — `offline` reads the bundled cache, `live` fetches the latest data and falls back to the cache on failure
- Resolution covers only currently-maintained major lines; a request targeting an end-of-life line is skipped with a warning
- Like a package-manager self-upgrade, a runtime bump appears in the PR summary and commit message but never creates a changeset; unlike a package-manager self-upgrade, it never triggers the install step

### Update config dependencies

- Iterates over each config dependency listed in the `config-dependencies` input
- Resolves each config dependency within a conservative range derived from its current major (these entries are hash-pinned and carry no explicit range)
- Where the resolved version is written dispatches on the detected package manager:
  - **pnpm** — edits the `configDependencies` entry in `pnpm-workspace.yaml` in place. Editing in place avoids `pnpm add --config`, which would promote the dependency into a catalog
  - **bun** — bun has no config-dependency mechanism, so the workflow is reproduced against catalogs: the config dependency's published `catalogs` export is three-way merged into the root `package.json` `catalog` and `catalogs` fields, using the version recorded in the lockfile as the merge base so a hand-written override is distinguishable from an entry a previous run wrote. The per-entry outcomes (added, updated, removed, kept) reach the PR body as a Catalog Changes table. Names owned by this path are excluded from the workspace-dependency step so one manifest entry is not bumped twice
  - **npm** — skipped with a warning. npm implements no `catalog:` protocol, so there is nothing to merge into
- Honors the workspace's pnpm release-age gate (`minimumReleaseAge`): candidate versions published inside the age window are held back, logged and picked up on a later run once they mature (see [Release-age gating](./02-configuration.md#release-age-gating))
- Uses error accumulation: if one dependency fails to update, the others still proceed, and failures are logged as warnings

### Update workspace dependencies

- Iterates over each dependency pattern in the `dependencies` input
- Matches against `dependencies`, `devDependencies` and `optionalDependencies` in every workspace `package.json` (`peerDependencies` are excluded — those are managed by `peer-lock` and `peer-minor`)
- A dependency listed in multiple sections of one `package.json` is updated in each section independently and produces one update record per section
- Resolves each dependency within the semver range already declared in `package.json` rather than jumping to npm's absolute latest — a `^4.0.0` specifier stays on `4.x`, a `~3.0.0` stays on `3.0.x`, a wider range like `>=4.0.0` may advance across a major, and an exact pin is left untouched; querying the npm registry directly this way also avoids `pnpm up --latest` promoting dependencies into catalogs when `catalogMode: strict` is enabled
- Supports glob patterns such as `@savvy-web/*`
- Honors the workspace's pnpm release-age gate the same way the config-dependency step does
- Uses error accumulation: individual failures do not block other updates

### Sync peer dependencies

- For each workspace dependency update matching a `peer-lock` or `peer-minor` entry, finds the corresponding `peerDependencies` range, computes the new range and writes the updated `package.json`
- `peer-lock` syncs the peer range on every version bump
- `peer-minor` syncs the peer range only on minor or major bumps and floors the patch to `.0`
- Preserves the existing prefix (`^`, `~`, `>=` and so on)
- Skips with a warning when no peer entry exists for the package

### Regenerate lockfile and install

- Runs only when there is a package-manager upgrade, config-dependency update, workspace-dependency update or peer-sync rewrite to process; otherwise the step logs that there is nothing to install
- The command dispatches on the detected package manager, and every command runs at the detected workspace root rather than the process working directory:
  - **pnpm** — `pnpm clean --lockfile` removes `pnpm-lock.yaml` and `node_modules` (requires pnpm 11+; a `clean` or `purge` script in the root `package.json` runs in place of the built-in), then `pnpm install --frozen-lockfile=false` regenerates the lockfile. `--frozen-lockfile=false` opts out of CI's default refusal to write lockfile changes
  - **bun** — `bun install --force`, which re-resolves every dependency against the registry instead of replaying the lockfile
  - **npm** — `package-lock.json` is unlinked through Node rather than a shelled `rm` (which does not exist on a Windows runner), then `npm install` re-resolves. npm has no clean-and-resolve mode of its own: `npm ci` requires the lockfile to already be correct
- The lockfile is regenerated rather than repaired because the action mutates all three inputs to resolution — the package manager version, its config, and the declared ranges — and a repair-only install never re-runs resolution under the changed inputs, so it can commit an inconsistent lockfile
- Advancing transitive versions within their declared ranges is expected, so a larger lockfile diff is intentional rather than noise
- When a corepack-managed package manager (pnpm, npm) was upgraded, this install also performs the corepack switch to the new version

### Format pnpm-workspace.yaml

- Runs for pnpm workspaces only. Under bun and npm there is no `pnpm-workspace.yaml` to format, and the step is skipped with a logged reason naming the detected manager
- Reads and parses `pnpm-workspace.yaml`
- Sorts array values alphabetically (`packages`, `onlyBuiltDependencies`, `publicHoistPattern`)
- Sorts top-level keys alphabetically with `packages` kept first
- Writes back with consistent formatting (2-space indent, no line wrapping, double quotes) so lint-staged does not change the file after commit

### Run custom commands

- Executes commands from the `run` input sequentially via `sh -c`
- Attempts all commands regardless of individual failures
- If any command fails, updates the check run with a failure conclusion, includes the failure details in the summary, exits without creating a PR or committing, and outputs `has-changes: false` and `updates-count: 0`

### Capture lockfile state (after)

- Re-reads the same lockfile after all dependency changes, using the detected package manager's lockfile name
- Stores the updated lockfile for comparison

### Detect changes

Change detection uses two complementary methods.

Lockfile comparison diffs the before and after lockfiles. Catalog comparison detects shared version updates (`catalog:default`, `catalog:silk` and so on) and scans importers to find which packages use each changed catalog entry. Importer comparison detects direct, non-catalog dependency version changes per package.

A `git status --porcelain` check detects any modified, staged or untracked files. If both the lockfile comparison and git status show no changes, the action exits early with a neutral check-run conclusion.

### Create changesets

- Skips entirely if the `changesets` input is `false`
- Checks whether a `.changeset/` directory exists
- Recomputes the cumulative dependency diff between the base branch (`merge-base`) and the working tree, so the checkout must include full history (`fetch-depth: 0`); a shallow checkout cannot resolve the merge-base
- For each affected workspace package, applies two conditions. The package's diff must contain at least one consumer-facing change — a `dependency`, `optionalDependency` or `peerDependency` change, including peer-sync rewrites; `devDependency`-only changes never produce a changeset. The package must also be versionable — publishable, or a private package opted in via `privatePackages.version` in `.changeset/config.json` — and not listed in the changeset `ignore` list
- When both conditions hold, writes a single consolidated `patch` changeset whose `## Dependencies` table lists the package's `dependency`, `optionalDependency` and `peerDependency` changes (dev rows are dropped)
- Regeneration is convergent: stale pure-dependency changesets it supersedes are deleted, so re-running the action produces one current table per package rather than accumulating duplicates. Hand-authored changesets that mix a `## Dependencies` table with prose are left untouched
- Empty changesets are not written, and config-only changes do not produce a changeset

### Commit and push

Commits are created through the GitHub Git Data API rather than a local `git commit`.

- Collects the changed files from git status
- Builds a tree of blob entries from their contents
- Creates a commit with a conventional commit message and DCO signoff, and no explicit author so GitHub verifies it
- Updates the branch ref to the new commit, then fetches and checks out the updated branch locally

In dry-run mode this step is skipped entirely.

### Create or update PR

- Searches for an existing open PR from the update branch to the target branch (`target-branch`, which defaults to following `source-branch`)
- Updates the title and body of an existing PR, or creates a new one
- The PR body includes per-package tables with dependency, type, action, from and to columns, plus changeset details in expandable sections
- If `auto-merge` is set, enables auto-merge on the PR via the GitHub GraphQL API; failures are logged as warnings without failing the action
- Sets the `pr-number`, `pr-url`, `updates-count` and `has-changes` outputs
- Writes a GitHub Actions job summary with the same information

In dry-run mode this step is skipped and a PR body preview is included in the job summary instead.

## Post phase

The post phase runs after the main phase, even when the main phase fails.

- Reports the total run duration from the start time the pre phase recorded
- Revokes the installation token so it is not left live after the run
- Guards revocation so a failure here never fails the workflow
