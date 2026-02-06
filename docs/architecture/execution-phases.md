# Execution Phases

Detailed breakdown of the 13-step workflow executed in the main phase.

## Table of Contents

- [Step 1: Setup](#step-1-setup)
- [Step 2: Branch Management](#step-2-branch-management)
- [Step 3: Capture Lockfile (Before)](#step-3-capture-lockfile-before)
- [Step 4: Update Config Dependencies](#step-4-update-config-dependencies)
- [Step 5: Run pnpm Install](#step-5-run-pnpm-install)
- [Step 6: Update Regular Dependencies](#step-6-update-regular-dependencies)
- [Step 7: Format pnpm-workspace.yaml](#step-7-format-pnpm-workspaceyaml)
- [Step 8: Run Custom Commands](#step-8-run-custom-commands)
- [Step 9: Capture Lockfile (After)](#step-9-capture-lockfile-after)
- [Step 10: Detect Changes](#step-10-detect-changes)
- [Step 11: Create Changesets](#step-11-create-changesets)
- [Step 12: Commit and Push](#step-12-commit-and-push)
- [Step 13: Create or Update PR](#step-13-create-or-update-pr)

## Step 1: Setup

- Retrieves the GitHub App installation token from state (saved by the pre
  phase)
- Parses and validates all action inputs using Effect Schema
- Validates that at least one of `config-dependencies` or `dependencies` is
  specified
- Creates a GitHub check run for status visibility in the UI

## Step 2: Branch Management

- Checks whether the update branch already exists
- If the branch does not exist: creates it from `main` using the GitHub API,
  then fetches and checks it out locally
- If the branch exists: deletes it and recreates it from `main` to ensure a
  clean baseline
- This reset strategy guarantees the PR always shows only the dependency changes
  against the current `main`

## Step 3: Capture Lockfile (Before)

- Reads the current `pnpm-lock.yaml` using `@pnpm/lockfile.fs`
- Stores the lockfile object in memory for later comparison
- Logs package and importer counts in debug mode

## Step 4: Update Config Dependencies

- Iterates over each config dependency listed in the input
- For each dependency:
  - Records the current version from `pnpm-workspace.yaml`
  - Runs `pnpm add --config <dependency>`
  - Records the new version
- Uses error accumulation: if one dependency fails to update, the others still
  proceed
- Failed updates are logged as warnings but do not stop the workflow

## Step 5: Run pnpm Install

- Runs `pnpm install` to resolve and update the lockfile
- Only runs if there are config or regular dependencies to update
- This ensures all transitive dependencies are correctly resolved

## Step 6: Update Regular Dependencies

- Iterates over each dependency pattern listed in the input
- Runs `pnpm up <pattern> --latest` for each pattern
- Supports glob patterns (e.g., `@effect/*`)
- Uses the same error accumulation pattern as config dependency updates

## Step 7: Format pnpm-workspace.yaml

- Reads and parses `pnpm-workspace.yaml`
- Sorts array values alphabetically (`packages`, `onlyBuiltDependencies`,
  `publicHoistPattern`)
- Sorts top-level keys alphabetically (with `packages` kept first)
- Writes back with consistent YAML formatting (2-space indent, no line wrapping,
  double quotes)
- This formatting matches the `@savvy-web/lint-staged` PnpmWorkspace handler to
  prevent lint-staged from making additional changes after commit

## Step 8: Run Custom Commands

- Executes commands from the `run` input sequentially via `sh -c`
- All commands are attempted regardless of individual failures
- If any command fails:
  - The check run is updated with a failure conclusion
  - Failure details are included in the check run summary
  - The action exits early without creating a PR or committing
  - Outputs `has-changes: false` and `updates-count: 0`

## Step 9: Capture Lockfile (After)

- Reads the updated `pnpm-lock.yaml` after all dependency changes
- Stores the updated lockfile object for comparison

## Step 10: Detect Changes

Change detection uses two complementary methods:

### Lockfile Comparison

Compares the before and after lockfile objects:

- **Catalog changes**: Compares catalog snapshots (`catalog:default`,
  `catalog:silk`, etc.) to detect shared version updates. For each changed
  catalog entry, scans importers to find which packages use that catalog
  reference.
- **Importer changes**: Compares per-package specifiers (non-catalog) to detect
  direct dependency version changes.

### Git Status

Runs `git status --porcelain` to detect any modified, staged, or untracked
files. If both the lockfile comparison and git status show no changes, the
action exits early with a "neutral" check run conclusion.

## Step 11: Create Changesets

- Checks whether a `.changeset/` directory exists
- Groups lockfile changes by affected package
- Creates a `patch` changeset for each workspace package with dependency changes
- Creates an empty changeset (no packages) for config-only changes
- Changeset files are written to `.changeset/<random-id>.md` with a formatted
  summary of the dependency changes

## Step 12: Commit and Push

Commits are created through the GitHub Git Data API rather than `git commit`:

1. Collects all changed files from git status
2. Reads file contents and builds a tree of blob entries
3. Creates a new tree using `git.createTree` with the current HEAD tree as base
4. Creates a commit using `git.createCommit` with a conventional commit message
   and DCO signoff (no explicit author, which enables GitHub verification)
5. Updates the branch ref to point to the new commit using `git.updateRef`
6. Fetches and checks out the updated branch locally

In dry-run mode, this step is skipped entirely.

## Step 13: Create or Update PR

- Searches for an existing open PR from the update branch to `main`
- If a PR exists: updates its title and body with the latest dependency changes
- If no PR exists: creates a new PR
- The PR body includes:
  - A summary of config and regular dependency changes in table format
  - Changeset details in expandable sections
  - Links to npm for each updated package
- Sets action outputs (`pr-number`, `pr-url`, `updates-count`, `has-changes`)
- Writes a GitHub Actions job summary with the same information

In dry-run mode, this step is skipped and a PR body preview is included in the
job summary instead.
