---
"pnpm-config-dependency-action": minor
---

## Features

Migrate to @savvy-web/github-action-effects v0.11 API, replacing legacy
`@actions/*` imports and `Action.parseInputs()` with the modern library API.

- Use Effect's `Config.*` API for typed input parsing
- Use `ActionEnvironment` for GitHub context (SHA, repository)
- Use `Redacted` for secure private key handling
- Separate program logic from entry point for clean test imports
- Wire `OctokitAuthAppLive` and `GitHubClientLive` layers for GitHub App auth
