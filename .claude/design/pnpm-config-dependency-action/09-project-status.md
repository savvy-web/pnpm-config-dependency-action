# Project Status

[Back to index](./_index.md)

## Implementation Plan

### Phase 1: Core Infrastructure

**Goal:** Set up project structure, Effect integration, and type definitions.

**Tasks:**

1. Initialize repository with pnpm workspace
2. Configure TypeScript with strict mode
3. Install Effect, @effect/schema, @actions/core, @octokit/rest
4. Define core types and interfaces (`src/types/index.ts`)
5. Define error types (`src/lib/errors/types.ts`)
6. Set up testing infrastructure (Vitest, Effect test utilities)
7. Configure GitHub Action metadata (`action.yml`)

**Deliverables:**

- Working TypeScript build
- Core type definitions
- Test framework configured
- `action.yml` skeleton

**Dependencies:** None

### Phase 2: Dependency Updates

**Goal:** Implement config and regular dependency update logic.

**Tasks:**

1. Implement input parsing (`src/lib/inputs.ts`)
2. Implement pnpm config dependency updates (`src/lib/pnpm/config.ts`)
3. Implement pnpm regular dependency updates (`src/lib/pnpm/regular.ts`)
4. Implement pnpm install wrapper (`src/lib/pnpm/install.ts`)
5. Implement workspace YAML formatter (`src/lib/pnpm/format.ts`)
6. Add error accumulation for batch updates
7. Write unit tests for all pnpm operations

**Deliverables:**

- Working dependency update logic
- Error handling with accumulation
- Unit tests passing

**Dependencies:** Phase 1

### Phase 3: Changeset Integration

**Goal:** Detect changed packages and create changeset files.

**Tasks:**

1. Implement changeset directory detection (`src/lib/changeset/detect.ts`)
2. Implement package change analysis (`src/lib/changeset/analyze.ts`)
3. Implement changeset file creation (`src/lib/changeset/create.ts`)
4. Parse `package.json` files to determine changed packages
5. Generate changeset summaries with dependency lists
6. Handle edge case: only root/config dependencies changed
7. Write tests for changeset creation logic

**Deliverables:**

- Changeset creation working
- Correct handling of package changes
- Tests passing

**Dependencies:** Phase 2

### Phase 4: GitHub Integration

**Goal:** Implement GitHub App auth, branch management, and PR creation.

**Tasks:**

1. Implement GitHub App authentication (`src/lib/github/auth.ts`, `src/pre.ts`)
2. Implement branch existence check and creation (`src/lib/github/branch.ts`)
3. Implement branch rebasing logic
4. Implement git operations (status, diff, commit, push) (`src/lib/git/`)
5. Implement check run creation and updates (`src/lib/github/check.ts`)
6. Implement PR creation and updates (`src/lib/github/pr.ts`)
7. Implement PR description template generation
8. Implement cleanup logic (`src/post.ts`)
9. Write integration tests with mocked GitHub API

**Deliverables:**

- Complete GitHub integration
- Branch management working
- PR creation working
- Integration tests passing

**Dependencies:** Phase 3

## Current State

**Status:** Initial implementation complete (v0.1.0 released). Core features operational including
config dependency updates, regular dependency updates, pnpm self-upgrade, custom command execution,
changeset creation, and GitHub PR management via App authentication.

**Implemented Features:**

- Phase-based execution model with 14 steps
- GitHub App token generation (pre.ts) and revocation (post.ts)
- Branch management with create/rebase
- Config dependency updates via `pnpm add --config`
- Regular dependency updates via direct npm queries (compatible with `catalogMode: strict`)
- pnpm self-upgrade via `corepack use` with `packageManager` and `devEngines` field support
- Clean install after updates
- Workspace YAML formatting
- Custom command execution with error collection
- Lockfile comparison for change detection
- Changeset creation for affected packages
- Commit via GitHub API (verified/signed commits)
- PR creation and update with Dependabot-style formatting
- Auto-merge support via GitHub GraphQL API
- Configurable changeset creation via `changesets` input (boolean, default: `true`)
- Dry-run mode for testing
- Debug logging mode

**Next Steps:**

1. Integration testing with real GitHub App in CI
2. Documentation: user guide and troubleshooting
3. Support for additional changeset strategies beyond patch

## Rationale

### Why Effect Instead of Plain TypeScript/Promises?

**Type-Safe Error Handling:**

Effect's type system makes errors explicit in function signatures. You can see at a glance what errors
a function might produce, and the compiler ensures you handle them.

```typescript
// With promises - errors are invisible
async function updateDep(dep: string): Promise<DependencyUpdateResult> {
 // What errors can this throw? Who knows!
}

// With Effect - errors are explicit
function updateDep(dep: string): Effect.Effect<DependencyUpdateResult, PnpmError> {
 // Clear: this can fail with PnpmError
}
```

**Error Accumulation:**

GitHub Actions should be resilient. If updating 10 dependencies, and 2 fail, we want to:

1. Continue with the other 8
2. Report all failures at the end
3. Still create a PR with successful updates

Effect makes this pattern easy with `Effect.all`, `Effect.either`, and custom error types.

**Retry Logic:**

GitHub API calls can fail transiently. Effect's `Schedule` API provides sophisticated retry logic
with exponential backoff, jitter, and max attempts.

**Resource Management:**

GitHub check runs need to be finalized even if the action fails. Effect's `acquireUseRelease`
pattern ensures cleanup always happens.

**Testing:**

Effect programs are pure and composable, making them easier to test. You can run effects in test
mode, collect logs, and verify behavior without side effects.

### Why Dedicated Branch Instead of Ephemeral Branches?

**Consistency:**

- Easier to find update PRs (always same branch name)
- Predictable workflow (users know where to look)
- Matches Dependabot's behavior (single branch per dependency type)

**Rebase Support:**

- Can rebase onto main when behind
- Keeps history clean and linear
- Avoids merge commit clutter

**Automation:**

- CI/CD can target specific branch
- Can set up CODEOWNERS for auto-review
- Branch protection rules can be configured

### Why Changesets Integration?

**Monorepo Best Practice:**

Changesets is the de facto standard for versioning in pnpm monorepos. Integrating directly means:

- Automatic changelog generation
- Semantic versioning enforcement
- Release automation compatibility

**Transparency:**

Each changeset file is a human-readable record of what changed and why. This provides:

- Clear attribution of dependency updates
- Easy review of impact scope
- Historical record of dependency evolution

**Flexibility:**

Users can edit changeset messages before release to add context or combine related updates.

### Why GitHub App Instead of PAT?

**Security:**

- Tokens expire in 1 hour (vs PAT never expires)
- Fine-grained permissions (read/write only what's needed)
- No user account compromise risk

**Auditability:**

- Actions tied to app, not individual user
- Clear separation of automation vs human actions
- Easier to revoke access organization-wide

**Scalability:**

- No per-user token management
- Works across repositories with single app installation
- Team members can come and go without token rotation

**Verified Commits:**

- GitHub Apps can create verified/signed commits when using the API
- Commit attribution shows the app name (e.g., "my-app[bot]")
- Requires omitting the `author` parameter in `git.createCommit()` API call
- Sign-off uses app slug from state for proper attribution

### Why Commit via GitHub API Instead of Git CLI?

**Verified Commits:**

When creating commits via the GitHub API with a GitHub App token:

1. **Omit the `author` parameter** - This allows GitHub to attribute the commit to the app
2. **Include sign-off trailer** - Use app slug: `Signed-off-by: my-app[bot] <my-app[bot]@users.noreply.github.com>`
3. **GitHub verifies the commit** - Commits get a "Verified" badge in the UI

**Implementation:**

```typescript
// ❌ INCORRECT: Passing author prevents verification
await octokit.rest.git.createCommit({
  owner, repo, message, tree, parents,
  author: { name: "my-app[bot]", email: "..." } // Don't do this
});

// ✅ CORRECT: Omit author for verification
await octokit.rest.git.createCommit({
  owner, repo, message, tree, parents
  // NO author parameter - GitHub will attribute and verify
});
```

**Why This Matters:**

- Verified commits show trust and authenticity
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

**Internal References:**

- Reference implementation: `workflow-release-action` (sister repo)
- Pattern examples: Phase-based execution, check runs, summaries

**Future Documentation:**

- User guide: How to set up the action in your repository
- Contributing guide: How to contribute to the action
- Troubleshooting guide: Common issues and solutions
