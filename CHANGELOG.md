# pnpm-config-dependency-action

## 0.12.0

### Features

* [`d06ac37`](https://github.com/savvy-web/pnpm-config-dependency-action/commit/d06ac37f48542eb67b8de34082419ffdbeb8eb5c) ### Versionable + trigger-driven changeset emission

Changesets now follow precise rules:

* A workspace package gets a changeset only if it is **versionable** (publishable per silk or vanilla mode rules, OR non-publishable with `privatePackages.version: true` in `.changeset/config.json`).
* A versionable package gets a changeset only when at least one **trigger** fires for it: a `dependencies` / `optionalDependencies` / `peerDependencies` specifier change in its own `package.json`, a peer-sync rewrite of one of its peers, or a non-dev catalog reference resolving to a different version after the run.
* `devDependencies`-only changes never produce a changeset (they appear in the table only when a changeset is being written for other reasons).
* Empty changesets are no longer emitted.

### Bug Fixes

* [`d06ac37`](https://github.com/savvy-web/pnpm-config-dependency-action/commit/d06ac37f48542eb67b8de34082419ffdbeb8eb5c) ### Catalog consumer detection on pnpm v9 lockfiles

`findCatalogConsumers` in the lockfile service now reads catalog specifiers from the importer's flat `specifiers` map (the pnpm v9 lockfile shape) instead of incorrectly looking for a `.specifier` property on the per-dep value (which is just a version string). Previously, catalog changes never surfaced as triggers because consumers were never matched. Catalog reference changes consumed in `dependencies`, `optionalDependencies`, or `peerDependencies` now correctly trigger changesets for the consuming workspace.

* [`ef5b742`](https://github.com/savvy-web/pnpm-config-dependency-action/commit/ef5b7420ca76d66232a1f910622983acfe9cfd41) ### Root-package name resolution

The action now correctly resolves the root workspace package's name when emitting changesets. Previously, dependency changes affecting the root would produce a changeset with the literal frontmatter key `"."` instead of the root's actual `name` field from `package.json`. The root cause was the underlying `workspace-tools` dependency excluding the root package from its package list; replaced with `workspaces-effect` which always includes the root.

* [`cadb1df`](https://github.com/savvy-web/pnpm-config-dependency-action/commit/cadb1dfc766d0112a611ddd80f2766f8ef1e3080) ### Preserve transitive dependencies during install

The action's lockfile-refresh step previously deleted `node_modules` and `pnpm-lock.yaml` before running `pnpm install`, forcing a from-scratch resolve. This had the side effect of bumping transitive dependencies for packages the action was not asked to touch — every run could quietly move unrelated transitives forward to whatever the registry currently resolved them to.

* [`ef5b742`](https://github.com/savvy-web/pnpm-config-dependency-action/commit/ef5b7420ca76d66232a1f910622983acfe9cfd41) Replace `workspace-tools` with `workspaces-effect` for workspace discovery and package metadata, via a new `Workspaces` domain service in `src/services/`.
* Add integration test infrastructure under `__test__/integration/` with two committed mock-workspace fixtures (`single-package-private-root` and `multi-package-public-root`).

The step now runs `pnpm install --frozen-lockfile=false --fix-lockfile` instead. The new command reconciles the lockfile against the just-modified `package.json` and `pnpm-workspace.yaml` files and installs `node_modules` to match, touching only the directly-bumped specifiers and their strict transitives. Unrelated transitives stay at their currently-pinned versions.

The `--frozen-lockfile=false` flag is required because pnpm auto-enables `--frozen-lockfile` in CI (`CI=true` is always set in GitHub Actions), which would otherwise refuse to write the lockfile changes the action just made.

### Maintenance

* [`ef5b742`](https://github.com/savvy-web/pnpm-config-dependency-action/commit/ef5b7420ca76d66232a1f910622983acfe9cfd41) Replace `workspace-tools` with `workspaces-effect` for workspace discovery and package metadata, via a new `Workspaces` domain service in `src/services/`.
* Add integration test infrastructure under `__test__/integration/` with two committed mock-workspace fixtures (`single-package-private-root` and `multi-package-public-root`).

### Per-importer per-section catalog change records

`compareCatalogs` now emits one `LockfileChange` per `(catalog change, consuming importer, dep section)` triple instead of a single aggregated record. Each record carries the accurate `type` field, so changes consumed only in `devDependencies` no longer incorrectly produce changesets for those workspaces.

## 0.11.2

### Other

* [`f7c001d`](https://github.com/savvy-web/pnpm-config-dependency-action/commit/f7c001dd755f341d0210f3bf79623bdad1eec9e5) Upgrades internals for distribution

## 0.11.1

### Bug Fixes

* [`34dbb1f`](https://github.com/savvy-web/pnpm-config-dependency-action/commit/34dbb1f9d4d805e33a485a4da6fb800d4695097e) Pins workspace-tools to 0.41.0 due to breaking upstream issue.

### Dependencies

* | [`1ece353`](https://github.com/savvy-web/pnpm-config-dependency-action/commit/1ece3531032449542e86fc8cb074c3919a9e768b) | Dependency    | Type    | Action | From   | To |
  | :---------------------------------------------------------------------------------------------------------------------- | :------------ | :------ | :----- | :----- | -- |
  | @savvy-web/commitlint                                                                                                   | devDependency | updated | ^0.4.1 | ^0.4.3 |    |
  | @savvy-web/lint-staged                                                                                                  | devDependency | updated | ^0.6.2 | ^0.6.4 |    |

## 0.11.0

### Features

* [`4798d16`](https://github.com/savvy-web/pnpm-config-dependency-action/commit/4798d163ba9f2b99550a3412b78b8a0e67f5e92d) Add granular peer dependency sync with `peer-lock` and `peer-minor` inputs.

- `peer-lock`: Sync peerDependency range on every devDependency version bump
- `peer-minor`: Sync peerDependency range only on minor+ bumps (floor patch to .0)
- Narrow `dependencies` input to match `devDependencies` only
- Fix changeset table `Type` column to use specific values (`devDependency`, `peerDependency`, `dependency`, `config`)
- Changesets only trigger on consumer-facing changes (peer range or runtime dependency changes), not devDependency-only updates
- PR body uses per-package tables with Dependency/Type/Action/From/To columns

## 0.10.0

### Features

* [`d7c18a6`](https://github.com/savvy-web/pnpm-config-dependency-action/commit/d7c18a6b5f741b526d7048b37815d5543024816d) Migrate to @savvy-web/github-action-effects v0.11 API, replacing legacy
  `@actions/*` imports and `Action.parseInputs()` with the modern library API.

- Use Effect's `Config.*` API for typed input parsing
- Use `ActionEnvironment` for GitHub context (SHA, repository)
- Use `Redacted` for secure private key handling
- Separate program logic from entry point for clean test imports
- Wire `OctokitAuthAppLive` and `GitHubClientLive` layers for GitHub App auth

## 0.9.0

### Features

* [`14da150`](https://github.com/savvy-web/pnpm-config-dependency-action/commit/14da150ca9e12d8dea62d65c2f9faf7221c0683e) Changeset summaries now use the structured GFM dependency table format from `@savvy-web/changesets`. The `## Dependencies` section renders a five-column table (Dependency, Type, Action, From, To) instead of bullet lists with arrows.

## 0.8.1

### Bug Fixes

* [`17d8b35`](https://github.com/savvy-web/pnpm-config-dependency-action/commit/17d8b358c23b3c2775a52d31f5195b3fc7709ad0) Add `log-level` action input using the standard `@savvy-web/github-action-effects` log-level setup with `auto`, `info`, `verbose`, and `debug` levels

## 0.8.0

### Breaking Changes

* [`035cae1`](https://github.com/savvy-web/pnpm-config-dependency-action/commit/035cae1369b48cc1b3c9151637dbd7ee5902b215) Collapse three-phase execution (pre/main/post) into single-phase architecture
* Remove `skip-token-revoke` and `log-level` inputs from action.yml
* Remove `token` output from action.yml

### Features

* [`035cae1`](https://github.com/savvy-web/pnpm-config-dependency-action/commit/035cae1369b48cc1b3c9151637dbd7ee5902b215) Upgrade @savvy-web/github-action-effects from v0.3.0 to v0.4.0
* Use `GitHubApp.withToken()` bracket pattern for automatic token lifecycle management
* Use `CheckRun.withCheckRun()` bracket pattern for check run lifecycle
* Use `Action.parseInputs()` for declarative, Schema-based input parsing
* Replace custom services (GitHubClient, GitExecutor, PnpmExecutor) with library equivalents (CommandRunner, GitBranch, GitCommit, GitHubClient)
* Use `AutoMerge.enable()` from library for auto-merge support

## 0.7.1

### Dependencies

* [`b538fde`](https://github.com/savvy-web/pnpm-config-dependency-action/commit/b538fde5724a8de53f5e509163f58cfe424b5f3e) @savvy-web/changesets: ^0.1.1 → ^0.4.1
* @savvy-web/commitlint: ^0.3.3 → ^0.4.0
* @savvy-web/github-action-builder: ^0.1.4 → ^0.2.0
* @savvy-web/lint-staged: ^0.4.5 → ^0.5.0
* @savvy-web/vitest: ^0.1.0 → ^0.2.0

## 0.7.0

### Features

* [`babbee1`](https://github.com/savvy-web/pnpm-config-dependency-action/commit/babbee17435d86dbd7f652cffee07e3f088105e4) Replace `pnpm add --config` with direct npm registry queries and YAML editing for config dependency updates, avoiding catalog promotion when `catalogMode: strict` is enabled

## 0.6.0

### Minor Changes

* [`ec30b5a`](https://github.com/savvy-web/pnpm-config-dependency-action/commit/ec30b5a96bcf93602b850d32344f2c0c4a69e2b4) Replace `pnpm up --latest` with direct npm queries for regular dependency updates to avoid promoting dependencies to catalogs when `catalogMode: strict` is enabled

## 0.5.1

### Bug Fixes

* [`c223a90`](https://github.com/savvy-web/pnpm-config-dependency-action/commit/c223a9077669478c82f4c7783cf51cca35cb6f45) Supports @savvy-web/vitest

## 0.5.0

### Bug Fixes

* [`e36fba1`](https://github.com/savvy-web/pnpm-config-dependency-action/commit/e36fba14758a90bd7b98d83b842170d7151f695b) Fix missing dependency detection for catalog resolved version changes.

When a clean install resolves a newer version within the same semver range (e.g., `^2.8.4` stays unchanged but resolves `2.8.6` to `2.8.7`), the action now correctly detects and reports the change. Previously, `compareCatalogs()` only compared the `specifier` field of catalog entries, ignoring the `version` (resolved) field. This caused changes that stayed within the declared semver range to fall through both the catalog and importer comparison paths undetected, resulting in 0 reported changes and an empty PR body.

The fix compares both `specifier` and `version` fields of `ResolvedCatalogEntry`. When only the resolved version changed, the reported from/to values use the concrete resolved versions (e.g., `2.8.6` to `2.8.7`). When the specifier itself changed, existing behavior is preserved (e.g., `^2.8.4` to `^2.9.0`).

## 0.4.0

### Minor Changes

* 85f1c06: Add `changesets` input option (default: `true`) to control whether changesets are created during dependency updates. When set to `false`, the action skips changeset creation, which is useful for repos that don't need the release cycle and just want a dependency update PR.

## 0.3.0

### Minor Changes

* 127b7b6: Add auto-merge support for dependency update PRs. A new `auto-merge` input
  accepts `merge`, `squash`, or `rebase` to enable GitHub's auto-merge via the
  GraphQL API after PR creation. Failures are handled gracefully with a warning
  log, requiring repository-level "Allow auto-merge" and branch protection to
  be configured.

## 0.2.0

### Minor Changes

* eec6269: Add pnpm self-upgrade step that detects pnpm versions from `packageManager` and `devEngines.packageManager` fields in root `package.json`, resolves the latest version within the `^` semver range, and upgrades via `corepack use`. Controlled by the new `update-pnpm` input (default: `true`). The upgrade runs before config dependency updates and is reported alongside them in the PR body.

## 0.1.0

### Minor Changes

* 826309a: Initial release of the pnpm Config Dependency Action.

  A GitHub Action that automates updates to pnpm config dependencies and regular
  dependencies, filling the gap left by Dependabot's lack of support for pnpm's
  `configDependencies` feature in `pnpm-workspace.yaml`.

  ### Features

  * **Config dependency updates**: Updates config dependencies via `pnpm add --config`,
    tracking version changes with before/after comparison
  * **Regular dependency updates**: Updates regular dependencies via `pnpm up --latest`
    with glob pattern support (e.g., `effect`, `@effect/*`, `@savvy-web/*`)
  * **Custom post-update commands**: Execute commands after dependency updates via the
    `run` input (e.g., `pnpm lint:fix`, `pnpm test`). All commands run sequentially;
    if any fail, the job fails and no PR is created
  * **Changeset integration**: Automatically creates patch changesets for affected
    packages, with empty changesets for root workspace config dependency updates
  * **Verified commits**: Creates signed/verified commits via the GitHub API using
    GitHub App authentication (no SSH or GPG keys required)
  * **Branch management**: Manages a dedicated update branch with automatic creation
    or reset to the default branch on each run
  * **Lockfile diffing**: Compares `pnpm-lock.yaml` snapshots before and after updates
    to detect actual dependency changes, including catalog entry tracing to identify
    affected workspace packages
  * **Detailed PR summaries**: Generates Dependabot-style PR descriptions with
    dependency tables, npm links, and per-package changeset details
  * **GitHub App authentication**: Uses short-lived installation tokens with
    fine-grained permissions for secure automation
  * **Check run integration**: Creates GitHub check runs for visibility into action
    progress and results
  * **Dry-run mode**: Detect changes without committing, pushing, or creating PRs
  * **Debug logging**: Configurable log levels for troubleshooting

  ### Architecture

  Built with Effect-TS for typed error handling, retry logic, and service-based
  dependency injection. Uses a three-phase execution model (pre/main/post) with
  13 orchestration steps in the main phase.
