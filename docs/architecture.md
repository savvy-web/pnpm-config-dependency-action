# Architecture Overview

This document describes the high-level architecture of the pnpm Config
Dependency Action.

## Table of Contents

- [Design Principles](#design-principles)
- [Single-Phase Execution](#single-phase-execution)
- [Module Structure](#module-structure)
- [Technology Stack](#technology-stack)
- [Data Flow](#data-flow)

## Design Principles

The action is built around these principles:

1. **Safety first**: Changes are visible before merging via detailed PR
   summaries. Verified commits provide authenticity. Short-lived tokens
   minimize exposure.
2. **Resilience**: Individual dependency update failures do not block the
   entire workflow. Errors are accumulated and reported rather than causing
   immediate failure.
3. **Transparency**: Every step is logged, check runs provide status
   visibility in the GitHub UI, and PR descriptions include full change tables.
4. **Complementary to Dependabot**: The action fills a specific gap (config
   dependencies) rather than replacing Dependabot entirely.

## Single-Phase Execution

The action runs as a single `main.ts` entry point. Token lifecycle is managed
automatically by `GitHubApp.withToken()`, which generates a GitHub App
installation token at the start and revokes it on exit (success or failure).

### Main Phase (`src/main.ts`)

The core orchestration logic. Executes 14 steps sequentially:

1. Setup (parse inputs, generate token, create check run)
2. Branch management (create or reset the update branch)
3. Capture lockfile state (before)
4. Upgrade pnpm (if `update-pnpm` is enabled)
5. Update config dependencies
6. Update regular dependencies
7. Clean install (remove `node_modules` and `pnpm-lock.yaml`, then
   `pnpm install`)
8. Format `pnpm-workspace.yaml`
9. Run custom commands (if specified)
10. Capture lockfile state (after)
11. Detect changes (lockfile diff + git status)
12. Create changesets (if `.changeset/` exists)
13. Commit and push (via GitHub API)
14. Create or update PR

See [Execution Phases](./execution-phases.md) for detailed information on each
step.

## Module Structure

```text
src/
├── main.ts                    # Single entry point (Action.run)
├── lib/
│   ├── schemas/
│   │   ├── index.ts           # Effect Schema definitions for all types
│   │   └── errors.ts          # TaggedError definitions
│   ├── github/
│   │   └── branch.ts          # Branch management + API commits
│   ├── pnpm/
│   │   ├── config.ts          # Config dependency updates
│   │   ├── regular.ts         # Regular dependency updates
│   │   ├── format.ts          # pnpm-workspace.yaml formatting
│   │   └── upgrade.ts         # pnpm version upgrade logic
│   ├── changeset/
│   │   └── create.ts          # Changeset file generation
│   └── lockfile/
│       └── compare.ts         # Lockfile snapshot comparison
└── types/index.ts             # Re-exports from schemas
```

## Technology Stack

| Technology | Purpose |
| --- | --- |
| [Effect](https://effect.website) | Typed error handling, service composition, schema validation |
| [@savvy-web/github-action-effects](https://github.com/savvy-web/github-action-effects) | GitHub Actions services: inputs, outputs, token lifecycle, check runs, git operations, markdown helpers |
| [@effect/platform](https://effect.website) | Cross-platform command execution |
| [@pnpm/lockfile.fs](https://pnpm.io) | Official pnpm lockfile reader |
| [workspace-tools](https://github.com/nicolo-ribaudo/workspace-tools) | Workspace package detection |
| [yaml](https://eemeli.org/yaml) | YAML parsing and stringifying |

### Why Effect?

The action uses Effect for three main reasons:

1. **Typed errors**: Every function signature declares what errors it can
   produce. The compiler ensures all errors are handled.
2. **Service layers**: Services like `GitHubClient`, `CommandRunner`,
   `GitBranch`, and `GitCommit` are injected via Effect's Layer system,
   enabling clean testing and composition.
3. **Error accumulation**: When updating multiple dependencies, failures are
   collected rather than stopping the entire workflow.

## Data Flow

The main phase follows this data flow:

```text
Inputs (action.yml)
  │
  ├─ update-pnpm ───────────> upgradePnpm() ──────> version change
  ├─ config-dependencies ──> pnpm add --config ──> version changes
  ├─ dependencies ──────────> npm registry query ─> version changes
  │
  ├─ Lockfile (before) ───┐
  ├─ Lockfile (after) ────┤──> compareLockfiles() ──> LockfileChange[]
  │                       │
  │                       ├──> Catalog changes (shared versions)
  │                       └──> Importer changes (per-package deps)
  │
  ├─ LockfileChange[] ────> groupChangesByPackage() ──> createChangesets()
  │
  └─ All changes ─────────> commitChanges() ──> createOrUpdatePR()
                                │
                                ├── GitHub API: createTree()
                                ├── GitHub API: createCommit() [no author = verified]
                                └── GitHub API: updateRef()
```

### Commit Verification

Commits are created through the GitHub Git Data API rather than `git commit`.
When a GitHub App token is used and no explicit author is passed to the
`createCommit` API call, GitHub attributes the commit to the App and
automatically signs it. This produces the "Verified" badge in the GitHub UI.
