# Contributing

Thank you for your interest in contributing! This document provides guidelines
and instructions for development.

## Prerequisites

- [Node.js](https://nodejs.org) — see `devEngines.runtime` in `package.json` for the pinned version
- [pnpm](https://pnpm.io) — see `devEngines.packageManager` in `package.json` for the pinned version
- A GitHub account for pull requests

## Development Setup

```bash
# Clone the repository
git clone https://github.com/savvy-web/silk-update-action.git
cd silk-update-action

# Install dependencies
pnpm install

# Build the action
pnpm run build

# Run tests
pnpm run test
```

## Project Structure

```text
silk-update-action/
├── src/
│   ├── pre.ts                  # Pre phase — provision GitHub App token
│   ├── main.ts                 # Main phase — thin Action.run(program) wrapper
│   ├── post.ts                 # Post phase — report duration, revoke token
│   ├── program.ts              # Main-phase composition — reads inputs, runs the steps
│   ├── format.ts               # Rendering surface for the run's log output
│   ├── state.ts                # Cross-phase state (StartTimeState, STATE_KEYS)
│   ├── errors/                 # Schema.TaggedError definitions
│   ├── schema/                 # Effect Schema domain, input and output definitions
│   ├── steps/                  # One module per orchestration unit
│   ├── layers/                 # Layer composition (makeAppLayer)
│   ├── services/               # Domain services (Context.Service + Layer)
│   └── utils/                  # Pure helpers (deps, markdown, pnpm, runtime, semver)
├── dist/                       # Built action output (bundled)
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
| `pnpm run typecheck` | Type-check with `tsc` |
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

Tests use [Vitest](https://vitest.dev) with v8 coverage. The coverage thresholds come from `@vitest-agent/plugin`'s strict preset and are enforced across the whole run rather than per file, so a green run is not evidence that any one module was exercised — see `vitest.config.ts` for the current values.

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
