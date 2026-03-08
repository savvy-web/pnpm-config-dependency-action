---
"pnpm-config-dependency-action": minor
---

## Breaking Changes

- Collapse three-phase execution (pre/main/post) into single-phase architecture
- Remove `skip-token-revoke` and `log-level` inputs from action.yml
- Remove `token` output from action.yml

## Features

- Upgrade @savvy-web/github-action-effects from v0.3.0 to v0.4.0
- Use `GitHubApp.withToken()` bracket pattern for automatic token lifecycle management
- Use `CheckRun.withCheckRun()` bracket pattern for check run lifecycle
- Use `Action.parseInputs()` for declarative, Schema-based input parsing
- Replace custom services (GitHubClient, GitExecutor, PnpmExecutor) with library equivalents (CommandRunner, GitBranch, GitCommit, GitHubClient)
- Use `AutoMerge.enable()` from library for auto-merge support
