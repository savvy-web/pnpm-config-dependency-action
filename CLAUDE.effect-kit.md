# Effect Kit and Service Inventory

Child context file of [CLAUDE.md](./CLAUDE.md).

**Load when:** wiring or editing a service or layer, reaching for a kit API, or
hitting an Effect v4 spelling error. The hazards that bite *without* being looked
up — the `Action.run` requirement-channel hole and the `Schema.TaggedError`
rename — stay in the root file's Gotchas; this is the inventory behind them.

## Kit services

`@effected/github-actions` (`Action`, `ActionInput`, `ActionEnvironment`,
`ActionOutputs`, `ActionState`, `DryRun`, `GitHubToken`, **`GitHubMarkdown`** —
the GFM writer, capital H; `GithubMarkdown` was a *rename*, not a removal, and
this repo hand-rolled a copy for a release on that misreading. The local copy
(`src/utils/github-markdown.ts`) is now **deleted**; only `bold`/`rule` have no
kit equivalent and they stay in `src/utils/markdown.ts`).

`@effected/github` (`GitHubApp`, `Repo`, `GitBranch`, `GitCommit`, `CheckRun`,
`PullRequest` — all failing with a single `GitHubError`, discriminated by
`hasKind`); `@effected/commands` (`Run` free functions over core
`ChildProcessSpawner` — no `CommandRunner` service); `@effected/git`
(`Git.status` / `Git.configSet` only — the mutating tier is declined);
`@effected/npm`, `workspaces`, `lockfiles`, `runtimes`, `semver`, `yaml`.

Layers are `.layer` / `.layer(opts)` **statics on the service class**, not `*Live`
constants; services expose companion `*Shape` interfaces; workspace layers are
**root-bound at build**, so their methods are arg-less.

## Domain services

`BranchManager`, `PackageManagerUpgrade`, `ConfigDeps`, `CatalogConfigDeps`,
`RegularDeps`, `ReleaseAge`, `RuntimeUpgrade`, `Changesets`,
`Report` — **every one wired as a `static layer` on the class**, the same
convention as the kit, declared *in* the class body (a member attached after the
class is tree-shaken out of `dist` and fails only in production). No `*Live`
constant survives in `src/services/`.

Stateless helpers: `detectPackageManager`, `syncPeers`, `fetchModuleCatalogs`,
the `workspace-yaml` functions and the `lockfile` functions
(`captureLockfileState`, `compareLockfiles`) — the `WorkspaceYaml` and
`Lockfile` **tags and layers were deleted**, since nothing in `src/` wired them
and their only consumer was their own test, in each case.

**Both `package.json` writers** (`RuntimeUpgrade`, `PackageManagerUpgrade`)
resolve `PackageJsonFile` in their **layer bodies**, so `makeAppLayer` must
provide it to each. See the requirement-channel gotcha in the root file — this is
the wiring that shipped v4.6.0 dead.

**`Report.layer` resolves `ActionState`** (the DCO sign-off, read once from the
persisted token via `resolveSignoff()`), and this is the *other* outcome of the
same pattern: `ActionState` is an `ActionServices` member, so it is **not**
provided in `makeAppLayer` — it is left in the requirement channel for
`Action.run` to satisfy, like `ChildProcessSpawner` under `BranchManager`. So
"a service resolved in a layer body" splits two ways: provide it locally, or
confirm it is an `ActionServices` member and leave it. **Only
`__test__/unit/layers/app.test.ts` tells the two apart** — omitting a needed
provide is not a type error at any call site.

## Changesets

`services/changesets.ts` is a thin adapter over `Changesets.DepsRegen`
(`@savvy-web/silk-effects`, wired as `DepsRegenDefault`), which owns the
cumulative `merge-base(base) → worktree` diff, consolidation and
versionable-minus-ignored gating — this repo computes none of it. `plan` refreshes
workspace discovery, so it sees manifests edited earlier in the run.

## Errors

The `ActionError` union is exactly `InvalidInputError` (inputs, branch refs,
yarn/no-workspace), `FileSystemError`, `ChangesetError` and `LockfileError` —
every member has a construction site. Kit failures arrive as `GitHubError` and
`CommandFailedError`/`CommandOutputError`. `GitHubApiError`, `GitError`,
`PnpmError` and `DependencyUpdateFailures` were **deleted** for having none;
`__test__/unit/errors/errors.test.ts` pins the exported set, so re-adding one
fails a test.

**The same argument deletes dead helpers, not just errors** — `parsePnpmVersion` /
`formatPnpmVersion` / `ParsedPnpmVersion` went from `src/utils/pnpm.ts` on exactly
this reasoning. **And a helper that is very much alive can still go, on a
different argument: the kit shipped the capability** — which is how
`corepackHashFromIntegrity` and `PackageManagerUpgrade`'s private `parsePmVersion`
went. Keep the two arguments distinct: "no caller" and "the kit ships it now"
imply different follow-ups. Both incidents in full, with the upstream issue
numbers, are in the root file's `src/utils/pnpm.ts` gotcha — not restated here.

## Effect v4 spellings

`Context.Service`; `NodeServices.layer`; `FileSystem`/`Path` from `effect`,
`HttpClient`/`FetchHttpClient` from `effect/unstable/http`,
`ChildProcess`/`ChildProcessSpawner` from `effect/unstable/process`;
`Effect.catch`, `Effect.result` (returns a `Result`), `Effect.timeoutOrElse`; log
levels are string literals set via `References.MinimumLogLevel`.

## Token lifecycle

Provisioned in `pre.ts` (credentials via `ActionInput`, fail-fast `required` scope
check for `contents`/`pull_requests`/`checks: write`), persisted to `ActionState`,
read back by `GitHubToken.clientLayer()` in `makeAppLayer`, revoked in `post.ts`.
No `GITHUB_TOKEN` bridge.

## Testing services

Mock via `Layer.succeed`, a service's `layerTest`, or the doubles in
`__test__/utils/action-doubles.ts`; script commands with `ScriptedSpawner`. Never
mock `@actions/*` — the kit implements the protocol natively.
