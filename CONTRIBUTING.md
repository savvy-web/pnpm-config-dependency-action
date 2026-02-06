# Contributing

Thank you for your interest in contributing! This document provides guidelines
and instructions for development.

## Prerequisites

- [Node.js](https://nodejs.org) 24.11.0+
- [pnpm](https://pnpm.io) 10.28.2+
- A GitHub account for pull requests

## Development Setup

```bash
# Clone the repository
git clone https://github.com/savvy-web/pnpm-config-dependency-action.git
cd pnpm-config-dependency-action

# Install dependencies
pnpm install

# Build the action
pnpm run build

# Run tests
pnpm run test
```

## Project Structure

```text
pnpm-config-dependency-action/
├── src/
│   ├── pre.ts                  # Token generation phase
│   ├── main.ts                 # Main orchestration logic
│   ├── post.ts                 # Cleanup and token revocation
│   ├── lib/
│   │   ├── inputs.ts           # Action input parsing
│   │   ├── logging.ts          # Structured logging
│   │   ├── errors/             # Typed error definitions
│   │   ├── schemas/            # Effect Schema definitions
│   │   ├── services/           # Effect service layers
│   │   ├── github/             # GitHub API integration
│   │   ├── pnpm/               # pnpm command execution
│   │   ├── changeset/          # Changeset creation
│   │   └── lockfile/           # Lockfile comparison
│   └── types/                  # Shared type definitions
├── dist/                       # Built action output
├── action.yml                  # GitHub Action metadata
└── docs/                       # User documentation
```

## Available Scripts

| Script | Description |
| --- | --- |
| `pnpm run build` | Build all packages (dev + prod) |
| `pnpm run build:prod` | Build production action bundle |
| `pnpm run test` | Run all tests |
| `pnpm run test:watch` | Run tests in watch mode |
| `pnpm run test:coverage` | Run tests with coverage report |
| `pnpm run lint` | Check code with Biome |
| `pnpm run lint:fix` | Auto-fix lint issues |
| `pnpm run typecheck` | Type-check via tsgo |
| `pnpm run validate` | Validate GitHub Action configuration |

## Code Quality

This project uses:

- **[Biome](https://biomejs.dev)** for linting and formatting (tab indentation,
  120 character line width)
- **[Commitlint](https://commitlint.js.org)** for enforcing conventional
  commits with DCO signoff
- **[Husky](https://typicode.github.io/husky)** for Git hooks
- **[Effect](https://effect.website)** for typed error handling and service
  composition

### Commit Format

All commits must follow the
[Conventional Commits](https://conventionalcommits.org) specification and
include a DCO signoff:

```text
feat: add new feature

Signed-off-by: Your Name <your.email@example.com>
```

### Pre-commit Hooks

The following checks run automatically:

- **pre-commit**: Runs lint-staged (Biome formatting and linting)
- **commit-msg**: Validates commit message format
- **pre-push**: Runs tests for affected packages

## Testing

Tests use [Vitest](https://vitest.dev) with v8 coverage. Coverage thresholds
are set at 85% per file for lines, functions, branches, and statements.

```bash
# Run all tests
pnpm run test

# Run tests in watch mode
pnpm run test:watch

# Run tests with coverage
pnpm run test:coverage
```

## TypeScript

- Strict mode enabled
- ES2022 target
- ESNext module system with bundler resolution

### Import Conventions

```typescript
// Use .js extensions for relative imports (ESM requirement)
import { myFunction } from "./utils/helpers.js";

// Use node: protocol for Node.js built-ins
import { readFileSync } from "node:fs";

// Separate type imports
import type { MyType } from "./types.js";
```

## Submitting Changes

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make your changes
4. Run checks: `pnpm run lint:fix && pnpm run test && pnpm run typecheck`
5. Commit with conventional format and DCO signoff
6. Push and open a pull request

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](./LICENSE).
