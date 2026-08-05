---
status: current
module: silk-update-action
category: integration
created: 2026-02-20
updated: 2026-08-05
last-synced: 2026-08-05
completeness: 95
related:
  - ./_index.md
dependencies: []
implementation-plans: []
---

# GitHub Integration

[Back to index](./_index.md)

All GitHub API access goes through `@effected/github` (resource services) and
`@effected/github-actions` (runtime + token lifecycle). No custom auth or REST
code exists in this codebase.

## GitHub App Authentication

**Benefits over Personal Access Tokens:**

- Short-lived tokens (1 hour max)
- Fine-grained permissions
- No user account dependency
- Audit trail tied to app

**Flow (three-phase, coordinated by `GitHubToken`):**

1. **pre** — `pre.ts` parses `app-client-id` / `app-private-key` via `ActionInput`
   and calls `GitHubToken.provision({ appId, privateKey, owner, required })`,
   which signs a JWT, finds the installation, exchanges it for an installation
   token, verifies the `required` scopes against what GitHub actually granted, and
   persists the envelope to `ActionState`. The kit takes credentials **explicitly**
   rather than reading the inputs itself, and names the scope field `required`.
2. **main** — `GitHubToken.clientLayer()` reads the envelope back and builds the
   `GitHubClient` layer used by all API calls.
3. **post** — `GitHubToken.dispose()` revokes the token. `post` always runs, even
   when `main` fails.

`ActionState` is backed by the runner's `GITHUB_STATE`, which is process-global
across the three Node processes, so the token survives the phase boundaries.

```typescript
// pre.ts
const token = yield* GitHubToken.provision({
 appId, privateKey, owner,
 required: { contents: "write", pull_requests: "write", checks: "write" },
});

// main.ts (via makeAppLayer)
const githubClient = GitHubToken.clientLayer().pipe(Layer.orDie);

// post.ts
yield* GitHubToken.dispose();
```

`GitHubApp.layer` (used only by `pre` / `post`) is self-contained in the kit —
there is no octokit auth-app strategy to provide and no separate `FetchHttpClient`
wiring.

## The `Repo` service

Every resource call resolves against a `Repo`, which is **required per call**
rather than captured when a service layer is built. `makeAppLayer` provides
`Repo.layerFromConfig()` (reading `GITHUB_REPOSITORY` through the ambient
ConfigProvider, `Layer.orDie`), and domain services such as `BranchManager`
deliberately leave `Repo` in each method's `R` — which is what keeps
`Repo.provide(ref)` meaningful for a caller targeting a different repository.

## Branch Management

**Strategy:**

- Use a dedicated branch (default: `pnpm/config-deps`).
- Validate `source-branch` and `target-branch` exist first
  (`BranchManager.validateBranches`), failing fast with `InvalidInputError` before
  any destructive operation.
- `GitBranch.upsert(name, sha)` then creates the branch when absent and
  **force-resets** it to the source SHA when present, returning `"created"` or
  `"reset"`. This replaced the old exists → delete → create sequence: same net
  effect (a fresh start from the source ref each run), without a window in which
  the ref does not exist for anything else reading it.
- Fetch and checkout locally afterwards (`git fetch origin`,
  `git checkout -B <branch> origin/<branch>`).

**Configurable refs:** the update is cut from `source-branch` (default `main`) and
the PR targets `target-branch` (default `""`, which follows `source-branch`). This
supports cutting from one branch and merging into another (e.g. cut from `dev`, PR
into `main`).

**Base-history preflight:** when changesets are enabled,
`BranchManager.ensureBaseHistory(target, workspaceRoot)` runs before the
changeset step, because silk's `DepsRegen` diffs `merge-base(target) → worktree`
and needs both the base ref and a common ancestor locally. A `fetch-depth: 0`
checkout satisfies this and the preflight is then a no-op; on a shallower
checkout it best-effort fetches, unshallows and materializes a local ref,
warning non-fatally if the merge-base still cannot be resolved.

The workspace root is passed explicitly and every git command in the preflight
runs there. It previously ran at `process.cwd()`, which produced a **silent**
wrong answer when the action was invoked from a subdirectory: the probe resolved
against the wrong directory, the preflight decided it had nothing to do, and the
changeset step then diffed against a base it could not see — yielding no
changesets, which is indistinguishable from "no versionable changes". See
@./05-module-library.md.

**Why reset rather than rebase:** simpler logic, no conflict resolution, always a
clean state — appropriate because the branch only ever contains automated
dependency updates.

## Check Runs and Status

`CheckRun.withCheckRun(name, headSha, use)` owns the lifecycle. The kit's `use`
callback receives `(checkRunId, conclude)` and the check run is concluded on
**every** exit path, so an unhandled failure still closes it.

```typescript
const checkRunService = yield* CheckRun;
yield* checkRunService.withCheckRun("Dependency Updates", headSha, (_id, conclude) =>
 Effect.gen(function* () {
  // …do work…
  yield* conclude("success", CheckRunOutput.make({
   title: "Dependency Updates Complete",
   summary: summaryText,
  }));
 }),
);
```

`CheckRunOutput.make({...})` is required — it is a `Schema.Class`, and a bare
object literal fails typechecking. `innerProgram` concludes explicitly for three
terminal states: `failure` (a custom command failed), `neutral` (no changes
detected) and `success`. The name is `Dependency Updates (Dry Run)` under
`dry-run: true`.

Everything that can reject a run — package-manager detection (yarn, no workspace
root) and branch-ref validation — happens **inside** the check run, so a rejection
is visible in the GitHub UI rather than being an invisible early exit.

## Pull Request Management

`PullRequest.upsert({ head, base, title, body })` creates the PR or updates the
existing one for the branch, returning `{ pullRequest, created }`. Updating rather
than close/reopen preserves review history, comment threads and the visible
evolution of the change.

**Auto-merge is a separate call.** The kit exposes `setAutoMerge(info, method)`
(the GraphQL `enablePullRequestAutoMerge` mutation — no REST endpoint exists)
rather than a field on create:

- **Values:** `""` (disabled, default), `"merge"`, `"squash"`, `"rebase"`. The
  value is **validated in `readInputs` and typed as that union**, not cast at the
  call site, so a typo fails during input parsing rather than arriving here as an
  invalid GraphQL enum.
- **Requirements:** the repository must allow auto-merge, the target branch needs
  branch protection with required status checks, and the App needs
  `pull-requests: write`.
- **Failure is swallowed to a warning** on purpose: the repository may simply not
  have auto-merge enabled, and that must not fail a run whose PR was created
  successfully.

A PR failure is caught in the `commit-and-pr` step, logged as a warning, and
reported as a `FAILED (see warning above)` step line — the run still concludes
and writes its summary. That asymmetry within one step is deliberate: the
**commit** propagates, because a PR describing a commit that does not exist
would be a lie, whereas by the time the PR call runs the commit is already
pushed and durable, so failing the run would report a red job for work that
actually landed. The next run upserts the PR.

## Verified Commits via GitHub API

`GitCommit.commitFiles({ branch, message, changes })` wraps the Git Data API
(create tree → create commit → update ref) in one call. Changes are **tagged
members** in the kit — `FileContent.make({ path, content })` and
`FileDeletion.make({ path })` — replacing the old `{ path, sha: null }` sentinel
for deletions. No author is passed, which is what lets GitHub attribute and verify
the commit.

**Why this matters:** verified commits show authenticity, need no SSH or GPG keys,
work automatically with GitHub App tokens, and match how GitHub's own bots behave.

**File mode:** the change list comes from
`git -c core.fileMode=false status --porcelain`. Executable-bit-only flips (e.g.
husky chmod-ing hooks during a `run` command) do not survive a content-based API
commit at mode 100644, so counting them would produce an empty commit and a
spurious PR. The run's change-detection step (`steps/detect-changes.ts`) queries
status the same way, and **the two must stay consistent** — that module's own doc
comment says so, because a divergence would make the run's verdict and the
commit's contents disagree. The status output is read verbatim (via
`Run.collect`, not the trimming `Run.text`) because `--porcelain`'s
two-character status field is column-aligned.

After committing, the working tree is synced with `git fetch origin <branch>` +
`git reset --hard origin/<branch>` — `git checkout` would refuse to overwrite the
just-committed working-copy state.

**Title and commit subject:** both are generated from the run's contents by
`buildUpdateSubject(updates)` (`src/utils/commit-subject.ts`) — there is no static
`chore(deps): …` constant. It names a single change (e.g.
`chore(deps): bump effect to 3.1.0`), summarizes runtime- or config-only batches,
scopes a single-workspace dependency batch (with the typed noun when the batch is
one section, e.g. `chore(deps): update devDependencies in @scope/pkg`) and composes
mixed runs, degrading progressively to fit a 72-char header. The commit body adds
one bullet per update and a `Signed-off-by` footer attributed to the app slug's bot
identity (or `github-actions[bot]`), which is what makes the API commit verify.

**PR description template:**

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

### Catalog Changes

| Catalog | Dependency | From | To | Action |
|---------|------------|------|-----|--------|
| default | vitest | 3.2.0 | 3.3.0 | updated |

### Changesets

1 changeset(s) created for version management.

---

_This PR was automatically created by [silk-update-action](https://github.com/savvy-web/silk-update-action)_
```

The Catalog Changes section appears only for bun compat-mode runs, built from the
`CatalogDelta[]` the config-dependency step returns — on a plugin bump that table
is the actual payload of the run. The Markdown is assembled with the kit's
`GitHubMarkdown` writer from `@effected/github-actions` — the successor to the
deleted library's `GithubMarkdown`, under a renamed capital H. Only `bold` and
`rule` are local (`src/utils/markdown.ts`). What *is* consumer policy is the
arrangement of the report — which sections exist and in what order — not the
markdown primitives.
