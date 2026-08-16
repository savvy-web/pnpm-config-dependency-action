---
status: current
module: silk-update-action
category: architecture
created: 2026-02-06
updated: 2026-08-05
last-synced: 2026-08-05
completeness: 95
related: []
dependencies: []
implementation-plans: []
---

# Silk Update Action

## Overview

The `silk-update-action` is a GitHub Action that automates updates to pnpm config dependencies, regular dependencies, and peer dependencies. Unlike Dependabot, this action supports [pnpm's config dependencies](https://pnpm.io/config-dependencies) feature, which allows dependencies to be declared in `pnpm-workspace.yaml` for centralized version management across a monorepo. It also syncs peer dependency ranges across workspace packages to keep them consistent.

The action is built on **Effect v4** and the first-party **`@effected/*` kit** (`github`, `github-actions`, `commands`, `npm`, `workspaces`, `lockfiles`, `runtimes`, `semver`, `yaml`) plus `@savvy-web/silk-effects`. The previous all-in-one `@savvy-web/github-action-effects` library is **deleted** — its surface was split across the kit packages (see @./01-dependencies.md).

The package manager is **detected once per run** (`detectPackageManager`, over `@effected/workspaces`' `PackageManagerDetector`) and every dispatch point — config dependencies, install, package-manager upgrade, workspace formatting — routes on that one value. pnpm, bun and npm are supported; yarn is rejected with a clear error.

The `main` phase is organized as **composition over steps**: `src/program.ts` reads inputs, runs the steps in order, folds their results into outputs and reports, while each step's body lives in its own module under `src/steps/`. `program.ts` issues no I/O primitive and builds no strings of its own — log rendering is `src/format.ts`, the input and output contracts are `src/schema/`. It does still call two helpers that read from disk (`readWorkspaceYaml`, `compareLockfiles`); see @./04-module-entry-points.md for why the stronger "performs no I/O" is false and why a grep for primitives cannot detect that.

**Key Features:**

- Upgrades the **detected** package manager (pnpm/bun/npm) via the `upgrade-package-manager` input (`false` — the default — / `true` / `auto` / a semver range), editing the `packageManager` and `devEngines.packageManager` fields directly. corepack-managed managers (pnpm, npm) are written hash-pinned (`pnpm@11.0.0+sha512.<hex>`); bun is written bare. `true`/`auto` stay within the current major, an explicit range may cross majors
- Upgrades `devEngines.runtime` engines (node/deno/bun) via `@effected/runtimes` (`RuntimeUpgrade` service), with `auto`/explicit-range modes and offline/live data sources. It only ever upgrades an entry the manifest already declares (never adds one), and always writes the bare resolved version — the range drives resolution only
- Both manifest writers (`RuntimeUpgrade`, `PackageManagerUpgrade`) apply their changes through `@effected/package-json`'s `PackageJsonFile.modify` — a decode-free JSONC edit at a field path — so the diff this action opens against a consumer's repository shows only the fields it actually changed, with key order, indentation and line endings preserved byte-for-byte, and a byte-identical result skipping the write entirely. The package's schema-decoding read path is deliberately **not** used; it rejects the private workspace root this action must still be able to edit. That is the *same* objection on which the package was previously declined outright — the ruling was **narrowed to one decode-free member, not overturned** (see @./09-project-status.md)
- Updates config dependencies via direct npm queries, resolving within a conservative range synthesized from the current major rather than jumping to npm's absolute latest. Under **pnpm** this edits `pnpm-workspace.yaml` (`ConfigDeps`); under **bun** the same workflow is reproduced by merging the config dependency's `catalogs` export into `package.json` (`CatalogConfigDeps`); **npm** has no `catalog:` protocol, so config dependencies are skipped with a warning
- Updates regular dependencies via direct npm registry queries (avoids `catalogMode: strict` issues), resolving the highest version within each dependency's declared specifier range rather than the absolute latest
- Honors pnpm's `minimumReleaseAge` / `minimumReleaseAgeExclude` settings at resolution time (`ReleaseAge` service over `@effected/npm`'s `ReleaseAgeGate`), holding back too-young versions so it never proposes an update pnpm would reject at install time (`ERR_PNPM_NO_MATURE_MATCHING_VERSION`)
- Syncs peer dependency ranges across workspace packages (`syncPeers` helper) with configurable lock/minor strategies
- Supports glob patterns for dependency matching
- Runs custom commands after updates (linting, testing, building)
- Integrates with Changesets for versioning by delegating the dependency-changeset step to `@savvy-web/silk-effects`' `Changesets.DepsRegen`, which regenerates a consolidated per-package dependency changeset from the cumulative `merge-base(target) → worktree` git diff and applies its own versionable-minus-ignored gating upstream (requires a `fetch-depth: 0` checkout)
- Regenerates the lockfile per package manager (`pnpm clean --lockfile` + `pnpm install --frozen-lockfile=false`; `bun install --force`; remove `package-lock.json` + `npm install`) so it reflects the changed manager version, config and ranges (advancing transitives is expected, not noise)
- Uses GitHub App authentication across a three-phase (pre/main/post) token lifecycle coordinated by `GitHubToken` (from `@effected/github-actions`) for secure, short-lived tokens
- Manages a dedicated update branch via `GitBranch.upsert` (create when absent, force-reset to the source ref when present)
- Creates verified/signed commits via GitHub API (`GitCommit.commitFiles`)
- Creates detailed PR summaries with dependency changes
- Publishes the whole run as a structured **`result`** output — one JSON document (`RunResultDocument`) alongside, never instead of, the four scalar outputs. Every declared output has a value on **every** exit path, and `result` is always parseable: a run that did nothing emits an empty-run document rather than an empty string. The JSON Schema is generated from the same Effect Schema into `docs/schema/run-result.schema.json` and guarded against drift by a test

## Purpose and Goals

**Primary Goals:**

1. **Config Dependency Support**: Fill the gap left by Dependabot's lack of config dependency support
2. **Monorepo Centralization**: Enable centralized dependency management in pnpm monorepos, and reproduce the same workflow for bun catalogs
3. **Automation**: Reduce manual effort in keeping dependencies up-to-date
4. **Safety**: Provide clear visibility into what's being updated via detailed PR summaries
5. **Integration**: Work seamlessly with existing tools (Changesets, CI/CD, code review)
6. **Flexibility**: Support custom commands after updates (linting, testing, building)

**Non-Goals:**

- Replace Dependabot entirely (complementary tool)
- Support yarn — it is detected upstream but rejected here with an `InvalidInputError`, because nothing in the config-dep, install or upgrade paths is wired or tested for it
- Reproduce config dependencies for npm, which has no `catalog:` protocol to merge into
- Automatically merge PRs (requires human review)
- Handle breaking change detection (relies on semver and testing)

## Navigation Guide

Load sections based on what you are working on. Do not load all sections at once.

| Work Context | Section | File |
| --- | --- | --- |
| Runtime deps, key packages, build tooling | Dependencies | @./01-dependencies.md |
| Module structure, data flow, pre/main/post execution | Architecture | @./02-architecture.md |
| Core interfaces, Effect error types, the `result` schema | Type Definitions | @./03-type-definitions.md |
| pre/main/post entry points, input/output contracts, `steps/` | Entry Points | @./04-module-entry-points.md |
| Domain services, layer composition, `format.ts`, pure helpers | Services & Utilities | @./05-module-library.md |
| Service architecture, error handling, retry, resource mgmt | Effect Patterns | @./06-effect-patterns.md |
| Auth, branch mgmt, check runs, PR management | GitHub Integration | @./07-github-integration.md |
| Unit/integration tests, fixtures, coverage | Testing | @./08-testing.md |
| Current state, settled decisions, rationale, related docs | Project Status | @./09-project-status.md |

**Where a given piece of code is documented**, since the layout has three layers
that are easy to confuse:

| code | documented in |
| --- | --- |
| `src/program.ts` — composition only | @./04-module-entry-points.md |
| `src/steps/*.ts` — one module per workflow unit | @./04-module-entry-points.md |
| `src/schema/{inputs,outputs}.ts` — the I/O contracts | @./04-module-entry-points.md |
| `src/schema/domain.ts` — domain + `RunResultDocument` | @./03-type-definitions.md |
| `src/services/*.ts` — capabilities | @./05-module-library.md |
| `src/format.ts` — the log rendering surface | @./05-module-library.md |
| `src/utils/*.ts` — pure helpers | @./05-module-library.md |
