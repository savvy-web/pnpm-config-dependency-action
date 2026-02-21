---
status: current
module: pnpm-config-dependency-action
category: architecture
created: 2026-02-06
updated: 2026-02-20
last-synced: 2026-02-20
completeness: 90
related: []
dependencies: []
implementation-plans: []
---

# pnpm Config Dependency Action

## Overview

The `pnpm-config-dependency-action` is a GitHub Action that automates updates to pnpm config dependencies
and regular dependencies. Unlike Dependabot, this action supports
[pnpm's config dependencies](https://pnpm.io/config-dependencies) feature, which allows dependencies to be
declared in `pnpm-workspace.yaml` for centralized version management across a monorepo.

**Key Features:**

- Upgrades pnpm itself to the latest version within the `^` semver range via `corepack use`
- Updates config dependencies via `pnpm add --config`
- Updates regular dependencies via direct npm registry queries (avoids `catalogMode: strict` issues)
- Supports glob patterns for dependency matching
- Runs custom commands after updates (linting, testing, building)
- Integrates with Changesets for versioning
- Uses GitHub App authentication for secure, short-lived tokens
- Manages dedicated update branch with automatic rebasing
- Creates verified/signed commits via GitHub API
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
| Module structure, data flow, 14-step execution | Architecture | @./02-architecture.md |
| Core interfaces, Effect error types | Type Definitions | @./03-type-definitions.md |
| pre.ts, main.ts, post.ts breakdowns | Entry Points | @./04-module-entry-points.md |
| All src/lib/ modules (inputs, github, pnpm, lockfile, changeset) | Library Modules | @./05-module-library.md |
| Service architecture, error handling, retry, resource mgmt | Effect Patterns | @./06-effect-patterns.md |
| Auth, branch mgmt, check runs, PR management | GitHub Integration | @./07-github-integration.md |
| Unit/integration tests, fixtures, coverage | Testing | @./08-testing.md |
| Implementation plan, current state, rationale, related docs | Project Status | @./09-project-status.md |
