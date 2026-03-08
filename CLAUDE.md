# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Project Status

This is a **GitHub Action** for updating pnpm config dependencies and regular
dependencies. It runs as a single-phase entry point (`main.ts`) using Effect-TS
for typed error handling, service injection, and retry logic. All services come
from `@savvy-web/github-action-effects` (v0.4.0).

For architecture and implementation details, load sections as needed:
-> @./.claude/design/pnpm-config-dependency-action/_index.md

Load the index first, then follow its navigation guide to load specific
sections based on what you are working on. Do not load all sections at once.

Key sections:

- Single-phase entry point: -> @./04-module-entry-points.md
- Library modules (pnpm, github, lockfile): -> @./05-module-library.md
- Effect-TS patterns and services: -> @./06-effect-patterns.md
- GitHub API integration: -> @./07-github-integration.md
- Type definitions: -> @./03-type-definitions.md
- Architecture overview: -> @./02-architecture.md

Skip for simple bug fixes or test-only changes.

## Commands

### Development

```bash
pnpm run lint              # Check code with Biome
pnpm run lint:fix          # Auto-fix lint issues
pnpm run typecheck         # Type-check via Turbo
pnpm run test              # Run all tests
pnpm run test:watch        # Run tests in watch mode
pnpm run test:coverage     # Run tests with coverage report
```

### Building

```bash
pnpm run build             # Build all packages (dev + prod)
pnpm run build:prod        # Build production/npm output only
```

### Running a Single Test

```bash
# Run a specific test file
pnpm vitest run src/lib/pnpm/regular.test.ts

# Run tests matching a pattern
pnpm vitest run --testNamePattern="parsePnpmVersion"
```

## Architecture

### Repository Structure

- **Type**: Single-package GitHub Action (not a multi-package monorepo)
- **Entry point**: `src/main.ts` (single-phase, no pre/post)
- **Modules**: `src/lib/` (github/, pnpm/, lockfile/, changeset/, errors/, schemas/)
- **Shared Configs**: `lib/configs/`
- **Build**: Turbo for caching; `typecheck` depends on `build`

### Effect-TS Patterns

- **Services**: All from `@savvy-web/github-action-effects`: `CommandRunner`,
  `GitBranch`, `GitCommit`, `CheckRun`, `GitHubClient`, `AutoMerge`, `GitHubApp`
- **Errors**: `Schema.TaggedError` (`PnpmError`, `GitHubApiError`, `FileSystemError`)
- **Entry**: `Action.run(program, GitHubAppLive)` with `Action.parseInputs()`
- **Token**: `GitHubApp.withToken()` for automatic token lifecycle
- **Tests**: Mock services via Effect `Layer.succeed`; `vi.mock()` for
  `@actions/core` and `@actions/github`

### Code Quality

- **Biome**: Unified linting and formatting (tabs for indentation)
- **Commitlint**: Conventional commits with DCO signoff
- **Husky Hooks**:
  - `pre-commit`: Runs lint-staged
  - `commit-msg`: Validates commit message format
  - `pre-push`: Runs tests for affected packages

### TypeScript Configuration

- Composite builds with project references
- Strict mode enabled
- ES2022/ES2023 targets
- Import extensions required (`.js` for ESM)

### Testing

- **Framework**: Vitest with v8 coverage
- **Pool**: Uses forks (not threads) for Effect-TS compatibility
- **Config**: `vitest.config.ts` supports project-based filtering via
  `--project` flag

## Conventions

### Imports

- Use `.js` extensions for relative imports (ESM requirement)
- Use `node:` protocol for Node.js built-ins
- Separate type imports: `import type { Foo } from './bar.js'`

### Commits

All commits require:

1. Conventional commit format (feat, fix, chore, etc.)
2. DCO signoff: `Signed-off-by: Name <email>`
3. No markdown in commit body (commitlint `silk/body-no-markdown` rule)

### Publishing

Packages publish to both GitHub Packages and npm with provenance.

## Gotchas

- Biome enforces **tabs** for indentation (not spaces)
- GraphQL API required for auto-merge (no REST endpoint exists)
- `PullRequest` type includes `nodeId` for GraphQL API calls
- `@actions/core` is never imported directly (transitive via library)
- `@actions/github` is only imported for `context.sha` in `main.ts`
