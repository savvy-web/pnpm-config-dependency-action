# Getting Started

This guide walks you through setting up the pnpm Config Dependency Action in
your repository.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Step 1: Create a GitHub App](#step-1-create-a-github-app)
- [Step 2: Add Secrets](#step-2-add-secrets)
- [Step 3: Create the Workflow](#step-3-create-the-workflow)
- [Step 4: Verify](#step-4-verify)

## Prerequisites

Before setting up the action, ensure your repository meets these requirements:

- Uses **pnpm** as its package manager
- Has a `pnpm-workspace.yaml` file (for monorepo or config dependency support)
- Has a GitHub App with the required permissions (see
  [GitHub App Setup](./github-app-setup.md))

## Step 1: Create a GitHub App

The action authenticates using a GitHub App to generate short-lived tokens with
fine-grained permissions. This is more secure than personal access tokens.

Follow the [GitHub App Setup](./github-app-setup.md) guide to create and
configure your app.

**Required permissions:**

- `contents: write` -- Push commits and manage branches
- `pull-requests: write` -- Create and update pull requests
- `checks: write` -- Create check runs for status visibility

## Step 2: Add Secrets

Store the GitHub App credentials as repository or organization secrets:

1. Go to **Settings > Secrets and variables > Actions**
2. Add `APP_ID` -- Your GitHub App's ID
3. Add `APP_PRIVATE_KEY` -- Your GitHub App's private key (PEM format)

## Step 3: Create the Workflow

Create `.github/workflows/update-deps.yml`:

```yaml
name: Update Dependencies
on:
  schedule:
    - cron: "0 6 * * 1" # Weekly on Monday at 6am UTC
  workflow_dispatch: # Allow manual triggers

permissions:
  contents: write
  pull-requests: write
  checks: write

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "24"

      - uses: savvy-web/pnpm-config-dependency-action@main
        with:
          app-id: ${{ secrets.APP_ID }}
          app-private-key: ${{ secrets.APP_PRIVATE_KEY }}
          config-dependencies: |
            typescript
            @biomejs/biome
          dependencies: |
            effect
            @effect/*
          run: |
            pnpm lint:fix
            pnpm test
```

### Choosing Dependencies

**Config dependencies** (`config-dependencies` input) are packages declared in
your `pnpm-workspace.yaml` under `configDependencies`. List them one per line
with exact package names:

```yaml
config-dependencies: |
  typescript
  @biomejs/biome
  @savvy-web/pnpm-plugin-silk
```

**Regular dependencies** (`dependencies` input) are packages in your workspace
`package.json` files. Glob patterns are supported:

```yaml
dependencies: |
  effect
  @effect/*
  @savvy-web/*
```

## Step 4: Verify

1. Trigger the workflow manually from the **Actions** tab
2. The action will:
   - Generate a GitHub App token
   - Create or reset the update branch (default: `pnpm/config-deps`)
   - Update the specified dependencies
   - Run any post-update commands
   - Create a pull request with a summary of changes
3. Review the pull request for correctness

### Dry Run Mode

To test the action without creating commits or pull requests, enable dry-run
mode:

```yaml
- uses: savvy-web/pnpm-config-dependency-action@main
  with:
    app-id: ${{ secrets.APP_ID }}
    app-private-key: ${{ secrets.APP_PRIVATE_KEY }}
    config-dependencies: |
      typescript
    dry-run: true
```

The action will detect changes and report them in the GitHub Actions summary
without modifying the repository.

## Next Steps

- [Configuration](./configuration.md) -- Explore all input options and advanced
  patterns
- [Troubleshooting](../troubleshooting.md) -- Common issues and solutions
