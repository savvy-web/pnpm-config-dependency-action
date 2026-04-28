# Project Status

[Back to index](./_index.md)

## Current State

**Status:** Effect-first restructure complete. All domain logic wrapped as Effect
services with `Context.Tag` + `Layer`, plus a few standalone helper modules
(`PeerSync`, `WorkspaceYaml`). Layer composition centralized in
`src/layers/app.ts`. The action now uses `workspaces-effect` for workspace and
publishability concerns; `workspace-tools` is no longer a dependency.

**Architecture (current):**

- **Entry split:** `src/main.ts` is a thin module-level wrapper that calls
  `Action.run`; the testable `program` Effect lives in `src/program.ts` along
  with `runCommands` and `runInstall` helpers.
- **Effect-first services:** Domain services in `src/services/` —
  `BranchManager`, `PnpmUpgrade`, `ConfigDeps`, `RegularDeps`,
  `Report`, `Lockfile`, `Changesets`, `ChangesetConfig`, plus the
  `Publishability` Layer overrides for the `PublishabilityDetector` Tag
  from `workspaces-effect`. Stateless helpers (`PeerSync`, `WorkspaceYaml`)
  export functions without their own Tag. Workspace enumeration goes
  through `WorkspaceDiscovery` from `workspaces-effect` directly — the
  local `Workspaces` wrapper service was removed (issue #38) when
  `workspaces-effect@0.5.1` exposed cwd-accepting methods upstream.
- **Layer composition:** `makeAppLayer(dryRun)` in `src/layers/app.ts` wires
  all library and domain layers together. The GitHub App token reaches
  `GitHubClientLive` via `process.env.GITHUB_TOKEN` set inside
  `GitHubApp.withToken()` — the layer factory itself does not take a token.
- **Pure helpers:** `src/utils/` contains stateless functions (`deps.ts`,
  `input.ts`, `markdown.ts`, `pnpm.ts`, `semver.ts`).
- **No barrel re-exports:** Direct imports everywhere, no `index.ts` files.
- **Co-located tests:** Each `.ts` file has a `.test.ts` sibling.
- **Library services:** `NpmRegistry` (npm queries), `PullRequest` (PR
  management with auto-merge), `GithubMarkdown` (markdown utilities),
  `OctokitAuthAppLive` (provides `GitHubAppLive`'s auth dependency).

**Implemented Features:**

- Single-phase execution model orchestrated in `program.ts`.
- GitHub App token lifecycle via `GitHubApp.withToken()`; token bridged to
  `GitHubClientLive` through `process.env.GITHUB_TOKEN`.
- Branch management with delete-and-recreate strategy via `BranchManager`
  service.
- Config dependency updates via `ConfigDeps` service (uses `NpmRegistry`).
- Regular dependency updates via `RegularDeps` service (uses `NpmRegistry`
  and `WorkspaceDiscovery` from `workspaces-effect`). Iterates
  `dependencies`, `devDependencies`, and `optionalDependencies`
  independently and reports the real section type per update —
  `peerDependencies` are managed by `syncPeers`.
- Peer dependency range syncing via `syncPeers` (`peer-lock` and
  `peer-minor` strategies, powered by `semver-effect`).
- pnpm self-upgrade via `PnpmUpgrade` service.
- Lockfile reconciliation via `runInstall`:
  `pnpm install --frozen-lockfile=false --fix-lockfile` (replaces the older
  `rm -rf node_modules pnpm-lock.yaml && pnpm install` clean-install).
- Workspace YAML formatting via `WorkspaceYaml` helpers.
- Custom command execution via `runCommands` (`sh -c`) with error collection.
- Lockfile comparison via `Lockfile` service. Catalog comparison emits one
  `LockfileChange` per (catalog change, consuming importer, dep section)
  triple, carrying the precise `type` field so downstream consumers can
  trigger off `type` alone.
- Changeset creation via `Changesets` service. The new gating rules
  (versionable cascade + trigger/informational classification) replace the
  previous always-on patch fallback. Empty changesets are no longer written.
  The third parameter to `Changesets.create` was renamed from `devUpdates`
  to `regularUpdates` and is now routed by `update.type` against the same
  `TRIGGER_TYPES` set already used for lockfile changes
  (dependency/optionalDependency/peerDependency are triggers,
  devDependency is informational only). PeerDependency changes still
  arrive primarily via two existing paths — `compareCatalogs` for
  catalog refs in workspace peerDependencies, and `syncPeers` for
  peer-minor/peer-lock rewrites — both of which already feed the
  trigger lane and are covered by `changesets.test.ts`
  ("catalog change in peerDependency triggers a changeset",
  "writes a changeset for peer-sync rewrites").
- `ChangesetConfig` service: silk vs vanilla mode detection plus
  `versionPrivate` flag for `.changeset/config.json`.
- `PublishabilityDetector` overrides (`SilkPublishabilityDetectorLive`,
  `PublishabilityDetectorAdaptiveLive`) over `workspaces-effect`.
- Verified commits via `BranchManager.commitChanges()` (GitHub API,
  `GitCommit.commitFiles`).
- PR creation/update via `Report` service (uses `PullRequest` library service).
- Auto-merge support via `PullRequest` service (GraphQL API).
- Check run lifecycle via `CheckRun.withCheckRun()`.
- PR sentinel fix: failures propagate as `PullRequestError` instead of
  `{ number: 0 }`.
- Dry-run mode for testing.

**Deleted Modules / Dependencies:**

- `src/lib/` (entire directory) — Logic moved to `src/services/` and
  `src/utils/`.
- `src/types/index.ts` — No barrel re-exports; import from
  `src/schemas/domain.ts`.
- `src/lib/errors/types.ts` — Replaced by `src/errors/errors.ts`.
- `src/lib/schemas/index.ts` — Replaced by `src/schemas/domain.ts`.
- `src/lib/schemas/errors.ts` — Replaced by `src/errors/errors.ts`.
- `src/lib/__test__/fixtures.ts` — Replaced by `src/utils/fixtures.test.ts`.
- `workspace-tools` — Replaced by `workspaces-effect`. Domain services
  consume the upstream `WorkspaceDiscovery` Tag directly.
- `src/services/workspaces.ts` and `src/services/workspaces.test.ts`
  (issue #38) — The local `Workspaces` wrapper service became unnecessary
  once `workspaces-effect@0.5.1` exposed
  `WorkspaceDiscovery.listPackages(cwd?)` and
  `WorkspaceDiscovery.importerMap(cwd?)` accepting an optional cwd
  parameter. `RegularDeps`, `PeerSync`, `Lockfile`, and `Changesets` now
  yield `WorkspaceDiscovery` from `workspaces-effect` directly.
- The empty-changeset fallback path inside `Changesets.create` (a generic
  patch was previously written when nothing else triggered).
- The single-section `DEP_FIELDS = ["devDependencies"]` constant in
  `RegularDeps` — replaced by `DEP_SECTIONS` covering
  `dependencies` / `devDependencies` / `optionalDependencies`, each with
  its accurate `type` field.

**Next Steps:**

1. Integration testing with real GitHub App in CI.
2. Documentation: user guide and troubleshooting.
3. Lift `SilkPublishabilityDetectorLive` (and any silk-specific changeset
   logic) into `@savvy-web/silk-effects` once that package exists.
4. Support for additional changeset strategies beyond `patch`.

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
