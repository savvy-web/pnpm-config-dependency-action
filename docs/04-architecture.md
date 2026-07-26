# Architecture overview

How the Silk Update Action works, at the level you need to run it: the three phases it executes, why the token lifecycle is split across them and what the main update workflow does in order.

## Table of contents

- [Design principles](#design-principles)
- [Three-phase execution](#three-phase-execution)
- [Main-phase flow](#main-phase-flow)
- [Verified commits](#verified-commits)

## Design principles

The action is built around four ideas. Changes are visible before they merge: every run produces a pull request with per-package change tables, and check runs report status in the GitHub UI. Individual dependency failures do not abort the run — errors are collected and reported so the rest of the updates still land. Authentication uses a short-lived GitHub App token rather than a long-lived personal access token. And the action complements Dependabot rather than replacing it, filling the gap Dependabot leaves around pnpm config dependencies.

## Three-phase execution

The action runs as three separate phases, declared in its `action.yml` under `runs:` as `pre`, `main` and `post`. GitHub Actions runs each phase as its own process, and the GitHub App token's lifecycle is split across them.

- **Pre** — provisions a GitHub App installation token. It signs in as the App, mints an installation token and runs a fail-fast permission check against the scopes the action needs (`contents: write`, `pull-requests: write` and `checks: write`). If the App is missing a scope, the run fails here, before any dependency is touched, instead of partway through the main phase. The pre step also records a start time and persists the token to cross-phase state so the main step can read it back.
- **Main** — the dependency-update workflow described below. It reads the token the pre step provisioned and uses it for every GitHub API call.
- **Post** — reports the total run duration and revokes the token. The post step always runs, even when the main step fails, so a token is never left live after a failed run. Revocation failures are swallowed so the post step never fails the workflow.

Splitting the token across phases keeps the credential short-lived and bounded to a single run, and it surfaces a misconfigured App immediately. The token is provisioned in pre, used in main and revoked in post — there is no long-lived secret in the environment for the main step to read.

## Main-phase flow

The main phase runs these steps in order. Most steps are conditional on the inputs you supply, and unrelated steps are skipped when their inputs are absent.

1. Manage the dedicated update branch (default `pnpm/config-deps`). The `source-branch` and `target-branch` refs are validated first — a missing ref fails the run before anything destructive happens. If the update branch exists it is force-reset to the source branch (`source-branch`, default `main`), so each run starts from a clean baseline and the PR diff shows only the dependency changes.
2. Detect the package manager for the workspace (pnpm, bun or npm — yarn is unsupported and fails the run) and capture the current state of its lockfile (`pnpm-lock.yaml`, `bun.lock` or `package-lock.json`) for later comparison. Every step below dispatches on this one detection.
3. Upgrade the detected package manager if `upgrade-package-manager` is non-`false`, bumping the `packageManager` and `devEngines.packageManager` fields when a newer version is available within range. corepack-managed managers (pnpm, npm) get a hash-pinned version (`pnpm@11.0.0+sha512.<hex>`); bun gets a bare version, since corepack does not manage it. An explicit range is resolved against the detected manager's releases — a range typed for a different manager satisfies nothing and is skipped with a warning.
4. Upgrade the `devEngines.runtime` entries (Node.js, Deno, Bun) when any `upgrade-runtime-*` input is set. See [runtime upgrades](#runtime-upgrades) below.
5. Update config dependencies, resolving each one within a conservative range derived from its current major (hash-pinned config deps carry no explicit range). The write dispatches on the detected package manager: under **pnpm** the `configDependencies` entry in `pnpm-workspace.yaml` is edited in place (it does not run `pnpm add --config`, which would promote the dependency into a catalog); under **bun** the config dependency's `catalogs` export is merged into the root `package.json` catalogs, since bun has no config-dependency mechanism of its own; under **npm** config dependencies are skipped with a warning, because npm implements no `catalog:` protocol.
6. Update regular dependencies across `dependencies`, `devDependencies` and `optionalDependencies` in every workspace `package.json`, resolving each within the semver range already declared in `package.json` (so a `^4.0.0` specifier stays on `4.x`) and matching the `dependencies` input patterns (globs supported). Both this step and the config-dependency step honor the workspace's pnpm release-age settings (`minimumReleaseAge`), holding back versions published inside the age window so the later install cannot fail on an immature version (see [Release-age gating](./02-configuration.md#release-age-gating)).
7. Sync peer-dependency ranges for packages listed in `peer-lock` or `peer-minor`, following each package's strategy.
8. Regenerate the lockfile, so resolution re-runs from a clean slate under the new package-manager version, config dependencies and ranges rather than being repaired in place. The command dispatches on the detected package manager: **pnpm** runs `pnpm clean --lockfile` then `pnpm install --frozen-lockfile=false` (`pnpm clean` requires pnpm 11 or later); **bun** runs `bun install --force`; **npm** removes `package-lock.json` and runs `npm install`. Advancing transitive versions within their declared ranges is expected, so a larger lockfile diff is intentional rather than noise.
9. Format `pnpm-workspace.yaml` so the result matches the repository's lint-staged formatting and does not churn after commit. Skipped for bun and npm, which have no `pnpm-workspace.yaml`.
10. Run any custom `run` commands sequentially. If a command fails, the action records the failure on the check run and exits without creating a PR.
11. Detect changes by diffing the before and after lockfiles and inspecting `git status`. If nothing changed, the run exits early.
12. Create changesets if the `changesets` input is enabled and the repository has a `.changeset/` directory.
13. Commit the changes through the GitHub API as a verified, signed commit (see below).
14. Create or update the pull request with a per-package summary, optionally enable auto-merge, finalize the check run and write the GitHub Actions job summary.

### Runtime upgrades

The `upgrade-runtime-node`, `upgrade-runtime-deno` and `upgrade-runtime-bun` inputs each accept `false`, `auto` or a semver range, and `runtime-data` selects whether version data comes from the bundled `offline` cache or a `live` fetch. A runtime upgrade rewrites the matching `devEngines.runtime` entry's version. Like a pnpm self-upgrade, it is a tooling-level change that appears in the PR summary and commit message but never creates a changeset; unlike a pnpm self-upgrade, it never triggers the install step. Version resolution covers only currently-maintained major lines, so a request targeting an end-of-life line is skipped with a warning.

## Verified commits

Commits are created through the GitHub Git Data API rather than a local `git commit`. When the App token is used and no explicit author is set, GitHub attributes the commit to the App and signs it automatically, so the PR shows the "Verified" badge. This needs no SSH or GPG keys on the runner and matches how GitHub's own bots commit.
