# Dogfooding, Branching and Release

Child context file of [CLAUDE.md](./CLAUDE.md).

**Load when:** linking or overriding a first-party dependency, cutting a release,
touching `.github/workflows/**`, or reasoning about why `dev` was clobbered.
Not needed for ordinary source or test work.

## Dogfooding First-Party Dependencies

Every first-party dependency is ours, so a bug or missing API can be fixed **in
its own repo** and dogfooded here before publishing. The action is **bundled** —
`pnpm build` inlines everything into `dist/{pre,main,post}.js` — so a consumer
workflow on `@dev` runs the committed `dist`, not `node_modules`.

| Package | Repo | Link mechanism |
| --- | --- | --- |
| `@savvy-web/silk-effects`, `@savvy-web/github-action-builder`, `@savvy-web/silk` | `savvy-web/systems` (`packages/<name>`) | direct → `pnpm link` |
| `@effected/*` (the whole kit + its transitives) | `spencerbeggs/effected` (one monorepo, `packages/<name>`) | direct + transitive → `link:` override |

- **Direct-only → `pnpm link`** (e.g. `pnpm link ../systems/packages/silk-effects`);
  verify via `node:fs` (NOT `require(...package.json)` — `exports` hides it) or
  `pnpm why <pkg>`.
- **Also transitive → `pnpm-workspace.yaml` `overrides`** targeting
  `link:../../spencerbeggs/effected/packages/<name>/dist/dev/pkg`, then
  `pnpm install`. A bare `pnpm link` would leave the transitive copy on the
  registry version and bundle two copies; verify with
  `find node_modules -path "*@effected/<name>"`.

Procedure: build the library (`pnpm ci:build`) → link/override + `pnpm install` →
keep the declared range correct for the eventual unlinked install → iterate
(`pnpm typecheck`, `pnpm test`, `pnpm build`) → commit the **full dogfood state**
to `dev` (`src` + `dist` + changeset + override + `pnpm-lock.yaml`) → exercise it
via a consumer workflow on `@dev` → **after** the library publishes, remove the
link/override and pin the published range. The override holds a machine-specific
path, so `dev` then only installs with the sibling repos checked out — the
accepted trade-off. Commits must be GPG-signed with the verified key for
`C. Spencer Beggs <spencer@savvyweb.systems>`.

**The vendored `.repos/effect` and `.repos/effected` checkouts are reference
source, and re-pinning them is part of a dependency bump, not a chore after it.**
Re-pin in the same commit as the bump, and verify by comparing the vendored
`packages/<name>/package.json` against `node_modules` — **never** by reading the
tag name, which is what let both pins drift for several waves before this
reconciliation caught them. `.repos/config.json` carries the full rule, including
why neither `purpose` field names a version.

**Currently active:** nothing is **linked** — every first-party dep is on its
published registry version (see `package.json`). `@effect/vitest` reads
`catalog:effect`, so the lockstep with `effect` is now **structural**: the
`effect` catalog pins both to the same prerelease, and a catalog advance moves
them together with no hand-edit. It used to be an exact literal pin that had to be
bumped manually, which is the failure mode this removed.

There are **no `overrides` entries**. The former `@effect/platform-node-shared`
pin (held at `4.0.0-beta.101` because a caret on a prerelease admitted a
`beta.102` whose peer range the catalog pin did not satisfy) went away with the
`beta.107` advance and has not come back: the graph resolves a single
`platform-node-shared` against a single `effect`, at whatever the catalog
currently pins. **What is load-bearing is "one copy of each, peers satisfied",
which `pnpm why` answers and a version number never did** — which is why no
current version literal appears in that sentence, and why re-adding one would be
a regression rather than an update.

The **workspaces duplicate has closed (measured 2026-09-04)**, and how it closed
matters more than that it did. This paragraph read "the duplicate is BACK
(measured 2026-08-21)": this repo had hand-bumped `@effected/workspaces` for
`WorkspaceCatalogs.refresh()` while `@savvy-web/silk-effects` sat a `0.x` minor
behind, so two copies resolved and both reached `dist/main.js`. What resolved it
is a **shape change upstream, not a version bump** — silk-effects declares
`@effected/workspaces` as a **peerDependency** now rather than a direct
dependency, and a peer range this repo already satisfies cannot duplicate.
Today every one of the twelve installed `@effected/*` packages resolves exactly
one copy, as does `effect`. The confirming probe is the same one that proved the
duplicate: `@effected/workspaces/WorkspaceCatalogs`, `…/WorkspaceDiscovery` and
`…/WorkspaceRoot` each occur **once** in the minified `dist/main.js` — matching
the single-copy controls `@effected/npm/NpmRegistry` and
`@effected/github/GitBranch` — where they occurred twice.

**Do not read that as settled.** This same claim has said "closed" twice before
and been falsified each time within one dependency bump — once by a transitive
pulling a second `@effected/github` in behind an unrelated bump, once by this
repo's own hand-bump. It is a **dated measurement, not a property**. Detail in
`.claude/design/silk-update-action/01-dependencies.md`. Verify with
`pnpm why <pkg>` — a lockfile grep reports which versions exist, never who pulls
them.

## Development & Release Cycle

### The `dev` branch convention

**`dev` IS the feature branch for this action.** Feature work is committed
directly to the long-lived `dev` branch with ordinary commits — not to a
short-lived branch that is later squashed into it. `main` always reflects the
last released state. The shared release workflow
(`savvy-web/.github/.github/workflows/release.yml`) has a matching `dev` branch —
a caller normally pins `@main`.

**The reason is the test mechanism, and it is the whole point of the
convention.** This action is *bundled*: a consumer pinning
`uses: savvy-web/silk-update-action@dev` executes the **committed `dist`**, not
`node_modules`. So the only way to exercise a change end to end — against a real
workspace, with real config-dependency plugins, opening a real PR — is:

1. `pnpm build:prod` (the committed bundle is the artifact under test)
2. commit `src` + `dist` together
3. push to `dev`
4. trigger the consumer's workflow and read the run

A feature branch cannot be tested that way, because nothing consumes it. That is
why the work lives on `dev` rather than arriving there finished.

**Therefore: never rewrite `dev` — no squash, no force-push, no rebase.** It is
a shared branch that other repositories' CI actively runs, so rewriting it
changes code under a running consumer. In particular
**`/design-docs:finalize` is the wrong workflow here** — it soft-resets to the
merge base, recommits, and pushes, which on an in-sync `dev` requires a force
push. Its own preflight refuses when the current branch is `dev`; if it ever
does not, stop anyway.

**A `dev` → `main` PR is the exception, and is the intended path** — it is how
this work finalizes, whether opened by hand or by `promote-deps-to-main.yml`
(below). What is prohibited is an *ad hoc feature* PR cut from `dev` to
somewhere else, and any history rewrite. Squashing happens at **merge**, by
GitHub, which collapses the branch without rewriting it first — which is why a
finalize-style squash step is redundant here as well as unsafe.

Two further consequences worth stating, because both have bitten:

- **A `dist` that is stale relative to `src` is a silently wrong test.** The
  consumer runs the bundle, so forgetting step 1 tests the previous change.
- **A dogfood link puts an *unreleased* dependency into that bundle.** That is
  sanctioned on `dev` (see the dogfooding section above) and is exactly how a fix
  gets proven before release — but the bundle must be rebuilt against the
  registry and pushed again after `--exit`, or consumers keep running code that
  was never published.

### Testing dev-branch builds

Two independent switch points: `.github/workflows/silk-update.yml` here runs
`uses: savvy-web/silk-update-action@v4` (flip to `@dev` to run the committed
dev-branch `dist` against this repo), and `.github/workflows/release.yml` calls
the shared workflow at `@main` (flip to `@dev`). Trigger, `gh run watch`, then
revert once the release is cut.

**A second consumer is usually the better test**, and needs no flipping:
`savvy-web/systems` already pins `@dev` permanently. Pushing a rebuilt `dist` to
`dev` and dispatching its `Update Silk Dependencies` workflow exercises the
action against a real monorepo — which is how the `check-peers` gate was proven,
across three runs that each failed differently (a missing layer provide, a
permanently-`unverified` peer report, then a clean `not gating (proven-clean)`
with auto-merge actually enabled on the resulting PR). None of those three was
reachable from this repo's own suite.

### Flow: `dev` → `main` → release

Work accumulates on `dev` and merges to `main` (dependency-update PRs arrive via
`promote-deps-to-main.yml`). Push to `main` → **Phase 1** changeset detection and
the release PR on `changeset-release/main`; pushes to that branch → **Phase 2**
validation (build, publish dry-runs, release-notes preview, sticky comment);
merging it → **Phase 3** publish, tags, GitHub release, which fires
`release-sync.yml`.

### `release-sync.yml` / `promote-deps-to-main.yml`

`release-sync.yml` (on `release: [published]`, as the App bot) closes the loop: on
a **stable SemVer >= 1.0.0** tag it moves the `v<major>` alias tag and
**hard-resets `dev` to `main`** — a genuine clobber, safe because `dev` work always
lands in `main` first. Pushes are skipped when the ref already matches;
prerelease/sub-1.0.0 tags are no-ops.

`promote-deps-to-main.yml` opens it: `silk-update.yml` must run with
`source-branch: dev` so its `pnpm/config-deps` PR merges into `dev`, which
triggers this workflow to mint an App token
(`actions/create-github-app-token@v3`) and open a `dev -> main` PR left **open for
review**. Idempotent and non-recursive.

### Code Quality

Biome (lint + format, **tabs**), commitlint (conventional commits + DCO signoff),
husky (`pre-commit` lint-staged, `commit-msg` validation, `pre-push` tests).

### TypeScript

Composite builds with project references, strict mode, ES2022/ES2023.
