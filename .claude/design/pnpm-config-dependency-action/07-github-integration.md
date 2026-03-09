# GitHub Integration

[Back to index](./_index.md)

## GitHub App Authentication

**Benefits over Personal Access Tokens:**

- Short-lived tokens (1 hour max)
- Fine-grained permissions
- No user account dependency
- Audit trail tied to app

**Flow (handled by `GitHubApp.withToken()`):**

1. Create JWT signed with app private key
2. Find installation for the current repository
3. Exchange JWT for installation token
4. Use installation token for all API calls
5. Automatically revoke token when callback completes

The entire authentication flow is handled by the `GitHubApp` service from
`@savvy-web/github-action-effects`. No custom auth code exists in this codebase.

```typescript
const ghApp = yield* GitHubApp;
yield* ghApp.withToken(inputs["app-id"], inputs["app-private-key"], (token) =>
 Effect.gen(function* () {
  // token is a valid installation token
  const ghClient = GitHubClientLive(token);
  // ... use services
 }),
);
```

## Branch Management

**Strategy:**

- Use dedicated branch (default: `pnpm/config-deps`)
- Create if doesn't exist
- Delete and recreate from main if exists (fresh start each run)

**Why Delete-and-Recreate Instead of Rebase:**

- Simpler logic, no conflict resolution needed
- Always starts from a clean state
- Avoids rebase complexity with force-push
- Appropriate since the branch only contains automated dependency updates

**Implementation uses library services:**

- `GitBranch.exists(branchName)` - Check if branch exists
- `GitBranch.getSha(defaultBranch)` - Get SHA of default branch
- `GitBranch.create(branchName, sha)` - Create branch via GitHub API
- `GitBranch.delete(branchName)` - Delete branch via GitHub API
- `CommandRunner.exec("git", [...])` - Fetch and checkout locally

## Check Runs and Status

**Purpose:**

- Provide visibility in GitHub UI
- Show progress during execution
- Report final status (success/failure/neutral)

**Lifecycle (handled by `CheckRun.withCheckRun()`):**

1. Create check run at start (status: `in_progress`)
2. Callback runs the main logic
3. Use `checkRunService.complete(id, conclusion, output)` to finalize
4. Automatically cleaned up on failure

```typescript
const checkRunService = yield* CheckRun;
yield* checkRunService.withCheckRun("Dependency Updates", headSha, (checkRunId) =>
 Effect.gen(function* () {
  // ... do work ...
  yield* checkRunService.complete(checkRunId, "success", {
   title: "Dependency Updates Complete",
   summary: summaryText,
  });
 }),
);
```

## Pull Request Management

**Strategy:**

- Check if PR already exists for the branch via `GitHubClient.rest()`
- Create new PR if none exists
- Update existing PR description if already exists

**Why Update Instead of Close/Reopen:**

- Preserves review history
- Maintains comment threads
- Shows evolution of changes

**Auto-merge Support:**

The action supports enabling auto-merge via the `auto-merge` input:

- **Values:** `""` (disabled, default), `"merge"`, `"squash"`, or `"rebase"`
- **Implementation:** Uses `AutoMerge.enable(nodeId, mergeMethod)` from the library,
  which calls the GitHub GraphQL `enablePullRequestAutoMerge` mutation
- **Requirements:**
  - Repository must have "Allow auto-merge" setting enabled
  - Target branch must have branch protection with required status checks
  - The GitHub App must have `pull-requests: write` permission
- **Error Handling:** Warnings logged on failure, action does not fail

## Verified Commits via GitHub API

Commits are created via the `GitCommit` library service:

1. `GitCommit.createTree(entries, baseSha)` - Create git tree with changed files
2. `GitCommit.createCommit(message, treeSha, parents)` - Create commit (NO author
   parameter, enabling GitHub to attribute and verify)
3. `GitCommit.updateRef(ref, sha, force)` - Update branch ref to new commit

**Why This Matters:**

- Verified commits show trust and authenticity
- No SSH keys or GPG keys needed
- Works automatically with GitHub App tokens
- Consistent with how GitHub's own bots work (Dependabot, etc.)

**PR Description Template:**

```markdown
## Dependency Updates

Updates 2 config and 3 regular dependencies.

### Config Dependencies

| Package | From | To |
|---------|------|-----|
| [`typescript`](https://www.npmjs.com/package/typescript) | 5.3.3 | 5.4.0 |

### Regular Dependencies

| Package | From | To |
|---------|------|-----|
| [`effect`](https://www.npmjs.com/package/effect) | ^3.0.0 | ^3.1.0 |

### Changesets

1 changeset(s) created for version management.

---

_This PR was automatically created by [pnpm-config-dependency-action](https://github.com/savvy-web/pnpm-config-dependency-action)_
```
