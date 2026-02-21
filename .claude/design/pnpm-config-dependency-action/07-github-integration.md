# GitHub Integration

[Back to index](./_index.md)

## GitHub App Authentication

**Benefits over Personal Access Tokens:**

- Short-lived tokens (1 hour max)
- Fine-grained permissions
- No user account dependency
- Audit trail tied to app

**Flow:**

1. Create JWT signed with app private key
2. Exchange JWT for installation token
3. Use installation token for all API calls
4. Revoke token in cleanup (optional, expires anyway)

**Implementation:**

```typescript
import { createAppAuth } from "@octokit/auth-app";

export const generateInstallationToken = (
 appId: string,
 privateKey: string,
 installationId: number
): Effect.Effect<InstallationToken, AuthenticationError> =>
 Effect.gen(function* () {
  const auth = createAppAuth({
   appId,
   privateKey,
   installationId
  });

  const { token, expiresAt, permissions, repositories } = yield* Effect.tryPromise({
   try: () => auth({ type: "installation" }),
   catch: (error) =>
    new AuthenticationError({
     reason: `Failed to generate installation token: ${error}`,
     appId
    })
  });

  return { token, expiresAt: new Date(expiresAt), permissions, repositories };
 });
```

## Branch Management

**Strategy:**

- Use dedicated branch (default: `pnpm/config`)
- Create if doesn't exist
- Rebase if behind main
- Force-push after rebase (safe since dedicated branch)

**Why Rebase Instead of Merge:**

- Keeps linear history
- Easier to review changes
- No merge commits cluttering PR
- Matches typical Dependabot behavior

**Implementation:**

```typescript
export const rebaseBranch = (baseBranch: string, targetBranch: string): Effect.Effect<void, GitError> =>
 Effect.gen(function* () {
  yield* execGit(["fetch", "origin", baseBranch]);
  yield* execGit(["rebase", `origin/${baseBranch}`]);
 }).pipe(
  Effect.catchTag("GitError", (error) =>
   Effect.gen(function* () {
    // Abort rebase on failure
    yield* execGit(["rebase", "--abort"]).pipe(Effect.ignore);
    return yield* Effect.fail(error);
   })
  )
 );
```

## Check Runs and Status

**Purpose:**

- Provide visibility in GitHub UI
- Show progress during execution
- Report final status (success/failure/neutral)

**Lifecycle:**

1. Create check run at start (status: `in_progress`)
2. Update with progress messages during execution
3. Finalize with conclusion (status: `completed`, conclusion: `success|failure|neutral`)

**Implementation:**

```typescript
export const createCheckRun = (
 client: AuthenticatedClient,
 context: GitHubContext,
 name: string
): Effect.Effect<CheckRun, GitHubApiError> =>
 Effect.gen(function* () {
  const response = yield* Effect.tryPromise({
   try: () =>
    client.octokit.checks.create({
     owner: context.owner,
     repo: context.repo,
     name,
     head_sha: context.sha,
     status: "in_progress",
     started_at: new Date().toISOString()
    }),
   catch: (error) =>
    new GitHubApiError({
     operation: "checks.create",
     statusCode: error.status || 500,
     message: error.message
    })
  });

  return {
   id: response.data.id,
   name,
   status: "in_progress"
  };
 });
```

## Pull Request Management

**Strategy:**

- Check if PR already exists for the branch
- Create new PR if none exists
- Update existing PR description if already exists

**Why Update Instead of Close/Reopen:**

- Preserves review history
- Maintains comment threads
- Shows evolution of changes

**Auto-merge Support:**

The action supports enabling auto-merge on dependency update PRs via the `auto-merge` input:

- **Values:** `""` (disabled, default), `"merge"`, `"squash"`, or `"rebase"`
- **Implementation:** Uses GitHub GraphQL API `enablePullRequestAutoMerge` mutation
- **Requirements:**
  - Repository must have "Allow auto-merge" setting enabled in Settings > General
  - Target branch (usually `main`) must have branch protection with required status checks configured
  - The GitHub App must have `pull-requests: write` permission
- **Error Handling:** If enabling auto-merge fails (e.g., repository settings not configured), a warning is logged but the action does not fail
- **Use Case:** Allows fully automated dependency updates when combined with passing CI checks

**PR Description Template:**

```markdown
## Dependency Updates

This PR updates pnpm config dependencies and regular dependencies to their latest versions.

### Config Dependency Updates

- `typescript`: `5.3.3` → `5.4.0`
- `@biomejs/biome`: `1.5.0` → `1.6.1`

### Regular Dependency Updates

#### @savvy-web/effect-type-registry

- `effect`: `3.0.0` → `3.1.0`
- `@effect/schema`: `0.60.0` → `0.61.0`

### Changesets Created

- **@savvy-web/effect-type-registry** (patch): Update effect and @effect/schema

---

_This PR was automatically created by [pnpm-config-dependency-action](link)_
```
