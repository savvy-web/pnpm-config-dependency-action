---
status: current
module: silk-update-action
category: architecture
created: 2026-02-20
updated: 2026-07-26
last-synced: 2026-07-26
completeness: 95
related:
  - ./_index.md
dependencies: []
implementation-plans: []
---

# Project Status

[Back to index](./_index.md)

## Current State

The action is Effect-first and runs as three phases (`pre` / `main` / `post`)
around the `GitHubToken` token lifecycle. It runs on **Effect v4** and the
**`@effected/*` kit** — `github-actions`, `github`, `commands`, `npm`,
`workspaces`, `lockfiles`, `runtimes`, `semver`, `yaml` — plus
`@savvy-web/silk-effects` for the changeset step. The former all-in-one
`@savvy-web/github-action-effects` is **deleted**; its surface was split across
those kit packages (mapping table in @./01-dependencies.md).

All domain logic is wrapped as Effect services with `Context.Service` + `Layer`,
plus a few standalone helper modules (`detectPackageManager`, `syncPeers`,
`fetchModuleCatalogs`, the `WorkspaceYaml` / `Lockfile` helpers). Layer
composition is centralized in `src/layers/app.ts`.

**Architecture:**

- **Three-phase entry:** `src/pre.ts` provisions the GitHub App installation
  token (`GitHubToken.provision`, explicit credentials parsed via `ActionInput`,
  fail-fast `required` scope check) and records a start time; `src/main.ts` is a
  thin `Action.run(program)` wrapper; `src/post.ts` reports duration and revokes
  the token. The testable pieces (`readInputs`, `program`, `innerProgram`,
  `runCommands`, `runInstall`) live in `src/program.ts`; cross-phase schemas in
  `src/state.ts`.
- **Package-manager dispatch:** `detectPackageManager()` resolves root + manager
  once, inside the check run, and every dispatch point (config deps, install,
  manager upgrade, workspace formatting) reads that one value. pnpm, bun and npm
  are supported; yarn is rejected with `InvalidInputError`.
- **Inputs go through `ActionInput`, never bare `Config`.** `readInputs` is
  extracted and tested against a runner-shaped `INPUT_*` environment.
- **Layer composition:** `makeAppLayer(dryRun, { runtimeLive })` builds the
  `GitHubClient` from `GitHubToken.clientLayer()` (`Layer.orDie`) and `Repo` from
  `Repo.layerFromConfig()`; `ActionState` comes from `Action.run`'s runtime rather
  than being rebuilt. `runtimeLive` selects offline vs live `@effected/runtimes`
  resolvers. **Its requirement channel is pinned at compile time** by
  `__test__/unit/layers/app.test.ts` — `Exclude<AppLayerRequirements,
  ActionServices>` must be `never` — because `Action.run`'s optional `options`
  parameter means a missing provide is not otherwise a type error. See the
  settled decision below for the production failure that motivated it.
- **Tests are not co-located:** every unit suite lives under `__test__/unit/`
  mirroring `src/`, with reserved helper modules in `__test__/utils/`.
- **No barrel re-exports:** direct imports everywhere.

**Implemented features:**

- Three-phase execution with the `GitHubToken` lifecycle: `provision()` (pre) →
  `clientLayer()` (main) → `dispose()` (post, never fails the workflow). The
  envelope is persisted to `ActionState` (backed by `GITHUB_STATE`) — no
  `process.env.GITHUB_TOKEN` bridge.
- Branch management via `GitBranch.upsert` (create when absent, force-reset to the
  source ref when present), with `validateBranches` failing fast on a missing
  `source-branch` / `target-branch` before the reset.
- Config dependency updates, dispatched on the package manager: **pnpm** edits
  `pnpm-workspace.yaml` (`ConfigDeps`); **bun** merges the config dependency's
  `catalogs` export into `package.json` via a three-way merge against the
  lockfile's installed version (`CatalogConfigDeps` + `fetchModuleCatalogs`),
  emitting `CatalogDelta` records that reach the PR body; **npm** is skipped with a
  warning (no `catalog:` protocol). Resolution uses a conservative range
  synthesized from the current major, never npm's absolute latest.
- Regular dependency updates resolving within each specifier's own range
  (caret-on-zero widened to `>=version <2.0.0`), across `dependencies`,
  `devDependencies` and `optionalDependencies`, reporting the real section type
  per update. Under bun, names owned by the config-dep path are excluded so one
  manifest entry is not bumped twice.
- Release-age gating (`ReleaseAge` over `@effected/npm`'s `ReleaseAgeGate`),
  discovered from inline `pnpm-workspace.yaml` keys plus a subprocess replay of
  config-dependency pnpmfile hooks, combined strictest-wins, with publish times
  from `NpmRegistry.publishTimes`. Fail-open by design.
- Peer dependency range syncing (`peer-lock` / `peer-minor`).
- Peer-dependency health gating (`check-peers`, `PeerCheck` from
  `@effected/workspaces` over the regenerated lockfile plus
  `WorkspaceCatalogs.peerDependencyRules()`): reports unsatisfied peers into the
  PR body, job summary and `result`, and under `no-auto-merge` skips the separate
  `setAutoMerge` call so the PR still opens but cannot merge itself. Gates only on
  a **proven-clean** report — `supported`, no unresolved importers, nothing
  `unverified`, no required rows — because each of the other three yields an empty
  result meaning "not examined" rather than "nothing wrong". The rules read is
  preceded by `WorkspaceCatalogs.refresh()` (workspaces `0.17.0`), so the
  after-install lockfile is judged under the after-install plugins' rules
  rather than the assembly release-age discovery memoized before the run
  installed — the time-skew corollary recorded at the end of the
  lockfile-finding section below, with depth in @./05-module-library.md.
- Package-manager self-upgrade (`PackageManagerUpgrade`) for pnpm, bun and npm,
  driven by `upgrade-package-manager` (`false` — the **default** — / `true` /
  `auto` / a semver range). corepack-managed managers are written hash-pinned into
  both `packageManager` and `devEngines.packageManager`; bun is written bare.
  `upgrade()` always returns an outcome, so a skip reports its `kind`, and the
  `unsatisfiable` kind (a range typed for a different manager) warns.
- `devEngines.runtime` upgrades (`RuntimeUpgrade`) for node/deno/bun: upgrade only,
  never add; always writes the bare exact resolved version; `auto` no-ops on a
  static pin; EOL major lines are skipped with a warning. Runtime bumps never
  create a changeset and never trigger the install.
- **Both manifest writers edit surgically.** `RuntimeUpgrade` and
  `PackageManagerUpgrade` apply their changes through
  `@effected/package-json`'s `PackageJsonFile.modify` — a decode-free JSONC edit
  at a field path — so key order, indentation and line endings survive
  byte-for-byte, and a write that would be byte-identical is skipped entirely.
  They previously re-serialized the parsed tree with a guessed indent, which
  could reformat regions the run never intended to touch in a manifest the
  action then commits to someone else's repository.
- Lockfile regeneration per manager (`pnpm clean --lockfile` + install;
  `bun install --force`; unlink `package-lock.json` + `npm install`).
- Workspace YAML formatting (pnpm only), custom command execution with error
  collection, lockfile comparison, changeset creation via silk's `DepsRegen`,
  verified commits via `GitCommit.commitFiles`, PR create/update via
  `PullRequest.upsert` with `setAutoMerge` degrading to a warning, check-run
  lifecycle with an explicit conclusion on every terminal state, and dry-run mode.

**Recent change with a behavioral consequence:** `upgrade-package-manager`'s
default flipped from `"true"` to `"false"` (a breaking change), making it opt-in
and consistent with the `upgrade-runtime-*` inputs. A workflow that configures
**nothing** now fails the "at least one update type must be active" validation
rather than silently performing a package-manager-only run.

**Known loose ends:**

- `action.config.ts`'s `build.ignore` list (`xmlbuilder2`, `libxmljs2`,
  `ajv-formats-draft2019`) is vestigial: it existed for `@cyclonedx/cyclonedx-library`,
  which came in transitively through the deleted `github-action-effects` and no
  longer appears in the lockfile at all. Harmless, but the comment there still
  describes the old provenance.
- **Duplicate resolutions: recurring, not closed — and currently OPEN.** As of
  2026-08-21, `@effected/workspaces` resolves **two copies** (`0.17.0` direct,
  `0.16.0` through `@savvy-web/silk-effects@6.0.4` and dev tooling), and the
  tag-string probe indicates **both reach `dist/main.js`** — the exact
  silk-effects duplicate this bullet used to describe as closed, recurring in
  the other direction because this repo hand-bumped to `^0.17.0` for
  `WorkspaceCatalogs.refresh()` while silk-effects' `0.x` caret stays on
  `^0.16.0`. Safe today by the "shapes agree" rule (this action's imports
  resolve `0.17.0`, so its layers have `refresh()`); it dedupes when
  silk-effects bumps. Measurement, method and the hazard statement are in
  @./01-dependencies.md. The bullet's history stands: **it said "closed" for a
  release and was wrong within one dependency bump** (moving `@effected/npm`
  pulled a second `@effected/github` in behind it), then said "every package
  resolves one copy today" and was falsified by this repo's own next kit bump.
  Re-verify with `pnpm why <pkg>`, never a lockfile grep: the grep reports
  which versions exist, only `pnpm why` reports who pulls each one.
- **`@effected/package-json` is adopted for `PackageJsonFile.modify` only** —
  a declared runtime dependency, wired as `PackageJsonFile.layer` in
  `makeAppLayer` and consumed by both `RuntimeUpgrade` and
  `PackageManagerUpgrade`, landing in `f55fab6` (the commit immediately before
  the 4.6.0 release).
  - **The prior "deliberately NOT adopted" ruling was NARROWED, not
    overturned.** That distinction is the whole content of this entry. The
    ruling's central objection — `Package.decode` requires `name` and a
    strict-semver `version`, so it rejects the private workspace root this action
    must edit — **still stands and is still operative**: the decode path is
    unused, both services still read with `readFileSync` + `JSON.parse`. What was
    adopted is one decode-free member. Read it as *"declined in whole → adopted
    for one member, with the original objection intact for the rest"*.
  - Detail, the superseded argument reproduced in full, and what changed upstream
    are in the settled-decisions section below.

  Of the four helpers the decline listed as "therefore staying", the adoption
  **replaced one, orphaned two and left one genuinely load-bearing** — verified
  by call site, not by reading the old table:

  | helper | status now |
  | --- | --- |
  | `corepackHashFromIntegrity` | **DELETED — the row below it is now the only "stays".** It stayed on one condition, stated in this table: *"the kit still ships no SRI → corepack converter — upstream #281."* The kit shipped it (`@effected/npm@0.11.0`, `CorepackIntegrityHash.fromSri`, tracked here as #290), citing this very call site as its consumer evidence, and the helper went. See the note below on why this row aged well while the one under it did not |
  | `detectIndent` | **stays, but not for the recorded reason.** Its three call sites are `peer-sync`, `regular-deps` and `catalog-config-deps`, none of which went through `PackageJsonFile`. The two services the decline was *about* no longer call it at all: `modify` preserves indentation exactly, where `detectIndent` could only guess right |
  | `findRuntimeEntry` | **replaced** by `locateRuntimeEntry`, which returns the entry **and the JSONC path to its `version`**. The decline's stated virtue — returning the live object so `.version =` rewrites in place — is now the thing being avoided: nothing is mutated, the path is handed to `modify` |
  | `parsePnpmVersion` / `formatPnpmVersion` | **DELETED**, along with the `ParsedPnpmVersion` interface. Zero callers, and the recorded reason for keeping them had independently expired. See below |

  **On the deleted pair, because an audit would otherwise get it wrong twice.**
  The table's original entry justified them as *"`PackageManager.FromString`
  rejects the caret pin (`pnpm@^11.20.0`) these accept"*. **Both halves of that
  were false, independently:**

  - The kit had stopped rejecting the caret pin. `0.9.0` added
    `PackageManagerRange`, whose own TSDoc uses exactly this example —
    `decode("pnpm@^11.20.0") → { name: "pnpm", range: "^11.20.0", isExact: false }`
    (`node_modules/@effected/package-json/index.d.ts:1009`).
  - The helpers had **no callers at all**. `package-manager-upgrade.ts` parses
    with a module-private `ParsedPmVersion` / `parsePmVersion` generalized over
    all three managers — which superseded the pnpm-only pair during the
    multi-package-manager work without removing them. (That private parser has
    since been retired too, onto `@effected/npm`'s `PackageManagerPin`; two of
    its three fields turned out to have no reader either. See
    @./03-type-definitions.md.)

  So this was the "exported, never constructed" shape that got four error classes
  deleted (@./03-type-definitions.md) — a dead export kept alive by a
  justification that had itself stopped being true. `src/utils/pnpm.ts` now
  exports only `detectIndent`, and keeps a comment block where each deleted
  export was so the reasoning is discoverable from the source rather than only
  from here.

  **A row that named its own expiry condition, and what happened when the
  condition was met.** The `corepackHashFromIntegrity` row above is the one
  entry in this table that aged *well*, and the contrast with the pair below it
  is the reusable part. Both rows were justified by a claim about upstream. The
  pair's claim ("the kit rejects the caret pin") was **already false when
  written** and nothing in the row said how to tell. The converter's claim ("the
  kit ships no SRI → corepack converter — upstream #281") was true, *named the
  issue that would falsify it*, and was falsified on schedule by
  `@effected/npm@0.11.0` — at which point the row was actionable rather than
  merely wrong, and the deletion followed in an hour.

  The difference is not diligence, it is **whether the justification points at
  something checkable**. "The kit still ships no X — upstream #N" can be
  resolved with one `npm view`; "the kit rejects Y" is a claim about a behaviour
  nobody re-runs. Prefer the first form. And note what it does *not* buy, which
  is the same limit recorded for the `@effected/package-json` decline: naming a
  falsification condition creates **no obligation for anyone to notice it was
  met**. #290 was filed explicitly as "tracking, no action required yet" and sat
  until this repo touched the area — which is the intended lifecycle, not a
  failure, provided the row is read when the area is next opened.

  **The loop is worth recording, because it ran in the unusual direction.** The
  doc pass found the orphan; the doc pass established that the justification was
  obsolete; the source change followed. Reconciling the
  `@effected/package-json` record *required* checking, call site by call site,
  which of these four helpers the adoption had actually replaced — and it was
  that check, not a lint rule or a review, that surfaced two dead exports and one
  expired rationale. Which is an argument for the audit being call-site-driven:
  had it been done by re-reading the table, every row would have been confirmed.

  A second-order trace, as a cheap general habit: `CLAUDE.md` had been
  advertising `--testNamePattern="parsePnpmVersion"` as its example command, for
  a test that no longer existed — **a dead export leaves fingerprints in
  documentation that outlive every call site**, so grepping the docs for a symbol
  finds things grepping the source does not. (Since corrected there to
  `buildUpdateSubject`, which does have a suite.)

- **`@effected/git` is adopted for `status`, not for the mutating tier**
  (upstream spencerbeggs/effected#279; local ruling
  savvy-web/silk-update-action#246). Both status readers use `Git.status`, and
  `Git.configSet` writes the `core.fileMode` pin; the other seven local git
  operations stay on `Run`. Detail and the corrected reasoning are in the
  settled-decisions section below — **the earlier "deliberately NOT adopted"
  ruling was overturned in part**, and the reason it was overturned matters more
  than the verdict.
- **Raw `node:fs` / `node:path` use is pervasive and unresolved.** Core
  `FileSystem` / `Path` are ambient (they are members of `ActionServices`), so
  these are drift rather than necessity — the kit's rule is that a raw `node:`
  import is sanctioned only inside `@effected/github-actions` itself. The
  current count is **13 modules**, from `grep -rl 'from "node:' src/`:
  `utils/deps.ts`, `steps/install.ts`, and `services/{branch,
  catalog-config-deps, changesets, config-deps, lockfile, module-catalogs,
  package-manager-upgrade, peer-sync, regular-deps, runtime-upgrade,
  workspace-yaml}.ts`. `module-catalogs.ts` is the one defensible case
  (`node:crypto` / `os` / `url` for tarball extraction).
  - `format.ts` **is no longer among them** and the previous version of this
    list was wrong to name it — the module's own doc comment records that its
    only raw `node:fs` import was removed. Recount rather than edit this list;
    see the note in "How to read the claims" below, where it has now been wrong
    twice.
  - `runtime-upgrade.ts` and `package-manager-upgrade.ts` still appear here even
    though their **writes** go through `PackageJsonFile.modify` — both still
    `readFileSync` the manifest to decide. That is deliberate (the kit's decode
    path is declined; see the settled decision), so it is drift that will not be
    closed by finishing the adoption.
  - **Correction to the original audit.** That finding claimed "14 modules" while
    enumerating only 12, and the enumeration omitted `services/lockfile.ts`
    because the grep it came from silently skipped that file — see the
    NUL-byte note below. The count, the list, and each other all disagreed. The
    conclusion — that the drift is pervasive — was right; the evidence presented
    as exhaustive was not. Do not cite the original enumeration.
- **Resolved, worth keeping:** `services/lockfile.ts` used to carry a **raw NUL
  byte** — the separator in `` `${dep.name}\0${dep.depType}` ``, written as a
  literal `U+0000` rather than the `\0` escape. The NUL itself is correct (a
  package name cannot contain one, so it is a safe composite-key separator); the
  raw encoding was not. `file(1)` reported the source as `data`, and **grep
  treated the whole 531-line file as binary and silently skipped it** — returning
  what looks exactly like a clean no-match.
  - That is why the audit enumeration above was wrong, and it is worth
    remembering as a class rather than an incident: a search that returns nothing
    because it could not read the file is indistinguishable, at the call site,
    from a search that returns nothing because there was nothing to find.
  - Fixed by replacing the raw byte with the `\0` escape. The runtime string is
    unchanged — verified both by an escape-equivalence probe
    (`\0` === `String.fromCharCode(0)`) and by `dist/main.js` rebuilding
    **byte-identical**. Note that the test suite could *not* have caught a broken
    escape here: `depKey` is used symmetrically on both sides of every
    comparison, so a wrong separator would still compare equal to itself.

## The `effect@4.0.0-beta.107` advance

**This section is history, not current state — the heading names the advance it describes, and the catalog has since moved past it, into `4.0.0-rc`.** Kept at its own version rather than retitled, because everything below is a claim *about that specific advance*; renumbering the heading would silently restate all of it as current, which is precisely the failure this document catalogues elsewhere. The `beta.107` literals further down are load-bearing history and stay. `beta.107` claims about **now** were removed — from the loose-ends bullet above, from @./01-dependencies.md, from @./08-testing.md and from the two root context files. Re-derive the current pin from the tree, never from this heading.

Moved with the `@effected` kit's coordinated wave (upstream
spencerbeggs/effected#322): `catalog:effect` to `beta.107` via
`@effected/pnpm-plugin-effect@0.4.0`, every `@effected/*` package to its
`.107`-native release, `@savvy-web/silk-effects` to `5.5.2`.

**The source change was four identifiers.** `Schema.TaggedErrorClass` →
`Schema.TaggedError` — a rename back to the v3 name, identical curried shape —
in the four class declarations in `src/errors/errors.ts`. Nothing else in `src/`
needed an edit.

Worth recording **how that presented**, because the shape is misleading and will
recur on the next advance: typecheck reported **50 errors across 14 files**, and
only two of them named `TaggedErrorClass`. The other 48 were the base type
collapsing — every `new SomeError({...})` reading "Expected 0 arguments, but got
1" and every field getter reading as a missing property, in modules that never
mention the renamed API. Fixing the four declarations cleared all 50. An advance
whose error list is dominated by call sites is still, usually, a declaration-site
problem: **find the declaration before touching a single call site.**

Three things came out of the advance rather than the port:

- **`@effect/vitest` moved to `catalog:effect`.** The exact-literal pin it
  replaced had to be hand-bumped in lockstep with every catalog advance; the
  catalog pins both to the same beta, so the lockstep is now structural. This is
  the durable fix for a gotcha that was previously enforced by a doc sentence.
- **The `@effect/platform-node-shared` override was deleted**, along with the
  duplicate-resolution loose end above. Both were artifacts of the `beta.101`
  pin and evaporated with the wave; no local repair was needed.
- **`DependencyType` gained an `identifier` annotation** after the beta.107
  lowering hoisted it into `$defs` under the positional name `Union_`. Detail in
  @./03-type-definitions.md.

**What did NOT happen, recorded because the migration brief anticipated it:** no
`.pnpmfile.cjs` retarget hook, no `pnpm patch` compat shims, no `SchemaAST.Sentinel`
d.ts patch. The kit republished `.107`-native, so adopting the new releases was
sufficient and the whole local-repair apparatus was unnecessary. A grep of the
installed graph for `TaggedErrorClass` returns three `@effected` packages — **all
three hits are README prose, not shipped code.** If a future advance needs that
apparatus, build the artifact list from the graph, and confirm each hit is a real
call site before shimming it.

## A lockfile is not a package manager's effective graph

The load-bearing finding behind `check-peers`, kept here rather than in the
dogfood mailbox because it outlives the loop that produced it.

**pnpm persists resolution-affecting configuration into the lockfile and
discards reporting-affecting configuration.** `overrides` contributed by a
config-dependency pnpmfile **are** recorded in `pnpm-lock.yaml`;
`peerDependencyRules` appears **zero** times. That is rational from pnpm's side —
overrides change what gets installed, rules only change what gets *said* — and it
is exactly why a lockfile-only peer check cannot be correct without external
input. The artifact is complete for its own purpose and incomplete for ours.

The tell is in the lockfile header: `pnpmfileChecksum`. pnpm records it precisely
*because* the lockfile is not a complete record of the hooks' effect — if it
were, there would be nothing to invalidate against.

**Falsification, and how this was nearly mis-diagnosed twice.** The first
hypothesis was that the lockfile carried stale *pre-hook* peer data. It does not:
`packages:` records the genuine published range and `snapshots:` records what
actually resolved, and an entry is byte-identical between a plugin-using
workspace and a pnpmfile-free one. The second hypothesis was that reading
`pnpm-workspace.yaml`'s declarative `peerDependencyRules` would be enough. It is
not — **this repository declares none**, and its 36 effective rules are all
injected by config-dependency plugins, so a workspace-file-only read finds
nothing here and still produces false positives. Both hypotheses were plausible,
both were held confidently, and only measurement separated them.

*Re-derive with:* `grep -c peerDependencyRules pnpm-lock.yaml` (expect 0) against
`grep -n peerDependencyRules pnpm-workspace.yaml` (expect none) against the
plugin bodies under `node_modules/.pnpm-config/*/pnpmfile.cjs` (expect the rules).

**The corollary, found live a release later: the external input has a
timestamp.** The rules come from a hook replay, this run *changes the hooks*
(bumping a config-dependency plugin is the ordinary case), and
`WorkspaceCatalogs` memoizes its assembly — first triggered by release-age
discovery, before the install. So `check-peers` was judging the after-install
lockfile under the pre-install plugins' rules: spencerbeggs/pnpm-module-template#84
withheld auto-merge on a `required` row that the freshly installed
`@effected/pnpm-plugin-effect@0.5.0`'s `allowedVersions` suppress, and #85
auto-merged once the step called `refresh()` (workspaces `0.17.0`) before the
rules read. The before/after split is deliberate on both sides — release-age
gates what the run may *propose*, peer-check judges what it *produced* — so
one memo cannot serve both and the refresh call is the explicit boundary; an
enabled run replays the hook subprocess twice on purpose. Depth, the measured
pnpm `allowedVersions` parent-version semantics, and the discriminating
ordering test are in @./05-module-library.md.

**And the gate's fail-closed posture has now produced its own incident class,
worth naming so it is diagnosed quickly next time:** a report that abstains
(`unverified`) on a *clean* repo is indistinguishable, from the consumer's
side, from a repo with peer problems — auto-merge is simply withheld. Two
legitimate pnpm lockfile shapes (npm-alias edges, `publishDirectory` `link:`
edges) did exactly that under `@effected/lockfiles` ≤0.6.1
(spencerbeggs/type-registry-effect#122, live), fixed upstream in `0.6.2` via a
dogfood loop from this repo (effected#453) and pinned here by two real-fixture
drift canaries (@./08-testing.md). The lesson mirrors the section above:
fail-closed is the right posture *and* every abstention needs its reason
surfaced — which is why `PeerCheckStepResult.unverifiedReasons` exists — because
a gate that only says "unverified" sends the reader hunting for peer problems
that do not exist.

## Settled decisions — do not re-propose without new evidence

These were investigated, rejected on measurement, and are the half of this
record that a fresh audit will otherwise re-derive from scratch. Each names what
would change the answer.

### `@effected/package-json` — NARROWED: adopted for `modify`, decode path still declined (upstream #286)

**This entry previously read "not adopted". It was narrowed, not overturned** —
and the difference matters enough to be the heading. One member was adopted; the
ruling's central objection is untouched and still governs everything else. The
original argument is reproduced below rather than replaced, because most of it is
*still true*, and because the way the record went stale is itself the lesson.

**What the original ruling said.** Probed before migrating anything, which is why
nothing was half-migrated:

- `Package.decode` **requires both `name` and `version`**, so it rejects a
  private monorepo root (`{ "private": true, "packageManager": …,
  "devEngines": … }`) — precisely the manifest `RuntimeUpgrade` and
  `PackageManagerUpgrade` edit. Adoption would turn "edits your manifest" into
  "refuses your repo."
- It also rejects a caret `packageManager` pin (`pnpm@^11.20.0`), a form
  `parsePnpmVersion` supports and this action documents.
- The write path **sorts keys canonically**, so adopting it would reformat
  unrelated regions of a file the action then commits to someone else's repo.

It then named its own falsification condition: *"a lenient decode for the
workspace-root shape, and an order-preserving single-field edit. Both are asked
for in #286."*

**Which of those three objections survived — the load-bearing summary:**

| objection | status |
| --- | --- |
| `Package.decode` rejects the private workspace root | **stands, and is operative.** It is why the decode path is unadopted and why both services still `readFileSync` + `JSON.parse` |
| the caret pin is rejected | **obsolete** — `PackageManagerRange` accepts `pnpm@^11.20.0` since `0.9.0`. Moot regardless: the helpers it justified had no callers and are now **deleted** (`parsePnpmVersion` / `formatPnpmVersion` / `ParsedPnpmVersion`), so the bullet above survives only as reproduced history |
| the write path sorts keys canonically | **solved, and this is what was bought.** `modify` is a JSONC span edit, so key order never moves |

**What changed.** `@effected/package-json@0.9.0` (upstream PR
spencerbeggs/effected#366) shipped **both**, which is verifiable in the installed
package rather than inferred — `packages/package-json/CHANGELOG.md` in the
`.repos/effected` submodule, and the `PackageJsonFileShape` declaration in
`node_modules/@effected/package-json/index.d.ts`:

- `PackageManifest` — a presence-lenient model where `name`/`version` are
  optional and `packageManager` accepts the range spelling via
  `PackageManagerRange`. That answers bullets one and two.
- `PackageJsonFormat.modify` / `PackageJsonFile.modify` — a **decode-free**
  surgical field editor taking a JSONC `path` plus a `value`, preserving every
  byte outside the edited span, and skipping the write entirely when the result
  is byte-identical. That answers bullet three.

**What was actually adopted, and what was not.** Only `modify`. The action still
reads its manifests with `readFileSync` + `JSON.parse` in both
`runtime-upgrade.ts` and `package-manager-upgrade.ts`, and **`PackageManifest`,
`readManifest` and `writeManifest` are deliberately unused** — the adoption
changeset (`.changeset/adopt-package-json-modify.md`, shipped in `f55fab6`) says
so in as many words: the schema-decoding read path *"rejects manifests this
action must still be able to edit — a private workspace root with no
`name`/`version`, and a non-semver `version` such as `"1.0"`, are both legal in a
package nobody publishes."* So the decline's first bullet was not refuted; the
lenient decode simply was not needed, because the *decision* is made from the
parsed object and only the *write* goes through the kit.

**What it bought,** stated as the changeset states it rather than as a
generality: bumps are written as surgical edits instead of a whole-file
re-serialize, so key order, indentation and line endings survive byte-for-byte in
a diff opened against someone else's repository. The previous write reconstructed
the file from the parsed tree with a *guessed* indent, and could reformat regions
the run never intended to touch.

**What it cost — and this is the part the record did not capture until it broke
production.** `PackageManagerUpgrade.layer` began resolving `PackageJsonFile` in
its layer body, and `makeAppLayer` provided that service to `RuntimeUpgrade.layer`
only. That typechecked (see the `Action.run` hole below), passed 588 tests, and
killed **every run in every consumer repo** at v4.6.0 with
`Service not found: @effected/package-json/PackageJsonFile`, ~30ms in, before the
check run existed. Adopting a service into a second consumer is a **layer-wiring
change**, not just a call-site change, and nothing in the type system said so.

**What would change the remaining answer:** nothing outstanding is blocking the
decode path — `PackageManifest` exists and would accept the workspace root. It
is unadopted because the read is only used to decide, so decoding buys nothing
the raw parse does not already provide. Adopt it if a decision starts needing a
typed field (`packageManager.isExact` is the obvious candidate), not for
tidiness.

**Trap for the next auditor, still live:** this repo's own `package.json` is
already sorted by lint-staged, so a canonical-reorder write is a no-op *here*.
Checking only against this repo would have made the original write path look
safe — and would equally hide a regression if `modify` were ever swapped back
for a re-serialize.

### `makeAppLayer`'s requirement channel is guarded at compile time — keep the guard

**The hazard.** `Action.run` is declared
(`node_modules/@effected/github-actions/index.d.ts:803`):

```typescript
static readonly run: <E, R = never>(
 program: Effect.Effect<void, E, ActionServices | R>,
 options?: ActionRunOptions<R>,
) => Promise<void>;
```

`options` is **optional**, so `R` infers to whatever the program still requires
and *nothing forces a layer to be passed for it*. `main.ts`'s bare
`Action.run(program)` therefore typechecks at any `R` whatsoever. There is no
"you forgot to provide this" error, at any call site, ever.

This is a general hole, not a one-off: **any** domain layer that resolves a
service `makeAppLayer` does not provide ships exactly the same way — clean
`tsc`, green suite, dead on the runner. It has fired once, at v4.6.0
(`PackageJsonFile`, above), and the failure is maximally unhelpful: a defect,
~30ms in, before the check run is created, so there is no check run in the
GitHub UI and the message names a service rather than a wiring site.

**The guard** (`__test__/unit/layers/app.test.ts`): a type-level assertion that
`Exclude<AppLayerRequirements, ActionServices>` is `never`, where
`AppLayerRequirements` is read off `ReturnType<typeof makeAppLayer>`. The teeth
are the type annotation; the runtime `expect` only proves the module was
evaluated, and the file says so about itself. Tests are inside the tsc project
(`__test__/**/*.ts` is in the resolved `include`), so it blocks at pre-commit and
in CI, not merely in a test run.

**Mutation-verified in both directions,** which is the standard this record
holds a guard to: reinstating the bug produces
`error TS2322: Type 'boolean' is not assignable to type 'PackageJsonFile'` —
naming the missing service — and with the fix in place `tsc --noEmit` is clean.

**What would falsify it / make it stop discriminating** — three things, and all
three are silent:

1. **`ActionServices` widening upstream.** The guard subtracts whatever that
   alias currently names (today:
   `ActionEnvironment | ActionLogger | ActionOutputs | ActionState | NodeServices | HttpClient`).
   If the kit ever adds a service to it that `Action.run` does not actually
   construct, the guard subtracts a lie and passes.
2. **An `any`/`unknown` leaking into `makeAppLayer`'s inferred `In`.**
   `Exclude<any, …>` is `any`, and `[any] extends [never]` is false — but
   `Exclude<unknown, …>` is `unknown` and a stray `as` anywhere in the wiring can
   collapse the channel. The guard reads the *inferred* type; it cannot tell an
   honestly-empty channel from an erased one.
3. **A service resolved outside a layer body** — e.g. yielded inside a *method*
   rather than in `Layer.effect`. That leaves the requirement on the method, not
   on the layer, so it never reaches `makeAppLayer`'s channel at all. Every
   domain service here deliberately resolves its dependencies in the layer so
   each member's `R` is `never` (see @./06-effect-patterns.md); that convention
   is what makes this guard total, and abandoning it for one service silently
   reopens the hole for that service.

The runtime counterpart nobody has built: nothing currently *builds* the layer
graph in a test, so a service that is provided but whose own layer fails to
construct would still get through. The guard covers missing wiring, not broken
wiring.

### `@effected/git` — adopted for `status`, declined for the mutating tier (upstream #279)

**This entry previously read "not adopted", and that ruling was overturned in
part.** The verdict still holds for the seven mutating operations. It was wrong
about `status`, and *how* it was wrong is the durable lesson — so the original
argument is reproduced rather than quietly replaced.

**What the original ruling said.** `@effected/git` covers 2 of the 9 local git
operations `services/branch.ts` performs. Missing: `-c core.fileMode=false` on
`status`, an explicit-refspec `fetch` (load-bearing on a single-branch
`actions/checkout`, which otherwise never materializes `origin/<branch>`),
`fetch --unshallow`, `checkout -B`, `reset --hard`, `branch -f`, and
`rev-parse --is-shallow-repository`. Adopting for the covered two would leave two
subprocess mechanisms in one module while fixing nothing. On the config flag it
said: the `GIT_CONFIG_COUNT` / `KEY_n` / `VALUE_n` env route *does* reach the
child (`GitCommand` spawns with `extendEnv: true`, verified against a real repo),
but only process-globally — rejected on blast radius.

**Where it was wrong.** That argument treats *per-command* and *process-global*
as the only two scopes. There is a third: `git config core.fileMode false`
writes the **repository's own** config. It is scoped to the checkout, persists
for the job, and needs no per-command seam — so the flag was never the blocker
it was recorded as. The enumeration was complete about what the kit lacked and
incomplete about what git offers, which is a harder error to notice than a
factual one: every individual claim in it was true.

**What adoption bought.** `parseStatusLine` is deleted. `StatusEntry` models the
two porcelain columns separately and carries `origPath`, so the three defects
that had shipped in that parser — a dropped rename, an `AD`/`RD` deletion read as
a modification, and a copy deleting its own origin — become *unrepresentable*
rather than merely fixed. `-z` also removes git's path-quoting layer, retiring a
known octal-escape gap. Their tests survive, re-pointed at the commit payload.

**What it cost, stated because it is real.** Two subprocess mechanisms for git
now live in `services/branch.ts` — precisely the outcome the original ruling was
avoiding. Accepted deliberately: deleting a parser with three shipped silent
wrong answers outweighs mechanism uniformity. And the config write applies to
every git command in that checkout for the rest of the job, including silk's
DepsRegen — benign, since a mode flip is not a dependency change and cannot
survive a content-based API commit regardless, but not nothing.

**What would change the remaining answer:** refspec support on `fetch`,
`-B`/force on `checkout`, `reset`, `--unshallow`, `branch -f`, and the boolean
`rev-parse` queries. A per-command config override is **no longer on that list**.

### `@effected/npm`'s pin vocabulary — adopted for the hash AND the parse (#290)

Two helpers retired onto `@effected/npm@0.11.0` in one pass, because they are
two halves of the same grammar and splitting the swap would have left the module
parsing a pin with a regex while formatting one with the kit.

- **`CorepackIntegrityHash.fromSri`** replaced `utils/pnpm.ts`'
  `corepackHashFromIntegrity` — a swap this repo's copy motivated upstream
  (effected#281 cites it as consumer evidence). **Not a like-for-like port, and
  the difference is the reason to want it:** the local version base64-decoded
  whatever followed `sha512-` and emitted the hex, so non-canonical base64 and a
  wrong-length digest both minted a pin that looks well-formed and that corepack
  rejects **at install time, in the consumer's repository, after this action
  reported success**. Both fail typed now and take the bare-version path an
  absent integrity already took.
- **`PackageManagerPin.parseResult`** replaced the module-private
  `parsePmVersion`. Its version check was `/^\d+\.\d+\.\d+/` against the tail —
  a *prefix* match — so `pnpm@11.12.0garbage` parsed as a reference and the
  synthesized `^11.12.0garbage` range then reported **`unsatisfiable`**, this
  service's diagnosis for "the range names a different package manager". A
  malformed pin now reports `no-reference`, which is what happened.

**What was NOT adopted, and why the line is there.** The **write** still
interpolates `` `${pm}@${resolved}${suffix}` `` rather than constructing a
`PackageManagerPin` and calling `.toString()`. `resolved` comes from
`resolveLatestSatisfying` over the registry's own version list and the integrity
is now a validated `CorepackIntegrityHash`, so both components are already
checked; round-tripping through a `SemVer` decode to re-derive a string this
module can concatenate correctly would buy nothing. *What would change the
answer:* a second write format, or a caller that needs to compare pins rather
than emit one.

**One local concession, deliberately kept:** a leading `^`/`~` is stripped from
`devEngines.packageManager.version` before parsing. `PackageManagerPin` rejects
a range, correctly — a corepack pin is exact by definition — but
`devEngines.packageManager.version` is *specified* to accept one and repos write
`^11.0.0` there. Adopting the pin grammar unconditionally would have reported
"no reference" and silently stopped upgrading a manager the repo plainly
declares, which is precisely the class of quiet wrong answer this record keeps
cataloguing. Pinned by a test.

**Mutation-verified**, since two of the four new tests assert on behaviour that
*changed* rather than behaviour that is merely present: restoring each old
helper turns exactly those two red, with
`expected 'pnpm@11.13.0+sha512.deadbeef' to be 'pnpm@11.13.0'` and
`expected 'unsatisfiable' to be 'no-reference'`. The other two (a sha256
integrity, a `devEngines` caret) pass against both implementations and are
labelled in the suite as the controls they are.

### The DCO sign-off comes from the token, not a literal

`Report` used a local `signoffLine(appSlug?)`. **The slug branch had no
production caller** — `steps/commit-and-pr.ts` calls `generateCommitMessage`
with updates only — so it was reachable from the test suite and nowhere else,
and every real run signed as `github-actions[bot]` while the commit it signed
was authored by the installation's own App bot. Nothing failed: the trailer is
well-formed, DCO checks pass, and the only symptom is a commit whose author and
sign-off name two different identities, in a consumer's repository, on a run
already reported as successful.

It is now `utils/commit-signoff.ts`' `resolveSignoff()` over
`GitHubToken.botIdentity()` + `BotIdentity.signoff`, resolved **once in
`Report.layer`'s body** and closed over by both renderings — the same module,
name and shape as `silk-release-action`'s, deliberately, since both actions
commit through the Git Data API and therefore both have to supply a trailer no
porcelain adds.

**The interesting part is what it cost in the test doubles.**
`__test__/utils/action-doubles.ts` answered a missing `ActionState` key with
`Effect.die`, while the real `ActionState.get` fails **typed** with
`reason: "missing"` — which is why `getOptional` exists beside it. A defect is
uncatchable, so `resolveSignoff` — whose declared error channel is `never`
*because* it catches that failure — read as broken under the double while being
correct against the real store. **A double stricter than the thing it stands in
for does not catch bugs, it invents them**, and the standing temptation is then
to weaken the production code until the fake is satisfied. The double now models
the contract, pinned by `__test__/unit/doubles.test.ts` with an `Effect.flip`
assertion (a defect would still reject, so the assertion discriminates between
"failed typed" and "died").

*What would change the answer:* a need to sign as a different identity than the
committer — at which point the policy, not the rendering, is what moves.

### `@effected/github-references` — no call site here, and that is the finding

Considered as part of the same wave and **not adopted, because there is nothing
to adopt it for.** The package is a *reference-parsing* grammar — harvest
`Closes #N` from prose, read a bare-line or comma-separated closing list — and
this action neither reads nor writes issue references: `ManagedPrBody.build` is
called with `linkedIssues: []`, and a dependency-update run closes nothing.
`git grep` for the shape returns one unrelated hit (the word "closes" in a doc
comment).

It arrives **transitively** twice over, which is the right amount of adoption
here: `@savvy-web/silk-effects@6.0.0` backs `PrBody.ClosingReferences.parseBare`
with it, and `@effected/github@0.7.0` moved the grammar into it and re-exports
the six original names for compatibility. That re-export is documented upstream
as droppable at a later bump — so **if a call site ever appears, import
`@effected/github-references` directly**, not through `@effected/github`, whose
version of the surface deliberately omits the newer closing-list dialect.

*What would change the answer:* this action learning to close an issue — an
`upgrade-package-manager` run that resolves a tracked dependency ticket is the
plausible one — at which point `collectReferenceLists` is the entry point, and
`silk-release-action`'s `link-issues-from-commits.ts` is the worked example
(including why `collectReferenceLists` beats `harvestIssueReferences`: the
latter reads `Closes #247, #248 and #251` as **only** #247).

### `format.ts` and `services/report.ts` stay separate

Two rendering modules, split by sink: `format.ts` renders the **run's** log
output (pure, no services); `report.ts` renders the **PR's** body, summary and
commit message (a `Context.Service` over `PullRequest`). The
single-rendering-surface rule exists to stop rendering scattering through step
bodies — which it does not. Merging them would drag a service dependency into a
pure module or strand `Report`'s statics.

### `lockfile-snapshot` fail-open — argued, not acted on

There is a real argument that a lockfile snapshot is diagnostic (`git status` is
the run's actual change signal) and that `LockfileError` should degrade to
`null` rather than fail the run. It was **deliberately not applied**, because it
surfaced mid-restructure and a behavior change folded into a behavior-preserving
move is unreviewable. The argument is recorded in the step's module doc. It may
well be correct; it needs to land as its own decision.

### `@effected/workspaces` release-age discovery — adopted, with one known gap

`WorkspaceCatalogs.releaseAgeGate()` over `layerWithConfigDependenciesSubprocess`
replaced the discovery half of `release-age.ts` (304 → 179 lines). Blocked until
`0.10.0` because the in-process hook loader's computed dynamic `import()` is what
rspack miscompiles; the subprocess variant passes a static script via argv.

The **fail-open posture stayed ours** as an `Effect.catch` — the kit fails typed,
which is correct for a library and wrong for this action, since pnpm re-enforces
the gate at install.

**Known gap (upstream spencerbeggs/effected#292), measured not assumed:** the kit
frames its child's payload with
`Run.jsonLine`, which reads the **last non-empty stdout line**. A hook that
writes *after* the payload (`process.on("exit", …)`) therefore breaks the parse,
and our wrapper degrades it to no gate. A hook that logs *during* execution — the
ordinary case, and the one the shipped bug was about — survives. Evidence is a
controlled pair in `release-age.int.test.ts` differing only in *when* the hook
logs. The deleted local implementation handled both, because scanning from the
end for a sentinel beats last-line parsing exactly here.

**How this was nearly mis-filed:** the first reproduction used a hand-built
fixture and returned the inert gate — apparently damning. A **silent-hook control
on the same fixture** returned the inert gate too, proving the fixture was simply
wrong and the reproduction worthless. Only the repo's own fixture helper, where
the quiet and chatty cases differ in one line, is real evidence. A reproduction
without a control is an anecdote.

## How to read the claims in these documents

Several confident assertions in this record turned out to be false, and the
pattern is worth naming because it recurs:

- "The kit deliberately ships no `GithubMarkdown` successor" — asserted across
  **five design docs plus the module doc it lived in** — `01`, `02`, `05`, `07`,
  `09`, and `src/utils/github-markdown.ts`; never `CLAUDE.md`. It ships
  `GitHubMarkdown`; the rename was three characters. *Re-derive with*
  `git grep -in 'successor|consumer policy' 697bbab -- '*.md' 'src/**'`, then
  keep only the hits naming `GithubMarkdown` or "report shaping" — the same
  search also returns four hits for an unrelated and **true** claim, that the kit
  has no `ActionInputError` successor. Conflating the two is how this count was
  first miscorrected: a grep for "no successor" alone returns both, and a grep
  for the exact phrasing returns neither `01` nor `02`, which word it
  differently.
- "`Range.parse` is tree-shaken out of the bundled dist" — true once, fixed
  upstream, and left asserting a hazard that no longer existed.
- **"`@effected/package-json` was evaluated and DECLINED — do not re-propose
  it"** — the same shape, at the largest scale yet. Asserted in `01`, `05` and
  twice in `09` (a loose-end bullet *and* a settled-decisions entry), plus
  `CLAUDE.md`, complete with a four-row table of helpers that "therefore stay".
  Upstream then shipped **exactly the two things the ruling named as its own
  falsification condition** (`PackageManifest` and `modify`, in `0.9.0`); the
  package was adopted in `f55fab6` and wired into two services, and **every one
  of those claims was left standing.** The adoption's own changeset states the
  rationale in full, so the record was not missing — it was in a different file
  nobody reconciled against.
  - Note the precise verdict the correction had to make, because the obvious one
    is wrong: the ruling was **narrowed, not refuted.** Its central objection —
    `Package.decode` rejects the private workspace root — is still true and still
    operative, which is why only the decode-free `modify` was adopted. "This doc
    is stale" would have been the easy correction and would have thrown away the
    reasoning that is still load-bearing.
  - Two lessons, and the second is the load-bearing one. A ruling that names its
    falsification condition is doing the right thing, but **naming a condition
    creates no obligation for anyone to notice it was met** — the doc cannot
    watch upstream on your behalf. And a "do not re-propose" instruction is
    precisely the sentence that stops the next reader checking, which is the
    same defect as a false justification (below) wearing a stronger uniform.
  - *Re-derive with* `git log -S'@effected/package-json' -- package.json src/`,
    which lands on the adopting commit and its changesets — the durable habit is
    to check the **code** for a package a document says is unadopted, not the
    document.
- **A PARTIAL reconciliation is more dangerous than none, and this commit is the
  worked example.** `f55fab6` did not ignore the docs. It edited `08-testing.md`
  and `CLAUDE.md` in the same commit that made the change — and left standing, in
  `09`, the settled-decisions entry that the change directly contradicted, plus
  the supporting claims in `01` and `05`. The freshly-touched neighbours are
  exactly what made the untouched ones look current: a reader who checks *whether
  the docs were updated for this change* gets "yes".
  - The same commit also moved this file's test count 580 → **581** when the tree
    it shipped stood at **588** (see @./08-testing.md). So the reconciliation was
    not merely partial across files, it was wrong within the file it did touch —
    and being touched is what lent the number credibility.
  - **Make it checkable rather than resolving to be careful.** The question is
    not "were the docs updated" but "were *these* docs updated": for a change
    that touches a package or a decision, `git log --stat <commit>` against
    `git grep -l '<the package or claim>' -- '.claude/design/**'` names every
    document that mentions it, and the difference between those two lists is the
    unreconciled set. Both times this failed here, that difference was non-empty
    and nobody computed it.
- The raw-`node:` enumeration claimed 14 modules, listed 12, and the true count
  was 13 — the number, the list, and each other all disagreed. **It has since
  drifted again in the other direction:** the loose-end bullet's list still names
  `format.ts`, which no longer imports `node:` at all (its own module doc records
  the removal). `grep -rl 'from "node:' src/` returns 13 files today. Corrected
  in place above; noted here because the enumeration has now been wrong twice,
  which suggests recounting rather than editing it next time.
- **A control proves the wrong half.** Three tests were written for the peer-glob
  rejection, one of them deliberately a control — and all three asserted only
  `Exit.isFailure`, which the bug they were meant to catch *also* satisfies (it
  failed, naming the wrong input). The control established that a valid scoped
  name is still accepted, which was true and beside the point. **A control makes
  a test non-vacuous about the property it controls for; it does not make the
  test non-vacuous generally.** Having written one is not evidence the assertion
  discriminates.
- **The mutant has to be aimed at the assertion, not the code.** Three defects
  shipped in one review round, two of them tests that could not fail, and all
  three from the same habit: running a mutant against the *code* that changed and
  not against the *new assertion*. The glob case is the clean illustration — the
  fix was correct, the test was decoration, and only a mutant aimed at the
  assertion could have shown it. Applying that rule in the next round caught a
  gap nobody had listed.
- **A false justification is worse than none**, because it stops the next reader
  checking. A test carried the comment "the double would die if `upgrade` were
  called"; the double was a plain `Layer.succeed` and would have answered
  happily. The comment is why nobody re-examined an assertion that could not
  fail.
- "`-c core.fileMode=false` cannot be scoped" — the ruling that kept
  `@effected/git` out for a release. **Every individual claim in it was true**,
  which is what made it hard to see: the kit really has no per-command config
  seam, and the `GIT_CONFIG_*` env route really is process-global. The argument
  failed by *enumerating two options and treating the list as exhaustive*.
  Repository config is a third scope, and it is the ordinary one. A complete
  survey of what a dependency lacks is not a survey of what is possible — when a
  decision rests on "the only ways to do X are A and B", the load-bearing part is
  the word *only*, and it is the part no amount of checking A and B will verify.

Each read as evidence and was an author's account of a property. **Where a
document here asserts that something is load-bearing, it should say what would
falsify the claim, or say plainly that it is unverified.** "We believe X, and
here is what would show us wrong" survives being wrong; a confident claim does
not. The concrete habit: *before trusting a green signal, ask what specific
change would have turned it red — if the answer is "nothing", the signal is
decoration.*

The companion habit, for when a signal is *not* green: **when a tool reports
something inconsistent with what you believe, the discrepancy is the finding —
investigate the tool, not just the symptom.** Three instances here. A typecheck
error on an import a `grep -rl` had said was clean was patched without asking
why the grep missed the file (it was unreadable — see the NUL note above). A
background notification described this repo's own outbound mail as *inbound*
from the counterpart, and the anomaly was explained away rather than read as the
direction error it was. A `Write` reporting success on a file that was later
absent was taken as an unreliable write path, when a concurrent actor had moved
it.

The scope of "tool" is the part that keeps getting drawn too small: a monitor
notification, a linter's path list and a success message are all tool output,
and each of the three above was misfiled as noise, configuration or a given.

**Next steps:**

1. Integration testing with a real GitHub App in CI.
2. Documentation: user guide and troubleshooting.
3. Support for additional changeset strategies beyond `patch`.

## Rationale

### Why Effect Instead of Plain TypeScript/Promises?

**Type-safe error handling:** Effect's type system makes errors explicit in
function signatures, and the compiler ensures you handle them.

**Error accumulation:** a GitHub Action should be resilient. If updating 10
dependencies and 2 fail, the run should continue with the other 8, report all
failures, and still create a PR with the successful updates. Effect makes this
easy with `Effect.all`, `Effect.result` and custom error types — and this codebase
leans on it heavily (per-dependency registry failures, per-runtime resolver
failures, auto-merge failures and PR failures all degrade rather than abort).

**Resource management:** the App token spans three processes and the check run must
close on every path. The token is provisioned in `pre` and revoked in `post` (which
always runs), and `CheckRun.withCheckRun` concludes on every exit path.

**Testing:** Effect programs are pure and composable. Services are mocked with
`Layer.succeed` or each service's `layerTest`, with no module-mocking framework.

### Why Effect-First Service Architecture?

`Context.Service` + `Layer` gives compile-time-verified dependency injection; each
service declares its dependencies in its layer and the compiler ensures they are
satisfied. Adding a service means defining its tag, implementing its layer, and
adding it to `makeAppLayer`.

### Why the `@effected` kit instead of one library?

The all-in-one `@savvy-web/github-action-effects` bundled unrelated concerns —
Actions runtime, GitHub API, npm registry, subprocess execution, Markdown — behind
one dependency, so any consumer of one part paid for all of them (including the
transitive cyclonedx tree this action had to teach its bundler to ignore).
Splitting into focused kit packages made each surface independently versionable
and let the shapes improve: one `GitHubError` instead of per-service error classes,
`upsert` instead of exists/delete/create, `Run` free functions instead of a
`CommandRunner` service, `ActionInput` accessors that actually know the runner's
`INPUT_*` mangling, and `GithubMarkdown` → `GitHubMarkdown` (capital H), which is
a rename rather than a removal. This repo spent a release believing the kit
shipped no markdown writer and hand-rolled one; only `bold` and `rule` genuinely
have no kit equivalent.

### Why Three-Phase (Pre/Main/Post)?

- **Idiomatic client construction.** `GitHubToken.clientLayer()` reads the envelope
  `pre` persisted, so there is no bare client layer and no
  `process.env.GITHUB_TOKEN` bridge.
- **Revokes the token even when `main` fails.** `post` always runs (guarded so it
  never fails the workflow). Tokens also expire after 1 hour regardless.
- **Fails fast on missing scopes.** `pre` passes the `required` permissions to
  `provision`, so a misconfigured App fails there rather than mid-run with a 403.

### Why a Dedicated Branch, Reset Each Run?

Always starting from a clean state is simpler than rebasing, needs no conflict
resolution, and is appropriate because the branch only contains automated updates.
`GitBranch.upsert` performs the reset atomically from the caller's perspective,
which the previous delete-then-create sequence did not.

### Why Changesets Integration?

Changesets is the de facto standard for versioning in pnpm monorepos: automatic
changelog generation, semantic versioning enforcement, release automation
compatibility. The dependency-changeset step is delegated to
`@savvy-web/silk-effects`' `DepsRegen` so the gating rules live in one place and
this action does not re-implement them.

### Why GitHub App Instead of PAT?

Tokens expire in 1 hour, permissions are fine-grained, commits are verified via the
Git Data API without SSH/GPG keys, and it matches how GitHub's own bots behave.

## Related Documentation

**External references:**

- [pnpm Config Dependencies](https://pnpm.io/config-dependencies)
- [bun catalogs](https://bun.sh/docs/install/catalogs)
- [GitHub Apps Authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app)
- [Changesets Documentation](https://github.com/changesets/changesets)
- [Effect Documentation](https://effect.website)
