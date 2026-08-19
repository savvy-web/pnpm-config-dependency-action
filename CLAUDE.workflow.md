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

The **duplicate resolutions are also gone**: `@effected/workspaces` and
`@effected/npm` each resolve exactly one copy, so the second workspaces copy that
`@savvy-web/silk-effects` used to drag into `dist` is no longer bundled. Verify
with `pnpm why <pkg>` — the lockfile grep reports which versions exist, never who
pulls them.

## Development & Release Cycle

### The `dev` branch convention

All in-progress work lands on the long-lived **`dev`** branch, never directly on
`main`; `main` always reflects the last released state. The shared release
workflow (`savvy-web/.github/.github/workflows/release.yml`) has a matching `dev`
branch — a caller normally pins `@main`.

### Testing dev-branch builds

Two independent switch points: `.github/workflows/silk-update.yml` here runs
`uses: savvy-web/silk-update-action@v4` (flip to `@dev` to run the committed
dev-branch `dist` against this repo), and `.github/workflows/release.yml` calls
the shared workflow at `@main` (flip to `@dev`). Trigger, `gh run watch`, then
revert once the release is cut.

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
