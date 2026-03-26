# Project Status

[Back to index](./_index.md)

## Current State

**Status:** Effect-first restructure complete. All domain logic wrapped as Effect
services with `Context.Tag` + `Layer`. Layer composition centralized in
`src/layers/app.ts`.

**Architecture (current):**

- **Effect-first services:** All domain functions are Effect services in `src/services/`:
  `BranchManager`, `PnpmUpgrade`, `ConfigDeps`, `RegularDeps`, `PeerSync`, `Report`,
  `Lockfile`, `Changesets`, `WorkspaceYaml`
- **Layer composition:** `makeAppLayer(token, dryRun)` in `src/layers/app.ts` wires
  all library and domain layers together
- **Pure helpers:** `src/utils/` contains stateless functions (`deps.ts`, `markdown.ts`,
  `pnpm.ts`, `semver.ts`)
- **No barrel re-exports:** Direct imports everywhere, no `index.ts` files
- **Co-located tests:** Each `.ts` file has a `.test.ts` sibling
- **New library services:** `NpmRegistry` (npm queries), `PullRequest` (PR management
  with auto-merge), `GithubMarkdown` (markdown utilities)

**Implemented Features:**

- Single-phase execution model with 16 steps
- GitHub App token lifecycle via `GitHubApp.withToken()`
- Branch management with delete-and-recreate strategy via `BranchManager` service
- Config dependency updates via `ConfigDeps` service (uses `NpmRegistry`)
- Regular dependency updates via `RegularDeps` service (uses `NpmRegistry`)
- Peer dependency range syncing via `PeerSync` service (`peer-lock` and `peer-minor` strategies)
- pnpm self-upgrade via `PnpmUpgrade` service
- Clean install after updates
- Workspace YAML formatting via `WorkspaceYaml` service
- Custom command execution via `CommandRunner` with error collection
- Lockfile comparison via `Lockfile` service
- Changeset creation via `Changesets` service
- Verified commits via `BranchManager.commitChanges()` (GitHub API)
- PR creation/update via `Report` service (uses `PullRequest` library service)
- Auto-merge support via `PullRequest` service (GraphQL API)
- Check run lifecycle via `CheckRun.withCheckRun()`
- PR sentinel fix: failures propagate as `PullRequestError` instead of `{ number: 0 }`
- Dry-run mode for testing

**Deleted Modules (restructure):**

- `src/lib/` (entire directory) - Logic moved to `src/services/` and `src/utils/`
- `src/types/index.ts` - No barrel re-exports, import from `src/schemas/domain.ts`
- `src/lib/errors/types.ts` - Replaced by `src/errors/errors.ts`
- `src/lib/schemas/index.ts` - Replaced by `src/schemas/domain.ts`
- `src/lib/schemas/errors.ts` - Replaced by `src/errors/errors.ts`
- `src/lib/__test__/fixtures.ts` - Replaced by `src/utils/fixtures.test.ts`

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

### Why Effect-First Service Architecture?

**Dependency injection:** `Context.Tag` + `Layer` provides compile-time verified
dependency injection. Each service declares its dependencies in its Layer, and
the compiler ensures all dependencies are satisfied.

**Testability:** Mock any service by providing `Layer.succeed(Tag, mockImpl)`.
No need for complex mocking frameworks or module mocking.

**Composition:** `makeAppLayer` in `src/layers/app.ts` wires all layers in one place.
Adding a new service means defining its Tag, implementing its Layer, and adding it
to `makeAppLayer`.

### Why Single-Phase Instead of Pre/Main/Post?

**Simplicity:**

- One entry point instead of three
- No cross-phase state persistence needed
- Token lifecycle handled by library service

**Reliability:**

- `GitHubApp.withToken()` guarantees token revocation via `acquireUseRelease`
- No state corruption risk between phases
- Simpler error handling (no partial state from failed phases)

### Why Dedicated Branch Instead of Ephemeral Branches?

**Delete-and-Recreate Strategy:**

- Always starts from clean state (no stale changes)
- Simpler than rebase (no conflict resolution)
- Appropriate for automated dependency updates

### Why Changesets Integration?

Changesets is the de facto standard for versioning in pnpm monorepos:

- Automatic changelog generation
- Semantic versioning enforcement
- Release automation compatibility

### Why GitHub App Instead of PAT?

- Tokens expire in 1 hour (vs PAT never expires)
- Fine-grained permissions
- Verified commits via Git Data API (no SSH/GPG keys needed)
- Consistent with GitHub's own bots (Dependabot, etc.)

## Related Documentation

**External References:**

- [pnpm Config Dependencies](https://pnpm.io/config-dependencies)
- [GitHub Apps Authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app)
- [Changesets Documentation](https://github.com/changesets/changesets)
- [Effect Documentation](https://effect.website)
- [GitHub Actions Toolkit](https://github.com/actions/toolkit)
