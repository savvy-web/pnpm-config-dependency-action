---
status: current
module: pnpm-config-dependency-action
category: architecture
created: 2026-02-06
updated: 2026-04-27
last-synced: 2026-04-27
completeness: 95
related: []
dependencies: []
implementation-plans: []
---

# pnpm Config Dependency Action

## Overview

The `pnpm-config-dependency-action` is a GitHub Action that automates updates to pnpm config dependencies,
regular dependencies, and peer dependencies. Unlike Dependabot, this action supports
[pnpm's config dependencies](https://pnpm.io/config-dependencies) feature, which allows dependencies to be
declared in `pnpm-workspace.yaml` for centralized version management across a monorepo. It also syncs peer
dependency ranges across workspace packages to keep them consistent.

**Key Features:**

- Upgrades pnpm itself to the latest version within the `^` semver range via `corepack use`
- Updates config dependencies via direct npm queries and YAML editing
- Updates regular dependencies via direct npm registry queries (avoids `catalogMode: strict` issues)
- Syncs peer dependency ranges across workspace packages (`syncPeers` helper) with configurable lock/minor strategies
- Supports glob patterns for dependency matching
- Runs custom commands after updates (linting, testing, building)
- Integrates with Changesets for versioning, with publishability- and
  `versionPrivate`-aware gating via the `Workspaces`, `ChangesetConfig`, and
  `Publishability` services (built on `workspaces-effect`)
- Reconciles the lockfile via `pnpm install --frozen-lockfile=false --fix-lockfile`
- Uses GitHub App authentication via `GitHubApp.withToken()` for secure, short-lived tokens
- Manages dedicated update branch with delete-and-recreate strategy
- Creates verified/signed commits via GitHub API (`GitCommit.commitFiles`)
- Creates detailed PR summaries with dependency changes

## Purpose and Goals

**Primary Goals:**

1. **Config Dependency Support**: Fill the gap left by Dependabot's lack of config dependency support
2. **Monorepo Centralization**: Enable centralized dependency management in pnpm monorepos
3. **Automation**: Reduce manual effort in keeping dependencies up-to-date
4. **Safety**: Provide clear visibility into what's being updated via detailed PR summaries
5. **Integration**: Work seamlessly with existing tools (Changesets, CI/CD, code review)
6. **Flexibility**: Support custom commands after updates (linting, testing, building)

**Non-Goals:**

- Replace Dependabot entirely (complementary tool)
- Support other package managers (pnpm-specific)
- Automatically merge PRs (requires human review)
- Handle breaking change detection (relies on semver and testing)

## Navigation Guide

Load sections based on what you are working on. Do not load all sections at once.

| Work Context | Section | File |
| --- | --- | --- |
| Runtime deps, key packages | Dependencies | @./01-dependencies.md |
| Module structure, data flow, single-phase execution | Architecture | @./02-architecture.md |
| Core interfaces, Effect error types | Type Definitions | @./03-type-definitions.md |
| main.ts + program.ts entry points | Entry Point | @./04-module-entry-points.md |
| Domain services, layer composition, pure helpers | Services & Utilities | @./05-module-library.md |
| Service architecture, error handling, retry, resource mgmt | Effect Patterns | @./06-effect-patterns.md |
| Auth, branch mgmt, check runs, PR management | GitHub Integration | @./07-github-integration.md |
| Unit/integration tests, fixtures, coverage | Testing | @./08-testing.md |
| Implementation plan, current state, rationale, related docs | Project Status | @./09-project-status.md |
