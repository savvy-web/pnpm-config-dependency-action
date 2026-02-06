# Architecture Overview

This document describes the high-level architecture of the pnpm Config
Dependency Action.

## Table of Contents

- [Design Principles](#design-principles)
- [Three-Phase Execution](#three-phase-execution)
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

## Three-Phase Execution

GitHub Actions supports `pre`, `main`, and `post` scripts. The action uses all
three phases:

### Pre Phase (`src/pre.ts`)

Runs before the main action. Responsible for:

- Reading the `app-id` and `app-private-key` inputs
- Authenticating as the GitHub App and generating a JWT
- Exchanging the JWT for a short-lived installation token
- Saving the token, installation ID, and app slug to state (persisted across
  phases via `@actions/core`)

### Main Phase (`src/main.ts`)

The core orchestration logic. Executes 13 steps sequentially:

1. Setup (parse inputs, retrieve token, create check run)
2. Branch management (create or reset the update branch)
3. Capture lockfile state (before)
4. Update config dependencies
5. Run `pnpm install`
6. Update regular dependencies
7. Format `pnpm-workspace.yaml`
8. Run custom commands (if specified)
9. Capture lockfile state (after)
10. Detect changes (lockfile diff + git status)
11. Create changesets (if `.changeset/` exists)
12. Commit and push (via GitHub API)
13. Create or update PR

See [Execution Phases](./execution-phases.md) for detailed information on each
step.

### Post Phase (`src/post.ts`)

Runs after the main action completes (even on failure). Responsible for:

- Revoking the GitHub App installation token (unless `skip-token-revoke` is
  set)
- Logging total execution time

## Module Structure

```text
src/
├── pre.ts                     # Phase 1: Token generation
├── main.ts                    # Phase 2: Orchestration
├── post.ts                    # Phase 3: Cleanup
├── lib/
│   ├── inputs.ts              # Input parsing with Effect Schema validation
│   ├── logging.ts             # Debug-aware logging utilities
│   ├── errors/types.ts        # Re-exports from schemas/errors
│   ├── schemas/
│   │   ├── index.ts           # Effect Schema definitions for all types
│   │   └── errors.ts          # TaggedError definitions
│   ├── services/index.ts      # Effect service layers (GitHub, Git, pnpm)
│   ├── github/
│   │   ├── auth.ts            # GitHub App JWT + installation token
│   │   └── branch.ts          # Branch management + API commits
│   ├── pnpm/
│   │   └── format.ts          # pnpm-workspace.yaml formatting
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
| [@actions/core](https://github.com/actions/toolkit) | GitHub Actions input/output, state persistence, logging |
| [@octokit/rest](https://octokit.github.io/rest.js) | GitHub REST API client |
| [@octokit/auth-app](https://github.com/octokit/auth-app.js) | GitHub App JWT and installation token generation |
| [@effect/platform](https://effect.website) | Cross-platform command execution |
| [@pnpm/lockfile.fs](https://pnpm.io) | Official pnpm lockfile reader |
| [workspace-tools](https://github.com/nicolo-ribaudo/workspace-tools) | Workspace package detection |
| [yaml](https://eemeli.org/yaml) | YAML parsing and stringifying |

### Why Effect?

The action uses Effect for three main reasons:

1. **Typed errors**: Every function signature declares what errors it can
   produce. The compiler ensures all errors are handled.
2. **Service layers**: The `GitHubClient`, `GitExecutor`, and `PnpmExecutor`
   services are injected via Effect's Layer system, enabling clean testing and
   composition.
3. **Error accumulation**: When updating multiple dependencies, failures are
   collected rather than stopping the entire workflow.

## Data Flow

The main phase follows this data flow:

```text
Inputs (action.yml)
  │
  ├─ config-dependencies ──> pnpm add --config ──> version changes
  ├─ dependencies ──────────> pnpm up --latest ──> version changes
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
