# Module Entry Points

[Back to index](./_index.md)

## src/pre.ts - Token Generation

**Responsibility:** Generate GitHub App installation token before main action runs.

**State Persistence:**

The pre.ts phase uses `@actions/core` `saveState()` to persist values for main.ts and post.ts:

```typescript
import { getInput, saveState, setSecret, setOutput, info } from "@actions/core";

// Values saved in pre.ts are available via getState() in main.ts and post.ts
saveState("token", token);                    // GitHub App installation token
saveState("expiresAt", expiresAt);            // Token expiration timestamp
saveState("installationId", installationId); // For token revocation in post.ts
saveState("appSlug", appSlug);               // For logging
saveState("startTime", Date.now().toString()); // For timing
```

**Effect Signature:**

```typescript
export const generateToken: Effect.Effect<
 InstallationToken,
 AuthenticationError | GitHubApiError
> = Effect.gen(function* () {
 // 1. Parse app ID and private key from inputs
 const appId = yield* parseAppId();
 const privateKey = yield* parsePrivateKey();

 // 2. Create JWT for GitHub App authentication
 const jwt = yield* createJWT(appId, privateKey);

 // 3. Get installation ID for this repository
 const installationId = yield* getInstallationId(jwt);

 // 4. Generate installation token
 const token = yield* createInstallationToken(jwt, installationId);

 // 5. Save state for main.ts and post.ts
 yield* Effect.sync(() => {
  saveState("token", token.token);
  saveState("expiresAt", token.expiresAt.toISOString());
  saveState("installationId", installationId.toString());
  setSecret(token.token); // Mask in logs
  setOutput("token", token.token);
 });

 return token;
});
```

**Key Functions:**

- `parseAppId()`: Extract and validate app-id input
- `parsePrivateKey()`: Extract and validate app-private-key input
- `createJWT()`: Generate JWT using @octokit/auth-app
- `getInstallationId()`: Fetch installation ID for the repository
- `createInstallationToken()`: Generate short-lived token with required permissions
- `setActionOutput()`: Set token as action output for subsequent steps
- `setEnvVar()`: Set GITHUB_TOKEN environment variable

**Required Permissions:**

- `contents: write` - Push commits and branches
- `pull-requests: write` - Create and update PRs
- `checks: write` - Create and update check runs

## src/main.ts - Orchestration

**Responsibility:** Coordinate all phases of the dependency update workflow.

**State Retrieval:**

Main.ts retrieves state saved by pre.ts using `@actions/core` `getState()`:

```typescript
import { getState, info } from "@actions/core";

// Retrieve values saved by pre.ts
const token = getState("token");
const expiresAt = getState("expiresAt");
const appSlug = getState("appSlug");

if (!token) {
 throw new Error("No token available. Pre-action should have generated a token.");
}

info(`Using token for app "${appSlug}" (expires: ${expiresAt})`);
```

**Effect Signature:**

```typescript
export const main: Effect.Effect<ActionResult, never> = Effect.gen(function* () {
 // Phase 1: Setup - retrieve token from pre.ts state
 const token = yield* Effect.sync(() => getState("token")).pipe(
  Effect.filterOrFail(
   (t) => t.length > 0,
   () => new AuthenticationError({ reason: "No token in state. Ensure pre.ts ran." })
  )
 );

 const inputs = yield* parseInputs().pipe(
  Effect.catchAll((error) =>
   Effect.gen(function* () {
    yield* logError("Input validation failed", error);
    yield* setFailed(error.reason);
    return yield* Effect.fail(error);
   })
  )
 );

 const context = yield* getGitHubContext();
 const client = yield* createAuthenticatedClient();
 const checkRun = yield* createCheckRun(client, context, "pnpm config dependencies");

 // Phase 2: Branch Management
 const branchResult = yield* manageBranch(client, context, inputs.branch).pipe(
  Effect.tap((result) =>
   logInfo(
    result.created
     ? `Created branch ${result.branch} from ${result.baseRef}`
     : `Rebased ${result.branch} onto ${result.baseRef}`
   )
  )
 );

 // Phase 3: Dependency Updates (with error accumulation)
 const configUpdates = yield* updateConfigDependencies(inputs.configDependencies).pipe(
  Effect.catchAll((error) => accumulateErrors(error, []))
 );

 yield* runPnpmInstall();

 const regularUpdates = yield* updateRegularDependencies(inputs.dependencies).pipe(
  Effect.catchAll((error) => accumulateErrors(error, configUpdates))
 );

 const allUpdates = [...configUpdates, ...regularUpdates];

 // Phase 4: Change Detection
 const hasChanges = yield* detectChanges();
 if (!hasChanges) {
  yield* updateCheckRun(checkRun.id, "completed", "neutral", "No dependency updates available");
  yield* writeSummary("No changes detected. All dependencies are up-to-date.");
  return yield* Effect.succeed({ updates: [], changedPackages: [], changesets: [], branch: branchResult });
 }

 const changedPackages = yield* analyzeChangedPackages(allUpdates);

 // Phase 5: Changeset Creation (conditional on `changesets` input AND .changeset/ directory)
 const changesets = yield* Effect.if(
  () => inputs.changesets && changesetDirectoryExists(),
  {
   onTrue: () => createChangesets(changedPackages),
   onFalse: () => Effect.succeed([])
  }
 );

 // Phase 6: Commit and Push
 yield* formatWorkspaceYaml();
 yield* commitChanges(allUpdates, changesets);
 yield* pushBranch(branchResult.branch, branchResult.created === false);

 // Phase 7: Pull Request
 const pr = yield* createOrUpdatePR(client, context, branchResult.branch, allUpdates, changedPackages);

 // Phase 7.5: Enable Auto-merge (if configured)
 if (inputs.autoMerge !== "") {
  yield* enableAutoMerge(client, pr.nodeId, inputs.autoMerge).pipe(
   Effect.catchAll((error) =>
    Effect.gen(function* () {
     yield* logWarning(`Failed to enable auto-merge: ${error.message}`);
     return Effect.succeed(void 0);
    })
   )
  );
 }

 // Phase 8: Finalization
 yield* updateCheckRun(checkRun.id, "completed", "success", `Updated ${allUpdates.length} dependencies`);
 yield* writeSummary(generateSummaryMarkdown(allUpdates, changedPackages, pr));

 return { updates: allUpdates, changedPackages, changesets, branch: branchResult, pr, checkRun };
}).pipe(
 Effect.catchAll((error) =>
  Effect.gen(function* () {
   yield* logError("Action failed", error);
   yield* setFailed(formatErrorMessage(error));
   return yield* Effect.fail(error);
  })
 )
);
```

**Key Responsibilities:**

- Coordinate phase execution in correct order
- Handle errors gracefully with accumulation where appropriate
- Provide detailed logging at each step
- Exit early if no changes detected
- Generate comprehensive summaries

## src/post.ts - Cleanup

**Responsibility:** Clean up resources and revoke tokens after action completes.

**State Retrieval:**

Post.ts retrieves state from pre.ts for cleanup operations:

```typescript
import { getState, info, warning } from "@actions/core";

// Retrieve values needed for cleanup
const token = getState("token");
const installationId = getState("installationId");
const startTime = getState("startTime");

const duration = Date.now() - parseInt(startTime, 10);
info(`Action completed in ${duration}ms`);
```

**Effect Signature:**

```typescript
export const cleanup: Effect.Effect<void, never> = Effect.gen(function* () {
 // Retrieve state saved by pre.ts
 const token = yield* Effect.sync(() => getState("token"));
 const installationId = yield* Effect.sync(() => getState("installationId"));
 const skipRevoke = yield* Effect.sync(() => getState("skipTokenRevoke") === "true");

 // 1. Revoke GitHub App token (unless skipped or no token)
 if (token && installationId && !skipRevoke) {
  yield* revokeToken(token, parseInt(installationId, 10)).pipe(
   Effect.catchAll((error) => {
    // Log but don't fail cleanup
    yield* Effect.sync(() => warning(`Failed to revoke token: ${error}`));
    return Effect.succeed(void 0);
   })
  );
 }

 // 2. Log completion time
 const startTime = yield* Effect.sync(() => getState("startTime"));
 if (startTime) {
  const duration = Date.now() - parseInt(startTime, 10);
  yield* Effect.sync(() => info(`Action completed in ${duration}ms`));
 }

 // 3. Clean up temporary files (if any)
 yield* cleanupTempFiles().pipe(Effect.catchAll(() => Effect.succeed(void 0)));
});
```

**Key Functions:**

- `revokeToken()`: Revoke the GitHub App installation token
- `clearEnvVar()`: Remove GITHUB_TOKEN from environment
- `cleanupTempFiles()`: Remove any temporary files created during execution
