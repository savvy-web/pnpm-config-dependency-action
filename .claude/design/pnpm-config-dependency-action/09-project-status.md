# Project Status

[Back to index](./_index.md)

## Current State

**Status:** v0.4.0 architecture migration complete. Single-phase entry point with
all services from `@savvy-web/github-action-effects` v0.4.0.

**Architecture (v0.4.0):**

- **Single-phase design:** `main.ts` is the only entry point. `pre.ts`, `post.ts`,
  and `github/auth.ts` have been deleted. Token lifecycle handled by
  `GitHubApp.withToken()`.
- **Library services only:** Custom services (`GitHubClient`, `GitExecutor`,
  `PnpmExecutor` from `src/lib/services/index.ts`) have been deleted. All services
  come from the library: `CommandRunner`, `GitBranch`, `GitCommit`, `CheckRun`,
  `GitHubClient`, `AutoMerge`.
- **Declarative inputs:** `src/lib/inputs.ts` deleted. Input parsing uses
  `Action.parseInputs()` directly in `main.ts`.
- **Simplified action.yml:** No `pre`/`post` entries. Removed `skip-token-revoke`,
  `log-level` inputs and `token` output.

**Implemented Features:**

- Single-phase execution model with 16 steps
- GitHub App token lifecycle via `GitHubApp.withToken()`
- Branch management with delete-and-recreate strategy via `GitBranch` service
- Config dependency updates via direct npm queries and YAML editing
- Regular dependency updates via direct npm queries (compatible with `catalogMode: strict`)
- pnpm self-upgrade via `corepack use` with `packageManager` and `devEngines` field support
- Clean install after updates
- Workspace YAML formatting
- Custom command execution via `CommandRunner` with error collection
- Lockfile comparison for change detection
- Changeset creation for affected packages
- Verified commits via `GitCommit` service (GitHub API)
- PR creation and update with Dependabot-style formatting via `GitHubClient`
- Auto-merge support via `AutoMerge.enable()` (GraphQL API)
- Check run lifecycle via `CheckRun.withCheckRun()`
- Configurable changeset creation via `changesets` input (boolean, default: `true`)
- Dry-run mode for testing

**Deleted Modules (v0.4.0 migration):**

- `src/pre.ts` - Token generation (replaced by `GitHubApp.withToken()`)
- `src/post.ts` - Token revocation (handled automatically by `GitHubApp.withToken()`)
- `src/lib/github/auth.ts` - Custom auth logic (replaced by `GitHubApp` service)
- `src/lib/inputs.ts` - Input parsing (replaced by `Action.parseInputs()`)
- `src/lib/services/index.ts` - Custom services (replaced by library services)

**Deleted Types (v0.4.0 migration):**

- `InstallationToken` - Handled internally by `GitHubApp.withToken()`
- `AuthenticatedClient` - Replaced by `GitHubClient` service
- `GitHubContext` - Replaced by `GitHubClient.repo`
- `ActionInputs` schema - Replaced by `Action.parseInputs()` declarative API
- `AuthenticationError` - Handled by library
- `CheckRun` schema (domain type) - Replaced by `CheckRun` service
- `ActionResult` - No longer needed

**Next Steps:**

1. Integration testing with real GitHub App in CI
2. Documentation: user guide and troubleshooting
3. Support for additional changeset strategies beyond patch

## Rationale

### Why Effect Instead of Plain TypeScript/Promises?

**Type-Safe Error Handling:**

Effect's type system makes errors explicit in function signatures. You can see at a glance what errors
a function might produce, and the compiler ensures you handle them.

**Error Accumulation:**

GitHub Actions should be resilient. If updating 10 dependencies, and 2 fail, we want to:

1. Continue with the other 8
2. Report all failures at the end
3. Still create a PR with successful updates

Effect makes this pattern easy with `Effect.all`, `Effect.either`, and custom error types.

**Resource Management:**

GitHub App tokens and check runs need proper lifecycle management. Effect's resource
patterns (like `acquireUseRelease` used by `GitHubApp.withToken()` and
`CheckRun.withCheckRun()`) ensure cleanup always happens.

**Testing:**

Effect programs are pure and composable, making them easier to test. Services can be
mocked via `Layer.succeed()` without complex mocking frameworks.

### Why Single-Phase Instead of Pre/Main/Post?

**Simplicity:**

- One entry point instead of three
- No cross-phase state persistence needed
- Token lifecycle handled by library service

**Reliability:**

- `GitHubApp.withToken()` guarantees token revocation via `acquireUseRelease`
- No state corruption risk between phases
- Simpler error handling (no partial state from failed phases)

**Maintainability:**

- Fewer files to maintain
- All logic visible in one place
- Easier to reason about execution flow

### Why Dedicated Branch Instead of Ephemeral Branches?

**Consistency:**

- Easier to find update PRs (always same branch name)
- Predictable workflow (users know where to look)
- Matches Dependabot's behavior (single branch per dependency type)

**Delete-and-Recreate Strategy:**

- Always starts from clean state (no stale changes)
- Simpler than rebase (no conflict resolution)
- Appropriate for automated dependency updates

### Why Changesets Integration?

**Monorepo Best Practice:**

Changesets is the de facto standard for versioning in pnpm monorepos. Integrating directly means:

- Automatic changelog generation
- Semantic versioning enforcement
- Release automation compatibility

### Why GitHub App Instead of PAT?

**Security:**

- Tokens expire in 1 hour (vs PAT never expires)
- Fine-grained permissions (read/write only what's needed)
- No user account compromise risk

**Verified Commits:**

- GitHub Apps can create verified/signed commits via the Git Data API
- Commit attribution shows the app name (e.g., "my-app[bot]")
- Requires omitting the `author` parameter in `createCommit()`

### Why Commit via GitHub API Instead of Git CLI?

- Verified commits with "Verified" badge
- No SSH keys or GPG keys needed
- Works automatically with GitHub App tokens
- Consistent with how GitHub's own bots work (Dependabot, etc.)

## Related Documentation

**External References:**

- [pnpm Config Dependencies](https://pnpm.io/config-dependencies)
- [GitHub Apps Authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app)
- [Changesets Documentation](https://github.com/changesets/changesets)
- [Effect Documentation](https://effect.website)
- [GitHub Actions Toolkit](https://github.com/actions/toolkit)
