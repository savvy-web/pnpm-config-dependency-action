# silk-update-action

## 4.8.7

### Dependencies

* | Dependency           | Type       | Action  | From    | To      |                                                                              |
  | -------------------- | ---------- | ------- | ------- | ------- | ---------------------------------------------------------------------------- |
  | @effected/workspaces | dependency | updated | ^0.17.0 | ^0.17.1 | [#321][#321] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#321]: https://github.com/savvy-web/silk-update-action/pull/321

## 4.8.6

### Dependencies

* | Dependency              | Type       | Action  | From   | To     |                                                                              |
  | ----------------------- | ---------- | ------- | ------ | ------ | ---------------------------------------------------------------------------- |
  | @savvy-web/silk-effects | dependency | updated | ^6.0.4 | ^6.0.5 | [#314][#314] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#314]: https://github.com/savvy-web/silk-update-action/pull/314

## 4.8.5

### Dependencies

* | Dependency          | Type       | Action  | From   | To     |                                                                              |
  | ------------------- | ---------- | ------- | ------ | ------ | ---------------------------------------------------------------------------- |
  | @effected/lockfiles | dependency | updated | ^0.6.1 | ^0.6.2 | [#311][#311] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#311]: https://github.com/savvy-web/silk-update-action/pull/311

## 4.8.4

### Bug Fixes

* `check-peers` no longer withholds auto-merge on repositories whose lockfile carries npm-aliased dependency edges (e.g. `foo: npm:bar@^1.0.0`) or `publishDirectory` workspace links. Both edge shapes were previously misclassified as unresolved, so the peer-check gate reported `unverified (unresolvedEdge)` and disabled auto-merge even when peer dependencies were actually satisfied. These lockfiles now gate as proven-clean.

  `check-peers` also no longer judges the post-update lockfile against pre-update peer suppression rules. The gate now refreshes the workspace catalog assembly before reading `peerDependencyRules`, so a run that bumps a config-dependency plugin reads the rules the freshly-installed plugin actually ships, rather than the rules in effect before this run started. Previously a plugin bump that newly allowed a peer mismatch could still report it as `required` and withhold auto-merge. [#308][#308]

### Patch Changes

Thanks to [@spencerbeggs](https://github.com/spencerbeggs) for their contributions!

[#308]: https://github.com/savvy-web/silk-update-action/pull/308

## 4.8.3

### Dependencies

* | Dependency         | Type       | Action  | From   | To     |                                                                              |
  | ------------------ | ---------- | ------- | ------ | ------ | ---------------------------------------------------------------------------- |
  | @effected/runtimes | dependency | updated | ^0.4.2 | ^0.4.3 | [#306][#306] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#306]: https://github.com/savvy-web/silk-update-action/pull/306

## 4.8.2

### Dependencies

* | Dependency              | Type       | Action  | From    | To      |                                                                              |
  | ----------------------- | ---------- | ------- | ------- | ------- | ---------------------------------------------------------------------------- |
  | @effected/npm           | dependency | updated | ^0.11.0 | ^0.11.1 |                                                                              |
  | @effected/runtimes      | dependency | updated | ^0.4.1  | ^0.4.2  |                                                                              |
  | @effected/workspaces    | dependency | updated | ^0.15.1 | ^0.16.0 |                                                                              |
  | @savvy-web/silk-effects | dependency | updated | ^6.0.3  | ^6.0.4  | [#303][#303] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#303]: https://github.com/savvy-web/silk-update-action/pull/303

## 4.8.1

### Dependencies

* | Dependency              | Type       | Action  | From   | To     |                                                                              |
  | ----------------------- | ---------- | ------- | ------ | ------ | ---------------------------------------------------------------------------- |
  | @savvy-web/silk-effects | dependency | updated | ^6.0.2 | ^6.0.3 | [#300][#300] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#300]: https://github.com/savvy-web/silk-update-action/pull/300

## 4.8.0

### Features

* ### `check-peers` reports unsatisfied peer dependencies and can withhold auto-merge

  A new `check-peers` input inspects the dependency graph this run is about to
  commit and reports any unsatisfied peer dependencies in the pull request body,
  the job summary and the structured `result` output.

  Values are `false` (do not run), `warn` (report only, never gate) and
  `no-auto-merge` (report, and skip the auto-merge request when a required peer is
  unsatisfied).

  Left unset, the default is derived from `auto-merge`: `no-auto-merge` when
  auto-merge is enabled, `false` when it is not. A repository that does not
  auto-merge therefore pays nothing — not even the config-dependency hook replay
  the check would otherwise run — while one that does is protected without opting
  in. An explicit value always wins, including an explicit `false`.

  Under `no-auto-merge` the pull request is still created and pushed exactly as
  before — auto-merge is a separate API call, and withholding it means that call is
  not made. A repository with a broken peer graph therefore gets a pull request it
  can review rather than a silent automatic merge, and needs no branch-protection
  configuration for the gate to take effect.

  Nothing is reported as withheld when auto-merge was never enabled.

  The check runs against the regenerated lockfile rather than `node_modules`, so it
  answers a question about the artifact the pull request actually carries.

  ### The `result` document is now `schemaVersion: 2`

  `RunResultDocument` gains a required `peerIssues` array, and its version field
  moves from `1` to `2`.

  The bump is not ceremonial. The generated JSON Schema lowers this document with
  `additionalProperties: false`, so a consumer validating a new run against a
  pinned copy of the v1 schema will reject it on the unrecognised field. Adding a
  field is breaking under a strict schema in a way it would not be under a
  permissive one, and `schemaVersion` exists to signal exactly that.

  The four scalar outputs — `pr-number`, `pr-url`, `updates-count`, `has-changes`
  — are unchanged. A consumer that parses `result` without validating it against a
  pinned schema, or that checks `schemaVersion` before reading, needs no change.

  ### Peer results appear in the job summary as well as the pull request

  The job summary renders the same peer table and withheld-gate note as the pull
  request body. It was previously omitted, so a maintainer reading only the summary
  saw a run that looked clean while the pull request reported unsatisfied peers.

  ### The peer report is treated as clean only when it is proven clean

  A report with no rows is not automatically a pass. Auto-merge is withheld unless
  the package manager's lockfile format is supported, every importer resolved, and
  the suppression policy was applied — because each of those, on its own, produces
  an empty result that means "not examined" rather than "nothing wrong".

  This matters because pnpm records resolution-affecting configuration in the
  lockfile and discards reporting-affecting configuration: `peerDependencyRules`
  appears nowhere in a lockfile, so a check reading the lockfile alone would report
  peers that pnpm deliberately suppresses. Those rules are read through
  `@effected/workspaces`, including rules injected by config-dependency plugins
  rather than declared in `pnpm-workspace.yaml`.

  Two limits are deliberate. Optional peers are reported but never gate. A pnpm
  workspace package's own peer declarations cannot be checked at all, because pnpm
  does not record them in the lockfile and `pnpm peers check` does not report them
  either. [#297][#297]

### Minor Changes

Thanks to [@spencerbeggs](https://github.com/spencerbeggs) for their contributions!

[#297]: https://github.com/savvy-web/silk-update-action/pull/297

## 4.7.1

### Dependencies

* | Dependency              | Type       | Action  | From   | To     |                                                                              |
  | ----------------------- | ---------- | ------- | ------ | ------ | ---------------------------------------------------------------------------- |
  | @savvy-web/silk-effects | dependency | updated | ^6.0.0 | ^6.0.1 | [#294][#294] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#294]: https://github.com/savvy-web/silk-update-action/pull/294

## 4.7.0

### Bug Fixes

* ### Commits are now signed off as the App bot that authored them

  The DCO `Signed-off-by` trailer on the commit this action creates — and the
  matching proposed-squash-commit fence in the pull request description — is now
  built from the GitHub App identity carried by the installation token, instead of
  always naming `github-actions[bot]`.

  The identity was already available; the code that used it had no caller. The
  trailer was rendered by a `signoffLine(appSlug?)` helper whose App-bot branch
  nothing ever passed, so every run signed as `github-actions[bot]` while the
  commit itself was authored by the installation's own bot. Nothing failed — the
  trailer is well-formed and DCO checks pass — the commit simply named two
  different identities as author and signer.

  Repositories using a GitHub App will see the trailer change from
  `github-actions[bot]` to `<your-app>[bot]` on the next run. Runs where the token
  cannot be read still fall back to the well-known `github-actions[bot]` identity,
  byte-identical to what was written before.

  ### A malformed registry integrity no longer produces a package-manager pin corepack rejects

  When upgrading a corepack-managed package manager (pnpm, npm), the
  `+sha512.<hex>` integrity written into `packageManager` and
  `devEngines.packageManager.version` is now derived by `@effected/npm`'s
  `CorepackIntegrityHash.fromSri`, which validates the registry's SRI hash before
  converting it.

  The previous conversion decoded whatever followed `sha512-` and emitted the hex,
  so non-canonical base64 or a digest of the wrong length produced a pin that
  looked well-formed and that corepack rejects at install time — surfacing in the
  consuming repository, on a run this action had already reported as successful.
  Those inputs now fall back to writing the bare version, the same path an absent
  integrity already took, with a warning.

  ### A malformed `packageManager` pin is reported as "no reference" rather than "unsatisfiable"

  Reading the `packageManager` and `devEngines.packageManager` fields now goes
  through `@effected/npm`'s `PackageManagerPin` grammar. The previous check tested
  `/^\d+\.\d+\.\d+/` against the version tail, which matched a *prefix* — so
  `pnpm@11.12.0garbage` was accepted as a reference and the run then reported
  "no pnpm release satisfies the range", which is this action's diagnosis for a
  range typed for the wrong package manager. It now reports that there is no usable
  reference, which is what actually happened.

  A range in `devEngines.packageManager.version` (`^11.0.0`) is still accepted and
  still anchors an `auto` upgrade — `devEngines` is specified to carry one, even
  though a corepack pin never can.

### Refactoring

* `corepackHashFromIntegrity` removed from `src/utils/pnpm.ts`, which now exports
  `detectIndent` alone. The kit shipped the conversion this repository's copy
  motivated upstream.
* `resolveSignoff()` added at `src/utils/commit-signoff.ts`, matching
  `silk-release-action`'s module of the same name — both actions commit through
  the Git Data API, so both must supply a trailer no porcelain adds. `Report`
  resolves it once when its layer is built.

### Tests

* Four cases pinning the package-manager pin and integrity behaviour above, two
  of which are verified to fail against the previous implementations.
* Five cases over `resolveSignoff`, covering both fallback depths.
* The in-memory `ActionState` double now **fails typed** on a missing key rather
  than dying, matching the real store. A defect is uncatchable, so code whose
  contract is to degrade when nothing was persisted read as broken under the
  double while being correct in production.

### Dependencies

* | Dependency               | Type          | Action  | From    | To      |
  | :----------------------- | :------------ | :------ | :------ | :------ |
  | @effected/npm            | dependency    | updated | ^0.10.0 | ^0.11.0 |
  | @effected/github         | dependency    | updated | ^0.6.0  | ^0.7.0  |
  | @effected/github-actions | dependency    | updated | ^0.9.0  | ^0.9.1  |
  | @effected/lockfiles      | dependency    | updated | ^0.5.0  | ^0.5.1  |
  | @effected/package-json   | dependency    | updated | ^0.10.0 | ^0.10.2 |
  | @effected/workspaces     | dependency    | updated | ^0.14.0 | ^0.14.2 |
  | @savvy-web/silk-effects  | dependency    | updated | ^5.9.2  | ^6.0.0  |
  | @savvy-web/silk          | devDependency | updated | ^3.7.9  | ^3.7.11 |

  `@effected/github` had to move because `@effected/github-actions@0.9.1` depends
  on it and the lockfile still held `0.6.0`, whose `GitHubClient` embeds
  `@octokit/types@16`. `0.6.1` moved to `@octokit/types@17`, so at `0.6.0` the
  `GitHubClient` that `GitHubToken.clientLayer()` produced no longer matched the
  one the resource layers required, and the build failed. Two copies of
  `@effected/github` are not themselves a problem — a copy at `0.6.1` alongside
  `github-actions`' `0.7.0` typechecks — but this repository keeps one copy of
  each kit package regardless, so the range moved to `^0.7.0`.

  `@savvy-web/silk-effects@6.0.0` brings `@effected/github-references` in
  transitively, which now backs its closing-reference parsing; this action has no
  direct call site for that grammar. [#291][#291]

### Minor Changes

Thanks to [@spencerbeggs](https://github.com/spencerbeggs) for their contributions!

[#291]: https://github.com/savvy-web/silk-update-action/pull/291

## 4.6.4

### Dependencies

* | Dependency               | Type       | Action  | From   | To     |                                                                              |
  | ------------------------ | ---------- | ------- | ------ | ------ | ---------------------------------------------------------------------------- |
  | @effected/github         | dependency | updated | ^0.5.0 | ^0.6.0 |                                                                              |
  | @effected/github-actions | dependency | updated | ^0.8.0 | ^0.9.0 | [#288][#288] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#288]: https://github.com/savvy-web/silk-update-action/pull/288

## 4.6.3

### Dependencies

* | Dependency               | Type       | Action  | From           | To           |                                                                              |
  | ------------------------ | ---------- | ------- | -------------- | ------------ | ---------------------------------------------------------------------------- |
  | @effect/platform-node    | dependency | updated | 4.0.0-beta.107 | 4.0.0-rc.109 |                                                                              |
  | @effected/commands       | dependency | updated | ^0.4.0         | ^0.5.0       |                                                                              |
  | @effected/git            | dependency | updated | ^0.8.0         | ^0.9.0       |                                                                              |
  | @effected/github         | dependency | updated | ^0.4.3         | ^0.5.0       |                                                                              |
  | @effected/github-actions | dependency | updated | ^0.7.0         | ^0.8.0       |                                                                              |
  | @effected/lockfiles      | dependency | updated | ^0.4.2         | ^0.5.0       |                                                                              |
  | @effected/npm            | dependency | updated | ^0.9.0         | ^0.10.0      |                                                                              |
  | @effected/package-json   | dependency | updated | ^0.9.0         | ^0.10.0      |                                                                              |
  | @effected/runtimes       | dependency | updated | ^0.3.0         | ^0.4.0       |                                                                              |
  | @effected/semver         | dependency | updated | ^0.4.0         | ^0.5.0       |                                                                              |
  | @effected/workspaces     | dependency | updated | ^0.13.1        | ^0.14.0      |                                                                              |
  | @effected/yaml           | dependency | updated | ^0.9.0         | ^0.10.0      |                                                                              |
  | @savvy-web/silk-effects  | dependency | updated | ^5.9.1         | ^5.9.2       |                                                                              |
  | effect                   | dependency | updated | 4.0.0-beta.107 | 4.0.0-rc.109 | [#285][#285] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#285]: https://github.com/savvy-web/silk-update-action/pull/285

## 4.6.2

### Dependencies

* | Dependency              | Type       | Action  | From    | To      |                                                                              |
  | ----------------------- | ---------- | ------- | ------- | ------- | ---------------------------------------------------------------------------- |
  | @effected/lockfiles     | dependency | updated | ^0.4.1  | ^0.4.2  |                                                                              |
  | @effected/workspaces    | dependency | updated | ^0.13.0 | ^0.13.1 |                                                                              |
  | @effected/yaml          | dependency | updated | ^0.8.0  | ^0.9.0  |                                                                              |
  | @savvy-web/silk-effects | dependency | updated | ^5.9.0  | ^5.9.1  | [#282][#282] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#282]: https://github.com/savvy-web/silk-update-action/pull/282

## 4.6.1

### Bug Fixes

* Fixes a startup failure introduced in 4.6.0 that failed **every run, in every
  consumer repository**, immediately in the main phase — before the check run
  was even created, so the GitHub UI showed nothing useful beyond a red job:

  ```text
  Service not found: @effected/package-json/PackageJsonFile
  ```

  The application layer provided the `PackageJsonFile` service to only one of
  the two consumers that needed it, so the service graph failed to build and
  the run died as an unhandled defect roughly 30ms in. If you're tracking the
  `@v4` alias tag, taking this release fixes it automatically; if you're pinned
  to `4.6.0` exactly, upgrade to pick up the fix.

  * Adds a compile-time guard that fails the build if the application layer is
    ever again composed with a service it doesn't provide, naming the missing
    service directly in the error. [#277][#277]

### Patch Changes

Thanks to [@spencerbeggs](https://github.com/spencerbeggs) for their contributions!

[#277]: https://github.com/savvy-web/silk-update-action/pull/277

## 4.6.0

### Features

* Every local git operation now runs through `@effected/git`, including the explicit-refspec fetch that a single-branch `actions/checkout` requires. The action no longer runs two subprocess mechanisms for git.

- The pull request description is now written through the shared `silk-release` managed-region contract. Everything the action generates lives between the managed markers and is regenerated each run; **anything you write outside those markers survives**. Previously the whole description was overwritten on every run, so a review note added to the PR body was silently destroyed by the next dependency update.

### Bug Fixes

* Branch management and the post-commit working-tree sync now run at the detected workspace root. They previously ran wherever the action's process happened to be, so invoking the action from a subdirectory could resolve them against unintended repository state.
* The package-manager evidence reported in the run-context log is now the detector's own answer rather than a local re-derivation. The re-derivation could not reproduce the detector's conjunction rules, so a workspace carrying a stray lockfile could be told a confident wrong reason for a decision that was itself correct.

- The DCO signoff in the proposed squash-commit block and the one in the commit message are now rendered from a single function, so the two cannot drift apart and name different authors for the same eventual commit. [#274][#274]

* Runtime and package-manager version bumps are now written as surgical edits to `package.json` instead of re-serializing the whole file. Key order, indentation and line endings are preserved byte-for-byte, so the diff this action opens against your repository shows only the field it actually changed. Previously the manifest was rewritten from the parsed object with a guessed indent, which could reformat regions the run never intended to touch.
* A write is skipped entirely when the result would be byte-identical to what was read.

- The pull request description is now written through the shared `silk-release` managed-region contract. Everything the action generates lives between the managed markers and is regenerated each run; **anything you write outside those markers survives**. Previously the whole description was overwritten on every run, so a review note added to the PR body was silently destroyed by the next dependency update.

### Dependencies

* | Dependency               | Type          | Action  | From   | To     |
  | :----------------------- | :------------ | :------ | :----- | :----- |
  | @effected/workspaces     | dependency    | updated | 0.12.0 | 0.13.0 |
  | @effected/git            | dependency    | updated | 0.7.0  | 0.8.0  |
  | @effected/github         | dependency    | updated | 0.4.1  | 0.4.2  |
  | @effected/github-actions | dependency    | updated | 0.6.1  | 0.7.0  |
  | @savvy-web/silk-effects  | dependency    | updated | 5.7.1  | 5.8.1  |
  | @savvy-web/silk          | devDependency | updated | 3.7.1  | 3.7.4  |

  These move together deliberately. Each is a `0.x` package whose caret range pins the minor, so bumping one alone leaves `@savvy-web/silk-effects` on the previous minor and resolves two copies into the bundle — and two copies are two distinct `Context.Service` tags, which surfaces as a service reading unprovided in a graph that visibly provides it.

- | Dependency             | Type       | Action | From | To    |
  | :--------------------- | :--------- | :----- | :--- | :---- |
  | @effected/package-json | dependency | added  | —    | 0.9.0 |

  Adopted for `PackageJsonFile.modify` only, which is decode-free: it reads, applies each field edit through the JSONC engine, and writes. The schema-decoding read path is deliberately **not** used, because it rejects manifests this action must still be able to edit — a private workspace root with no `name`/`version`, and a non-semver `version` such as `"1.0"`, are both legal in a package nobody publishes. [#274][#274]

* | Dependency              | Type       | Action  | From   | To     |                                                                              |
  | ----------------------- | ---------- | ------- | ------ | ------ | ---------------------------------------------------------------------------- |
  | @effected/github        | dependency | updated | ^0.4.2 | ^0.4.3 |                                                                              |
  | @savvy-web/silk-effects | dependency | updated | ^5.8.1 | ^5.9.0 | [#274][#274] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

Thanks to [@savvy-web-bot](https://github.com/apps/savvy-web-bot) for their contributions!

[#274]: https://github.com/savvy-web/silk-update-action/pull/274

## 4.5.4

### Dependencies

* | Dependency              | Type       | Action  | From    | To      |                                                                              |
  | ----------------------- | ---------- | ------- | ------- | ------- | ---------------------------------------------------------------------------- |
  | @effected/workspaces    | dependency | updated | ^0.11.2 | ^0.12.0 |                                                                              |
  | @savvy-web/silk-effects | dependency | updated | ^5.7.0  | ^5.7.1  | [#263][#263] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#263]: https://github.com/savvy-web/silk-update-action/pull/263

## 4.5.3

### Dependencies

* | Dependency               | Type       | Action  | From   | To     |                                                                              |
  | ------------------------ | ---------- | ------- | ------ | ------ | ---------------------------------------------------------------------------- |
  | @effected/github         | dependency | updated | ^0.3.0 | ^0.4.1 |                                                                              |
  | @effected/github-actions | dependency | updated | ^0.6.0 | ^0.6.1 | [#260][#260] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#260]: https://github.com/savvy-web/silk-update-action/pull/260

## 4.5.2

### Dependencies

* | Dependency              | Type       | Action  | From    | To      |                                                                              |
  | ----------------------- | ---------- | ------- | ------- | ------- | ---------------------------------------------------------------------------- |
  | @effected/lockfiles     | dependency | updated | ^0.4.0  | ^0.4.1  |                                                                              |
  | @effected/workspaces    | dependency | updated | ^0.11.1 | ^0.11.2 |                                                                              |
  | @effected/yaml          | dependency | updated | ^0.7.0  | ^0.8.0  |                                                                              |
  | @savvy-web/silk-effects | dependency | updated | ^5.6.0  | ^5.7.0  | [#257][#257] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#257]: https://github.com/savvy-web/silk-update-action/pull/257

## 4.5.1

### Dependencies

* | Dependency              | Type       | Action  | From   | To     |                                                                                                       |
  | ----------------------- | ---------- | ------- | ------ | ------ | ----------------------------------------------------------------------------------------------------- |
  | @savvy-web/silk-effects | dependency | updated | ^5.5.2 | ^5.6.0 | Thanks [@savvy-web-bot\[bot\]](\[@savvy-web-bot\[bot]]\(https://github.com/savvy-web-bot%5Bbot%5D\))! |

## 4.5.0

### Documentation

* `docs/schema/run-result.schema.json` gains a `$defs/DependencyType` definition,
  and the `type` field of `DependencyUpdateResult` and `LockfileChange` now
  `$ref`s it instead of repeating the enum inline. The constraint each field
  imposes is unchanged, so validation of an existing `result` document is
  unaffected. [#250][#250]

### Refactoring

* Error classes in `src/errors/errors.ts` now extend `Schema.TaggedError`, which
  `effect@4.0.0-beta.107` renamed back from `Schema.TaggedErrorClass`. The curried
  shape is identical, so the four declarations are the only source change; the
  action's runtime behavior is unchanged.
* `DependencyType` now carries an explicit `identifier` annotation. The beta.107
  JSON Schema lowering hoists a sub-schema used in more than one place into
  `$defs` rather than inlining it at each use site, and names it positionally when
  there is no identifier to use.

### Dependencies

* | Dependency                       | Type          | Action  | From           | To             |
  | :------------------------------- | :------------ | :------ | :------------- | :------------- |
  | effect                           | dependency    | updated | 4.0.0-beta.101 | 4.0.0-beta.107 |
  | @effect/platform-node            | dependency    | updated | 4.0.0-beta.101 | 4.0.0-beta.107 |
  | @effected/commands               | dependency    | updated | ^0.3.0         | ^0.4.0         |
  | @effected/git                    | dependency    | updated | ^0.5.2         | ^0.7.0         |
  | @effected/github                 | dependency    | updated | ^0.2.3         | ^0.3.0         |
  | @effected/github-actions         | dependency    | updated | ^0.5.1         | ^0.6.0         |
  | @effected/lockfiles              | dependency    | updated | ^0.3.2         | ^0.4.0         |
  | @effected/npm                    | dependency    | updated | ^0.8.3         | ^0.9.0         |
  | @effected/runtimes               | dependency    | updated | ^0.2.5         | ^0.3.0         |
  | @effected/semver                 | dependency    | updated | ^0.3.2         | ^0.4.0         |
  | @effected/workspaces             | dependency    | updated | ^0.10.0        | ^0.11.1        |
  | @effected/yaml                   | dependency    | updated | ^0.6.1         | ^0.7.0         |
  | @savvy-web/silk-effects          | dependency    | updated | ^5.3.0         | ^5.5.2         |
  | @effect/vitest                   | devDependency | updated | 4.0.0-beta.101 | catalog:effect |
  | @effected/schemastore            | devDependency | updated | 0.2.1          | ^0.3.0         |
  | @savvy-web/github-action-builder | devDependency | updated | ^2.2.2         | ^2.2.3         |
  | @savvy-web/silk                  | devDependency | updated | ^3.4.0         | ^3.5.2         |
  | @vitest-agent/plugin             | devDependency | updated | ^2.0.13        | ^2.0.16        |
  | @effected/pnpm-plugin-effect     | config        | updated | 0.3.2          | 0.4.0          |
  | @effect/platform-node-shared     | dependency    | removed | 4.0.0-beta.101 | —              |

### Maintenance

* Adopts the `@effected` kit's coordinated `effect@4.0.0-beta.107` wave. The whole
  graph now resolves a single `effect` copy, which retires both the
  `@effect/platform-node-shared` override and the duplicate `@effected/workspaces`
  resolution that was previously bundled into `dist/main.js`.

  `@effect/vitest` moves from an exact literal to `catalog:effect` — the same
  catalog entry as `effect` itself — so the lockstep those two must keep is now
  maintained by the catalog rather than by a hand-bumped pin.

### Minor Changes

Thanks to [@spencerbeggs](https://github.com/spencerbeggs) for their contributions!

[#250]: https://github.com/savvy-web/silk-update-action/pull/250

## 4.4.0

### Features

* ### Structured `result` output

  The complete run is now published as a JSON document on a new `result` output, alongside the four existing outputs — which are unchanged.

  A consuming workflow reads it with `fromJSON()` **unconditionally**: on every exit path, including a failure before any work began, `result` is a valid document rather than an empty string.

  ```yaml
  - uses: savvy-web/silk-update-action@v4
    id: update
  - run: echo "${{ fromJSON(steps.update.outputs.result).updates.length }} update(s)"
  ```

  It carries the run's disposition (`hasChanges`, `dryRun`), its context (`packageManager`, `workspaceRoot`, `branch`, `targetBranch`) and five collections: `updates`, `catalogDeltas`, `lockfileChanges`, `changesets` and `pullRequest`. Arrays are empty rather than omitted, so a consumer can iterate without a presence check — an empty array still has no element `0`, so check `updates.length` before indexing. `pullRequest` and `packageManager` are `null` when genuinely absent rather than carrying a placeholder.

  A JSON Schema is published at `docs/schema/run-result.schema.json` and regenerated with `pnpm generate-schema`.

### Bug Fixes

* **None of these produced an error.** Each was a silent wrong answer — the action reported success while quietly doing less than it claimed, so no user could have known.

  ### Custom commands ran in the wrong directory

  Every command in the `run` input inherited the action's process directory rather
  than the detected workspace root. When the action is invoked from a
  subdirectory those are different trees, so a configured `pnpm test` or
  `pnpm build` linted, tested or built something other than what the run had just
  edited — and passed, reporting green about the wrong tree.

  ### Glob patterns in `peer-lock` / `peer-minor` silently did nothing

  `dependencies` entries are globs; peer entries are matched as exact package
  names. A `@scope/*` in `peer-lock` therefore matched nothing, no peer range was
  synced, and the run reported success. Those inputs now fail with an error naming
  the offending entries **and the input they came from**.

  ### Files silently missing from commits

  * A **renamed** file never reached the commit at all. The status parser read `R old.ts -> new.ts` as a single path, failed to read it, and dropped the change with a warning. Renames are now committed as a delete of the old path plus content at the new one.
  * A **deletion whose index and worktree status disagreed** (`AD`, `RD`) was treated as a modification, failed the same read, and was dropped the same way.
  * A **copy** is now distinguished from a rename, so its origin is no longer deleted along with it.

  ### Git commands running in the wrong directory

  When the action is invoked from a subdirectory of the workspace, two paths resolved against the process directory instead of the detected workspace root:

  * `commitChanges` resolved changed-file paths there, so files could be read from the wrong place or not at all.
  * `ensureBaseHistory` ran its merge-base probe and recovery fetches there, so the changeset diff could resolve against the wrong repository state.

  ### Release-age gate silently disabled by a hook that logged

  A config-dependency `pnpmfile` hook that wrote anything to stdout corrupted the parse of the replay child's output. Because that path fails open by design, the run continued with **no release-age gate at all** — after which the action could propose a version pnpm rejects at install with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`. That is precisely the failure the gate exists to prevent, produced by the gate's own error handling. The payload is now framed so hook output cannot corrupt it.

  ### Release-age gate: one narrow case now loses the gate

  Gate discovery moved to `@effected/workspaces`, whose replay reads its child's
  payload from the last line of stdout. A config-dependency `pnpmfile` hook that
  writes to stdout **after** that payload — cleanup logging from a
  `process.on("exit")` handler, for instance — now makes discovery fail, and the
  action falls back to running with no release-age gate (logged as a warning).

  A hook that logs during execution, which is the ordinary case, is unaffected.
  This is narrower than the bug fixed above but it is the same failure mode, so it
  is called out rather than left to be discovered: if your workspace uses a
  config dependency whose pnpmfile logs on exit, the gate will not apply and pnpm
  will enforce it at install instead.

  Tracked upstream as [spencerbeggs/effected#292](https://github.com/spencerbeggs/effected/issues/292).

  ### The `result` document described the wrong run on the non-success exits

  A run that ended at the no-changes exit, or because a custom command failed,
  published the *pre-run baseline* document — `packageManager: null`,
  `workspaceRoot: ""` — even though detection had already succeeded. It parsed,
  every field was present, and nothing in the log distinguished it from a run that
  genuinely never detected anything.

  The failed-command exit additionally reported an **empty update set** for work
  that had actually happened: a run that bumped three dependencies and then failed
  `pnpm test` left those bumps in the working tree while telling consumers it had
  changed nothing. Both exits now carry the run's real context *and* its completed
  updates, and `updates-count` matches, so the scalar and the document cannot
  disagree.

  `packageManager` is now `null` in exactly one case — a run that aborted before
  detecting a package manager at all. `docs/02-configuration.md` documents each
  exit's shape.

  ### Outputs missing on failure paths

  Every declared output is now published on every exit path. Previously a run that failed early set none of them, so a downstream `if: steps.x.outputs.has-changes == 'false'` compared against an empty string rather than `false`.

### Refactoring

* **The workspace root is now a required parameter on every service method and
  helper that takes one** — no `process.cwd()` default remains in the action.
  Four separate wrong-directory defects on this release entered through such a
  default, each one silent: the action can be invoked from a subdirectory, so the
  default reads a different tree, succeeds, and reports a confident wrong answer.
  Requiring the parameter makes any future instance a compile error. No behavior
  changes — every caller already passed a root.

* The `git status` reads behind the change verdict and the commit file list now
  go through `@effected/git`, which models the two porcelain columns separately.
  The local porcelain parser is deleted — the rename, `AD`/`RD` and copy defects
  above become unrepresentable rather than merely fixed. `core.fileMode=false` is
  written to the checkout's own git config once per run instead of being passed
  per command, so the two readers cannot drift apart.

* **Every domain service layer moved from an `XLive` constant to a `static layer`
  on its class**, matching the `@effected` kit's own convention:
  `BranchManager.layer`, `ReleaseAge.layer` (plus `ReleaseAge.layerNoop`),
  `Report.layer`, `Changesets.layer`, `ConfigDeps.layer`,
  `CatalogConfigDeps.layer`, `RegularDeps.layer`, `RuntimeUpgrade.layer`,
  `PackageManagerUpgrade.layer` and `Lockfile.layer`. None was part of a
  documented public API — the action ships as a bundle, not a library.

* `WorkspaceYamlLive` and its `WorkspaceYaml` tag were **deleted** rather than
  renamed: nothing outside their own test suite ever wired them. The standalone
  `formatWorkspaceYaml` / `readWorkspaceYaml` helpers are unchanged and are what
  the action actually calls. [#244][#244]

### Dependencies

* | Dependency            | Type          | Action  | From   | To      |
  | :-------------------- | :------------ | :------ | :----- | :------ |
  | @effected/schemastore | devDependency | added   | —      | 0.2.1   |
  | tsx                   | devDependency | added   | —      | ^4.23.5 |
  | @effected/workspaces  | dependency    | updated | ^0.9.5 | ^0.10.0 |
  | @effected/commands    | dependency    | updated | ^0.2.1 | ^0.3.0  |
  | @effected/npm         | dependency    | updated | ^0.8.2 | ^0.8.3  |
  | @effected/git         | dependency    | added   | —      | ^0.5.2  |

### Minor Changes

Thanks to [@spencerbeggs](https://github.com/spencerbeggs) for their contributions!

[#244]: https://github.com/savvy-web/silk-update-action/pull/244

## 4.3.3

### Dependencies

* | Dependency               | Type       | Action  | From   | To     |                                                                              |
  | ------------------------ | ---------- | ------- | ------ | ------ | ---------------------------------------------------------------------------- |
  | @effected/github         | dependency | updated | ^0.2.2 | ^0.2.3 |                                                                              |
  | @effected/github-actions | dependency | updated | ^0.4.1 | ^0.5.1 |                                                                              |
  | @effected/lockfiles      | dependency | updated | ^0.3.1 | ^0.3.2 |                                                                              |
  | @effected/npm            | dependency | updated | ^0.8.1 | ^0.8.2 |                                                                              |
  | @effected/runtimes       | dependency | updated | ^0.2.3 | ^0.2.5 |                                                                              |
  | @effected/semver         | dependency | updated | ^0.3.1 | ^0.3.2 |                                                                              |
  | @effected/workspaces     | dependency | updated | ^0.9.4 | ^0.9.5 |                                                                              |
  | @savvy-web/silk-effects  | dependency | updated | ^5.2.0 | ^5.3.0 | [#242][#242] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#242]: https://github.com/savvy-web/silk-update-action/pull/242

## 4.3.2

### Dependencies

* | Dependency               | Type       | Action  | From   | To     |                                                                              |
  | ------------------------ | ---------- | ------- | ------ | ------ | ---------------------------------------------------------------------------- |
  | @effected/commands       | dependency | updated | ^0.2.0 | ^0.2.1 |                                                                              |
  | @effected/github         | dependency | updated | ^0.2.1 | ^0.2.2 |                                                                              |
  | @effected/github-actions | dependency | updated | ^0.4.0 | ^0.4.1 |                                                                              |
  | @effected/lockfiles      | dependency | updated | ^0.3.0 | ^0.3.1 |                                                                              |
  | @effected/npm            | dependency | updated | ^0.8.0 | ^0.8.1 |                                                                              |
  | @effected/runtimes       | dependency | updated | ^0.2.2 | ^0.2.3 |                                                                              |
  | @effected/semver         | dependency | updated | ^0.3.0 | ^0.3.1 |                                                                              |
  | @effected/workspaces     | dependency | updated | ^0.9.3 | ^0.9.4 |                                                                              |
  | @effected/yaml           | dependency | updated | ^0.6.0 | ^0.6.1 | [#236][#236] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#236]: https://github.com/savvy-web/silk-update-action/pull/236

## 4.3.1

### Tests

* Adds `headSha` and `baseSha` to the pull-request test doubles, which `@effected/github` 0.2.1 made required fields of `PullRequestInfo`
* Silences the Effect logger in the suites that do not assert on their own log output, so a test run no longer writes stray log lines to the console [#229][#229]

### Dependencies

* | Dependency                       | Type          | Action  | From    | To      |
  | :------------------------------- | :------------ | :------ | :------ | :------ |
  | @effected/commands               | dependency    | updated | ^0.1.0  | ^0.2.0  |
  | @effected/github                 | dependency    | updated | ^0.1.0  | ^0.2.1  |
  | @effected/github-actions         | dependency    | updated | ^0.1.0  | ^0.4.0  |
  | @effected/lockfiles              | dependency    | updated | ^0.2.1  | ^0.3.0  |
  | @effected/npm                    | dependency    | updated | ^0.5.0  | ^0.8.0  |
  | @effected/runtimes               | dependency    | updated | ^0.2.0  | ^0.2.2  |
  | @effected/semver                 | dependency    | updated | ^0.2.1  | ^0.3.0  |
  | @effected/workspaces             | dependency    | updated | ^0.9.0  | ^0.9.3  |
  | @savvy-web/silk-effects          | dependency    | updated | ^5.0.0  | ^5.2.0  |
  | @savvy-web/github-action-builder | devDependency | updated | ^2.1.0  | ^2.2.0  |
  | @savvy-web/silk                  | devDependency | updated | ^3.2.5  | ^3.3.0  |
  | @vitest-agent/plugin             | devDependency | updated | ^2.0.9  | ^2.0.11 |
  | pnpm                             | config        | updated | 11.17.0 | 11.19.0 |

### Maintenance

* Moves the `@effected` kit and `@savvy-web/silk-effects` to their current releases, with no action input, output or behavior changes
* Bumps the pinned pnpm version to 11.19.0 in `packageManager` and `devEngines.packageManager`

### Patch Changes

Thanks to [@spencerbeggs](https://github.com/spencerbeggs) for their contributions!

[#229]: https://github.com/savvy-web/silk-update-action/pull/229

## 4.3.0

### Bug Fixes

* ### `upgrade-package-manager` now defaults to `"false"`

  Leaving `upgrade-package-manager` unset used to imply `"true"` — the action would
  upgrade the detected package manager (pnpm/bun/npm) on every run. It now defaults
  to `"false"`, matching the opt-in behavior of the `upgrade-runtime-*` inputs.

  Workflows that relied on the implicit default must now set the input explicitly:

  ```yaml
  - uses: savvy-web/silk-update-action@v5
    with:
      upgrade-package-manager: "true" # or "auto", or an explicit semver range
  ```

  A workflow that configures no update type at all (no `config-dependencies`, no
  `dependencies`, no `upgrade-package-manager`, no `upgrade-runtime-*`) now fails
  fast with `At least one update type must be active` instead of silently running
  a package-manager-only upgrade.

  ### Malformed inputs now fail instead of falling back to defaults

  Input values are read through a proper input layer rather than a plain config
  lookup. A typo like `dry-run: maybe` used to be silently treated as `dry-run:
  false` — running for real when a dry run was intended — and is now a hard
  failure. Inputs that are genuinely absent still take their documented defaults;
  only malformed *present* values are rejected.

### Refactoring

* Migrated the action off the now-deleted `@savvy-web/github-action-effects`
  library onto the `@effected/*` kit (`github-actions`, `github`, `commands`,
  `npm`) plus `@savvy-web/silk-effects` 5.0.0. All action inputs are now read
  through the kit's `ActionInput` accessors — the mechanism behind both breaking
  changes above.

  Consequences for consumers:

  * The `pre`/`post` bundles are roughly 20% smaller (the previous octokit
    auth-app strategy is no longer bundled).
  * Bundled third-party license attribution is restored inline in the built
    `dist` output.
  * Test suite relocated to `__test__/unit/**` and partially converted to
    `@effect/vitest`; the documented multi-value input grammar (bulleted lists,
    JSON arrays, comma-separated values) is unchanged and still enforced by tests.

### Dependencies

* | Dependency                       | Type          | Action  | From   | To             |                                                                       |
  | :------------------------------- | :------------ | :------ | :----- | :------------- | --------------------------------------------------------------------- |
  | @savvy-web/github-action-effects | dependency    | removed | ^3.1.0 | —              |                                                                       |
  | @effected/commands               | dependency    | added   | —      | ^0.1.0         |                                                                       |
  | @effected/github                 | dependency    | added   | —      | ^0.1.0         |                                                                       |
  | @effected/github-actions         | dependency    | added   | —      | ^0.1.0         |                                                                       |
  | @effected/lockfiles              | dependency    | updated | ^0.2.0 | ^0.2.1         |                                                                       |
  | @effected/npm                    | dependency    | updated | ^0.4.0 | ^0.5.0         |                                                                       |
  | @effected/workspaces             | dependency    | updated | ^0.8.0 | ^0.9.0         |                                                                       |
  | @savvy-web/silk-effects          | dependency    | updated | ^4.2.6 | ^5.0.0         |                                                                       |
  | @effect/vitest                   | devDependency | added   | —      | 4.0.0-beta.101 |                                                                       |
  | @savvy-web/github-action-builder | devDependency | updated | ^2.0.6 | ^2.1.0         |                                                                       |
  | @savvy-web/silk                  | devDependency | updated | ^3.2.3 | ^3.2.4         | [#222][#222] Thanks [@spencerbeggs](https://github.com/spencerbeggs)! |

### Minor Changes

[#222]: https://github.com/savvy-web/silk-update-action/pull/222

## 4.2.5

### Dependencies

* | Dependency                       | Type       | Action  | From    | To     |                                                                              |
  | -------------------------------- | ---------- | ------- | ------- | ------ | ---------------------------------------------------------------------------- |
  | @effected/lockfiles              | dependency | updated | ^0.1.10 | ^0.2.0 |                                                                              |
  | @effected/npm                    | dependency | updated | ^0.3.1  | ^0.4.0 |                                                                              |
  | @effected/runtimes               | dependency | updated | ^0.1.5  | ^0.2.0 |                                                                              |
  | @effected/workspaces             | dependency | updated | ^0.7.0  | ^0.8.0 |                                                                              |
  | @effected/yaml                   | dependency | updated | ^0.5.1  | ^0.6.0 |                                                                              |
  | @savvy-web/github-action-effects | dependency | updated | ^3.0.5  | ^3.1.0 |                                                                              |
  | @savvy-web/silk-effects          | dependency | updated | ^4.2.5  | ^4.2.6 | [#220][#220] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#220]: https://github.com/savvy-web/silk-update-action/pull/220

## 4.2.4

### Bug Fixes

* Changeset dependency tables no longer escape version specifiers or package names. A `~0.2.0` specifier was previously written as `\~0.2.0`, and a package named `some_pkg` as `some\_pkg`, because table cells were passed through a markdown stringifier that escaped anything capable of opening a markdown construct. Fixed by bumping `@savvy-web/silk-effects` to `4.2.5`.
* Dependency and peer bumps flowing through a hook-injected pnpm catalog (e.g. a catalog like `catalog:effect:peers` injected by a config-dependency `pnpmfile` rather than declared inline in `pnpm-workspace.yaml`) now produce a changeset. Previously both sides of the diff fell back to the same raw, unresolved specifier, compared equal, and the action silently wrote zero changesets even though the dependency had moved. Fixed by bumping `@effected/workspaces` to `0.7.0` (consumed via `@savvy-web/silk-effects` 4.2.5).

Neither fix changes any `action.yml` input or output — no workflow changes are required to benefit. [#217][#217] Thanks [@spencerbeggs](https://github.com/spencerbeggs)!

### Dependencies

* | Dependency              | Type       | Action  | From   | To     |                                                                       |
  | ----------------------- | ---------- | ------- | ------ | ------ | --------------------------------------------------------------------- |
  | @effected/workspaces    | dependency | updated | ^0.6.2 | ^0.7.0 |                                                                       |
  | @savvy-web/silk-effects | dependency | updated | ^4.2.4 | ^4.2.5 | [#217][#217] Thanks [@spencerbeggs](https://github.com/spencerbeggs)! |

### Patch Changes

[#217]: https://github.com/savvy-web/silk-update-action/pull/217

## 4.2.3

### Dependencies

* | Dependency                       | Type       | Action  | From          | To             |                                                                              |
  | -------------------------------- | ---------- | ------- | ------------- | -------------- | ---------------------------------------------------------------------------- |
  | @effect/platform-node            | dependency | updated | 4.0.0-beta.99 | 4.0.0-beta.101 |                                                                              |
  | @effected/lockfiles              | dependency | updated | ^0.1.9        | ^0.1.10        |                                                                              |
  | @effected/npm                    | dependency | updated | ^0.3.0        | ^0.3.1         |                                                                              |
  | @effected/runtimes               | dependency | updated | ^0.1.4        | ^0.1.5         |                                                                              |
  | @effected/semver                 | dependency | updated | ^0.2.0        | ^0.2.1         |                                                                              |
  | @effected/workspaces             | dependency | updated | ^0.6.1        | ^0.6.2         |                                                                              |
  | @effected/yaml                   | dependency | updated | ^0.5.0        | ^0.5.1         |                                                                              |
  | @savvy-web/github-action-effects | dependency | updated | ^3.0.4        | ^3.0.5         |                                                                              |
  | @savvy-web/silk-effects          | dependency | updated | ^4.2.3        | ^4.2.4         |                                                                              |
  | effect                           | dependency | updated | 4.0.0-beta.99 | 4.0.0-beta.101 | [#215][#215] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#215]: https://github.com/savvy-web/silk-update-action/pull/215

## 4.2.2

### Dependencies

* | Dependency         | Type       | Action  | From   | To     |                                                                              |
  | ------------------ | ---------- | ------- | ------ | ------ | ---------------------------------------------------------------------------- |
  | @effected/runtimes | dependency | updated | ^0.1.3 | ^0.1.4 | [#210][#210] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#210]: https://github.com/savvy-web/silk-update-action/pull/210

## 4.2.1

### Dependencies

* | Dependency                       | Type       | Action  | From   | To     |                                                                              |
  | -------------------------------- | ---------- | ------- | ------ | ------ | ---------------------------------------------------------------------------- |
  | @effected/lockfiles              | dependency | updated | ^0.1.8 | ^0.1.9 |                                                                              |
  | @effected/workspaces             | dependency | updated | ^0.5.2 | ^0.6.1 |                                                                              |
  | @savvy-web/github-action-effects | dependency | updated | ^3.0.3 | ^3.0.4 |                                                                              |
  | @savvy-web/silk-effects          | dependency | updated | ^4.2.0 | ^4.2.3 | [#207][#207] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#207]: https://github.com/savvy-web/silk-update-action/pull/207

## 4.2.0

### Features

* Config and regular dependency resolution now respects pnpm's `minimumReleaseAge` / `minimumReleaseAgeExclude` settings. The action discovers the effective gate from both inline `pnpm-workspace.yaml` keys and config-dependency `pnpmfile` `updateConfig` hooks (replayed in a subprocess), fetches publish timestamps from the npm registry, and holds back any candidate version younger than the cutoff instead of proposing it. Runs no longer fail with `ERR_PNPM_NO_MATURE_MATCHING_VERSION` when a matched dependency published inside the age window — the update is deferred until the release matures, with a log line naming how many versions were held back. [#203][#203]

### Dependencies

* | Dependency                       | Type       | Action  | From   | To     |                                                                              |
  | -------------------------------- | ---------- | ------- | ------ | ------ | ---------------------------------------------------------------------------- |
  | @effected/lockfiles              | dependency | updated | ^0.1.6 | ^0.1.8 |                                                                              |
  | @effected/runtimes               | dependency | updated | ^0.1.2 | ^0.1.3 |                                                                              |
  | @effected/workspaces             | dependency | updated | ^0.5.0 | ^0.5.2 |                                                                              |
  | @savvy-web/github-action-effects | dependency | updated | ^3.0.2 | ^3.0.3 |                                                                              |
  | @savvy-web/silk-effects          | dependency | updated | ^4.1.0 | ^4.2.0 |                                                                              |
  | @effected/npm                    | dependency | added   | —      | ^0.3.0 | [#203][#203] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

Thanks to [@savvy-web-bot](https://github.com/apps/savvy-web-bot) for their contributions!

[#203]: https://github.com/savvy-web/silk-update-action/pull/203

## 4.1.1

### Bug Fixes

* Stopped the action from rewriting scoped `pnpm-workspace.yaml` keys (e.g. `"@parcel/watcher"`) from double to single quotes on every run. `pnpm-workspace.yaml` formatting now quotes with double quotes, matching the quoting style already used elsewhere in the file, so re-running the action against an already-formatted workspace file no longer produces a spurious quote-style diff. [#199][#199]

### Dependencies

* | Dependency                       | Type       | Action  | From          | To            |                                                                              |
  | -------------------------------- | ---------- | ------- | ------------- | ------------- | ---------------------------------------------------------------------------- |
  | @effect/platform-node            | dependency | updated | 4.0.0-beta.98 | 4.0.0-beta.99 |                                                                              |
  | @effected/lockfiles              | dependency | updated | ^0.1.3        | ^0.1.6        |                                                                              |
  | @effected/runtimes               | dependency | updated | ^0.1.0        | ^0.1.2        |                                                                              |
  | @effected/semver                 | dependency | updated | ^0.1.0        | ^0.2.0        |                                                                              |
  | @effected/workspaces             | dependency | updated | ^0.3.1        | ^0.5.0        |                                                                              |
  | @effected/yaml                   | dependency | updated | ^0.3.0        | ^0.5.0        |                                                                              |
  | @savvy-web/github-action-effects | dependency | updated | ^3.0.1        | ^3.0.2        |                                                                              |
  | @savvy-web/silk-effects          | dependency | updated | ^4.0.1        | ^4.1.0        |                                                                              |
  | effect                           | dependency | updated | 4.0.0-beta.98 | 4.0.0-beta.99 | [#199][#199] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

Thanks to [@savvy-web-bot](https://github.com/apps/savvy-web-bot) for their contributions!

[#199]: https://github.com/savvy-web/silk-update-action/pull/199

## 4.1.0

### Maintenance

* Migrate the action to Effect v4 (`effect@4.0.0-beta.98`) and the `@effected` app kit. The action's inputs and outputs are unchanged.

  ### Effect v4 and the @effected kit

  * `effect` and `@effect/platform-node` now resolve from the `catalog:effect` v4 catalog; the separate `@effect/platform` dependency is dropped (it is folded into core in v4).
  * The standalone Effect libraries are replaced by their `@effected` equivalents: `semver-effect` becomes `@effected/semver`, `workspaces-effect` becomes `@effected/workspaces` (with `@effected/lockfiles` for lockfile parsing), `runtime-resolver` becomes `@effected/runtimes`, and `yaml` becomes `@effected/yaml`.
  * Domain services move to the v4 class-based `Context.Service` form and the v4 error, layer and schema APIs.

  ### Package-manager detection

  Detection is now stricter: a bun or pnpm repository is identified from its lockfile together with the manifest, not from `devEngines.packageManager` alone (the same rule already applied to yarn). A repository that names a package manager only in `devEngines` and has no lockfile is now treated as npm.

  ### Test harness

  The Vitest config temporarily runs without `@vitest-agent/plugin`, which is Effect v3-only and crashes Vitest at config load under v4; the same coverage gate is preserved. Restore the plugin once it ships a v4-compatible release. [#194][#194]

### Minor Changes

Thanks to [@spencerbeggs](https://github.com/spencerbeggs) for their contributions!

[#194]: https://github.com/savvy-web/silk-update-action/pull/194

## 4.0.1

### Dependencies

* | Dependency              | Type       | Action  | From   | To     |                                                                              |
  | ----------------------- | ---------- | ------- | ------ | ------ | ---------------------------------------------------------------------------- |
  | @savvy-web/silk-effects | dependency | updated | ^3.3.0 | ^3.3.1 | [#190][#190] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#190]: https://github.com/savvy-web/silk-update-action/pull/190

## 4.0.0

### Breaking Changes

* The `upgrade-runtime-node`, `upgrade-runtime-deno` and `upgrade-runtime-bun` inputs no longer add a `devEngines.runtime` entry that does not already exist. Previously an explicit semver range could introduce a missing entry (promoting the object shape to an array), so a bun-only repo passing `upgrade-runtime-node` grew a node entry it never asked for. These inputs upgrade the runtimes a repo already declares; when no entry exists for the runtime, the upgrade is skipped with a warning naming the runtime and the input, in every mode.

  Resolved runtime versions are now written as exact versions with no range operator. The range still drives resolution — `auto` resolves within the existing entry's range and an explicit input range selects which line to resolve — but the value written is always the bare resolved version, so an existing `^24.0.0` entry is rewritten as e.g. `24.9.1` rather than `^24.16.0`. Range operators are not supported by downstream consumers of `devEngines.runtime` (silk-runtime-action), so writing one was a latent failure in the next pipeline step.

  The package-manager upgrade now emits a warning, not an info line, when no release of the detected package manager satisfies the `upgrade-package-manager` range — the usual cause is a range typed for a different package manager than the workspace uses. [#186][#186]

- **`config-dependencies` means something different per package manager.** pnpm reads `pnpm-workspace.yaml`; bun merges the package's `catalogs` export into `package.json`. In an **npm** repo it is unsupported and skipped with a warning: npm does not implement the `catalog:` protocol (bun and yarn do; the npm CLI does not).

- **`upgrade-runtime-*` upgrades only, and never adds.** With no existing `devEngines.runtime` entry for a runtime, there is nothing to upgrade and the input is skipped with a warning — in every mode. Previously an explicit semver range would *add* a missing entry, which grew an unwanted `node` entry in a bun-only repo.

- **Runtime versions are always written exact.** The range now only selects which line to resolve; the value written is the bare resolved version with no operator, so an existing `^24.0.0` is rewritten as e.g. `24.9.1`. Operator preservation was dropped deliberately: `silk-runtime-action`, which consumes `devEngines.runtime` in the next pipeline step, does not support range operators, so any operator written here is a latent downstream failure.

- **Two lockfile-diff reporting changes on the pnpm path.** A dependency declared in both `dependencies` and `devDependencies` now emits one change record per section rather than one in total, and a `peerDependencies` specifier change is now typed `peerDependency` (it was previously mislabelled `dependency`). Both are corrections, but they move `updates-count` and the generated PR title for existing pnpm consumers.

- Yarn repos are rejected with a clear error instead of being treated as pnpm.

* Remove the `log-level` and `skip-token-revoke` inputs. Logging now has two modes only — normal, or debug when the runner's step-debug flag (`ACTIONS_STEP_DEBUG` / `RUNNER_DEBUG`) is enabled — matching what the previous `auto` default already did. The post phase now always revokes the GitHub App installation token, which was the default behavior. Workflows passing either input will see an unexpected-input warning: remove the lines, and rely on re-running with debug logging where `log-level: debug` was used before. [#186][#186]

### Features

* The action is now package-manager-dispatched. One detected fact — the package manager — selects the implementation at four points: config dependencies, install, the package-manager upgrade, and the lockfile diff. pnpm, bun and npm repos are all supported. The package manager is detected from `devEngines.packageManager`, falling back to lockfile and config-file presence. Yarn is detected and rejected with a clear error rather than being silently treated as something else.

  * **Config dependencies in bun repos.** pnpm reads config dependencies from `pnpm-workspace.yaml`. bun has no such concept, so a package listed in `config-dependencies` is instead located in the root manifest's dependencies, its module is fetched and executed, and its `catalogs` export is merged into the root `package.json`'s `catalog` / `catalogs` fields. The tarball is verified against the registry's integrity before it is executed.

    Merging is **three-way** against the version that was previously installed, because — unlike pnpm, which merges catalogs in memory at install time and never rewrites the manifest — compat mode must write the result to disk, and a later run cannot otherwise tell a deliberate user override from an entry the action itself wrote. Entries the manifest still agrees with the previous version on are the action's to update; entries that diverge are the user's and survive, even if upstream dropped them; upstream removals propagate.

  * **`upgrade-package-manager` upgrades bun and npm**, not just pnpm. Corepack-managed managers (pnpm, npm) keep the pinned `+sha512` hash; bun is written as a bare version, because corepack does not manage bun and never reads that field.

  * **The install step is package-manager aware**: pnpm regenerates the lockfile (`pnpm clean --lockfile` then `pnpm install --frozen-lockfile=false`), bun re-resolves against the registry (`bun install --force`), npm removes `package-lock.json` and installs. The rationale is unchanged — the action mutates every input to dependency resolution, so the lockfile is regenerated rather than repaired.

  * **The lockfile diff is package-manager agnostic.** It reads `pnpm-lock.yaml`, `bun.lock` and `package-lock.json` through one parser, so it works in every supported repo instead of silently capturing nothing outside pnpm. The pnpm-only `@pnpm/lockfile.fs` and `@pnpm/lockfile.types` dependencies are gone.

  * **Catalog changes are reported.** On a config-dependency bump the PR body and job summary now render the table of catalog ranges that actually moved. Without it a bun run reported "1 config dependency updated" and showed none of what changed.

  * **Logging names every step and every decision.** The old step numbering had drifted out of sync with the steps. Steps are now named, every dispatch point states which path it took and on what evidence, and no step is skipped without saying so and why.

### Bug Fixes

* Bun catalogs are written at the **top level** of `package.json` (`catalog` / `catalogs` as siblings of `workspaces`) rather than nested inside the `workspaces` object. Both shapes are valid and bun reads either, so the nested form was not broken — but writing it rewrote an author's `"workspaces": ["."]` array into an object form they never wrote. A manifest already carrying the nested form is read and migrated on the next write, so it self-heals.

* A misconfigured `upgrade-package-manager` range now **warns**. A range that no release of the detected package manager satisfies (for example a pnpm range left behind in a bun repo) was reported at the same level as a routine skip, so it scrolled past as ordinary output.

* `pnpm-workspace.yaml` formatting is skipped in non-pnpm repos, where there is no such file to format. [#186][#186]

### Dependencies

* | Dependency              | Type       | Action  | From   | To     |                                                                       |
  | ----------------------- | ---------- | ------- | ------ | ------ | --------------------------------------------------------------------- |
  | @savvy-web/silk-effects | dependency | updated | ^3.2.5 | ^3.3.0 | [#186][#186] Thanks [@spencerbeggs](https://github.com/spencerbeggs)! |

### Patch Changes

Thanks to [@spencerbeggs](https://github.com/spencerbeggs) for their contributions!

[#186]: https://github.com/savvy-web/silk-update-action/pull/186

## 3.4.8

### Dependencies

* | Dependency              | Type       | Action  | From   | To     |                                                                              |
  | ----------------------- | ---------- | ------- | ------ | ------ | ---------------------------------------------------------------------------- |
  | @savvy-web/silk-effects | dependency | updated | ^3.2.3 | ^3.2.5 | [#180][#180] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#180]: https://github.com/savvy-web/silk-update-action/pull/180

## 3.4.7

### Dependencies

* | Dependency              | Type       | Action  | From   | To     |                                                                              |
  | ----------------------- | ---------- | ------- | ------ | ------ | ---------------------------------------------------------------------------- |
  | @savvy-web/silk-effects | dependency | updated | ^3.2.2 | ^3.2.3 | [#176][#176] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#176]: https://github.com/savvy-web/silk-update-action/pull/176

## 3.4.6

### Dependencies

* | Dependency              | Type       | Action  | From   | To     |                                                                              |
  | ----------------------- | ---------- | ------- | ------ | ------ | ---------------------------------------------------------------------------- |
  | @savvy-web/silk-effects | dependency | updated | ^3.2.1 | ^3.2.2 | [#173][#173] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#173]: https://github.com/savvy-web/silk-update-action/pull/173

## 3.4.5

### Bug Fixes

* The changeset step no longer silently writes zero changesets when dependency updates were applied earlier in the same run. The bundled `workspaces-effect` and `@savvy-web/silk-effects` now refresh the workspace-discovery cache before `DepsRegen` snapshots the worktree, so the diff sees the just-updated manifests instead of the ones cached before the update steps ran.

### Documentation

* Corrected the README and `docs/` guide to describe the `source-branch` / `target-branch` inputs and the `pnpm clean --lockfile` regeneration step, which were previously documented as always resetting to `main` and reconciling via `--fix-lockfile` [#168][#168]

### Dependencies

* | Dependency                       | Type       | Action  | From       | To         |                                                                       |
  | -------------------------------- | ---------- | ------- | ---------- | ---------- | --------------------------------------------------------------------- |
  | @pnpm/lockfile.types             | dependency | updated | ^1100.0.12 | ^1100.0.13 |                                                                       |
  | @savvy-web/github-action-effects | dependency | updated | ^2.3.7     | ^2.4.0     |                                                                       |
  | @savvy-web/silk-effects          | dependency | updated | ^3.1.0     | ^3.2.1     |                                                                       |
  | runtime-resolver                 | dependency | updated | ^0.3.21    | ^0.3.22    |                                                                       |
  | workspaces-effect                | dependency | updated | ^2.0.2     | ^2.0.3     | [#168][#168] Thanks [@spencerbeggs](https://github.com/spencerbeggs)! |

### Patch Changes

Thanks to [@spencerbeggs](https://github.com/spencerbeggs) for their contributions!

[#168]: https://github.com/savvy-web/silk-update-action/pull/168

## 3.4.4

### Bug Fixes

* Use latest `@savvy-web/silk-effects`

### Patch Changes

Thanks to [@spencerbeggs](https://github.com/spencerbeggs) for their contributions!

## 3.4.3

### Features

* PR and commit subject lines now break down dependency updates by `package.json` section instead of lumping them together — for example `chore(deps): update 1 config dependency and 4 devDependencies` instead of `chore(deps): update 1 config and 4 dependencies` — so it's clear at a glance whether an update touched runtime, dev, or peer dependencies. [#163][#163]

### Bug Fixes

* Fixed the pnpm self-upgrade silently skipping with a warning on GitHub's macOS runners. Resolving available pnpm versions now goes through the action's npm registry client (which redirects npm's cache to a runner-writable directory) instead of shelling out to `npm view`, which failed with `EACCES` against the partially root-owned `~/.npm` cache.

### Patch Changes

Thanks to [@savvy-web-bot](https://github.com/apps/savvy-web-bot) for their contributions!

[#163]: https://github.com/savvy-web/silk-update-action/pull/163

## 3.4.2

### Dependencies

* | Dependency              | Type          | Action  | From    | To     |                                                                              |
  | ----------------------- | ------------- | ------- | ------- | ------ | ---------------------------------------------------------------------------- |
  | @savvy-web/silk-effects | dependency    | updated | ^2.1.0  | ^3.0.0 |                                                                              |
  | @savvy-web/silk         | devDependency | updated | ^1.3.11 | ^2.0.0 | [#159][#159] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Other

* Upgrade `@savvy-web/silk-effects` to `^3.0.0` (changesets v3 `next` engine) and `@savvy-web/silk` to `^2.0.0`. Adds `build.nativeDynamicImports` for `@changesets/apply-release-plan` and `workspaces-effect` so their fully dynamic `await import()` calls survive bundling instead of failing at runtime with `Cannot find module`.

### Patch Changes

[#159]: https://github.com/savvy-web/silk-update-action/pull/159

## 3.4.1

### Dependencies

* | Dependency              | Type       | Action  | From   | To     |
  | ----------------------- | ---------- | ------- | ------ | ------ |
  | @savvy-web/silk-effects | dependency | updated | ^2.0.1 | ^2.1.0 |

## 3.4.0

### Features

* [`64967fe`](https://github.com/savvy-web/silk-update-action/commit/64967fe0b9d3018ad82730f0624c7ba8daccfe15) Adopt `@savvy-web/silk-effects` `Changesets.DepsRegen` as the source of truth for the dependency-changeset step. Dependency changesets are now regenerated from the cumulative `merge-base(target-branch) → worktree` diff and consolidated into a single `## Dependencies` table per package, deleting stale pure-dependency changesets — so re-running the action converges instead of accumulating duplicate changesets. Catalog-aware diffing and versionable-minus-ignored gating are handled upstream in silk-effects; the previous in-repo gating cascade and the `changeset-config`/`publishability` shims are removed.
* Workflows that enable `changesets` now need a full-history checkout (`actions/checkout` with `fetch-depth: 0`): the changeset step diffs against the base branch via `git merge-base`. `BranchManager.ensureBaseHistory` best-effort deepens a shallow clone when the base history is missing.

### Dependencies

* [`64967fe`](https://github.com/savvy-web/silk-update-action/commit/64967fe0b9d3018ad82730f0624c7ba8daccfe15) | Dependency | Type | Action | From | To |
  \| -------------------------------- | ---------- | ------- | ------- | ------- |
  \| @savvy-web/github-action-effects | dependency | updated | ^2.3.3 | ^2.3.5 |
  \| @savvy-web/silk-effects | dependency | updated | ^1.5.2 | ^2.0.1 |
  \| runtime-resolver | dependency | updated | ^0.3.19 | ^0.3.20 |
  \| semver-effect | dependency | updated | ^0.2.1 | ^0.3.1 |
  \| workspaces-effect | dependency | updated | ^1.2.0 | ^2.0.1 |

## 3.3.5

### Bug Fixes

* [`f33511f`](https://github.com/savvy-web/silk-update-action/commit/f33511f664fa7b7b12b51caeedb29d39fdfbd051) Explicitly declare `@types/node` version.

## 3.3.4

### Dependencies

* [`5790b63`](https://github.com/savvy-web/silk-update-action/commit/5790b63b64170de3877aa91fb024ae150c5e1287) | Dependency | Type | Action | From | To |
  \| :------------------------------- | :------------ | :------ | :------ | :------ |
  \| @savvy-web/github-action-effects | dependency | updated | ^2.3.1 | ^2.3.3 |
  \| @savvy-web/silk-effects | dependency | updated | ^1.5.1 | ^1.5.2 |
  \| runtime-resolver | dependency | updated | ^0.3.18 | ^0.3.19 |
  \| @savvy-web/github-action-builder | devDependency | updated | ^0.8.0 | ^1.0.1 |
  \| @savvy-web/silk | devDependency | updated | ^1.3.4 | ^1.3.5 |

## 3.3.3

### Dependencies

* | [`7cbb34d`](https://github.com/savvy-web/silk-update-action/commit/7cbb34da9b14f36a77b292bb885811fc37316ab8) | Dependency    | Type    | Action | From   | To |
  | :----------------------------------------------------------------------------------------------------------- | :------------ | :------ | :----- | :----- | -- |
  | @savvy-web/github-action-effects                                                                             | dependency    | updated | ^2.3.0 | ^2.3.1 |    |
  | @savvy-web/silk-effects                                                                                      | dependency    | updated | ^1.5.0 | ^1.5.1 |    |
  | @savvy-web/silk                                                                                              | devDependency | updated | ^1.3.3 | ^1.3.4 |    |

## 3.3.2

### Dependencies

* | [`24d624e`](https://github.com/savvy-web/silk-update-action/commit/24d624e03336859b59d6aa3fec8e95799a8d7603) | Dependency    | Type    | Action  | From    | To |
  | :----------------------------------------------------------------------------------------------------------- | :------------ | :------ | :------ | :------ | -- |
  | runtime-resolver                                                                                             | dependency    | updated | ^0.3.17 | ^0.3.18 |    |
  | @savvy-web/silk                                                                                              | devDependency | updated | ^1.3.2  | ^1.3.3  |    |
  | @savvy-web/vitest                                                                                            | devDependency | removed | ^1.5.1  | —       |    |
  | @vitest-agent/plugin                                                                                         | devDependency | added   | —       | ^1.0.0  |    |

## 3.3.1

### Dependencies

* | [`5ba1f01`](https://github.com/savvy-web/silk-update-action/commit/5ba1f01d2beff4f1a7da4680253a440199b48705) | Dependency    | Type    | Action  | From    | To |
  | :----------------------------------------------------------------------------------------------------------- | :------------ | :------ | :------ | :------ | -- |
  | @effect/platform                                                                                             | dependency    | updated | ^0.96.1 | ^0.96.2 |    |
  | effect                                                                                                       | dependency    | updated | ^3.21.3 | ^3.21.4 |    |
  | @savvy-web/github-action-effects                                                                             | dependency    | updated | ^2.2.1  | ^2.3.0  |    |
  | @savvy-web/silk-effects                                                                                      | dependency    | updated | ^1.4.0  | ^1.5.0  |    |
  | runtime-resolver                                                                                             | dependency    | updated | ^0.3.15 | ^0.3.17 |    |
  | @savvy-web/github-action-builder                                                                             | devDependency | updated | ^0.7.11 | ^0.8.0  |    |
  | @savvy-web/silk                                                                                              | devDependency | updated | ^1.2.0  | ^1.3.2  |    |

## 3.3.0

### Features

* [`666dc37`](https://github.com/savvy-web/silk-update-action/commit/666dc37b3192fd4c6633607a4809f0bc56bb7f52) PR titles and branch commit subjects are now generated from the run's actual contents instead of the static `chore(deps): Update Silk Dependencies`. Each run produces a specific, readable subject that reflects what changed.

Examples of generated titles:

* `chore(deps): upgrade pnpm to 10.12.1`
* `chore(deps): upgrade Node to 24.16.0`
* `chore(deps): bump effect to 3.19.1`
* `chore(deps): upgrade pnpm and update 6 dependencies`
* `chore(deps): update 3 config and 12 dependencies`

Single changes are named outright; single-category runs are summarized; mixed runs compose an `upgrade … and update …` shape. All subjects keep the `chore(deps):` conventional-commit prefix and stay within the 72-character header budget (falling back to `chore(deps): update dependencies` when a composed subject would overflow).

### Dependencies

* | [`666dc37`](https://github.com/savvy-web/silk-update-action/commit/666dc37b3192fd4c6633607a4809f0bc56bb7f52) | Dependency    | Type    | Action  | From    | To |
  | :----------------------------------------------------------------------------------------------------------- | :------------ | :------ | :------ | :------ | -- |
  | @savvy-web/github-action-effects                                                                             | dependency    | updated | ^2.1.4  | ^2.2.1  |    |
  | @savvy-web/silk-effects                                                                                      | dependency    | updated | ^1.1.0  | ^1.4.0  |    |
  | runtime-resolver                                                                                             | dependency    | updated | ^0.3.13 | ^0.3.15 |    |
  | @savvy-web/github-action-builder                                                                             | devDependency | updated | ^0.7.8  | ^0.7.11 |    |
  | @savvy-web/silk                                                                                              | devDependency | updated | ^1.0.0  | ^1.2.0  |    |
  | @savvy-web/vitest                                                                                            | devDependency | updated | ^1.5.0  | ^1.5.1  |    |

## 3.2.0

### Features

* [`a09bff1`](https://github.com/savvy-web/silk-update-action/commit/a09bff17389ebe2a6aa5c459f4441780b4a03364) Two new optional inputs let you control which branches the action operates against. With both unset, behavior is unchanged — the update branch is cut from `main` and the PR targets `main`.

### Bug Fixes

* [`a09bff1`](https://github.com/savvy-web/silk-update-action/commit/a09bff17389ebe2a6aa5c459f4441780b4a03364) `runInstall()` — the lockfile-reconciliation step that runs after pnpm, config dependency, runtime, and regular/peer range updates — now fully regenerates the lockfile instead of patching it. It runs `pnpm clean --lockfile` followed by `pnpm install --frozen-lockfile=false`, replacing the previous `pnpm install --frozen-lockfile=false --fix-lockfile`.

`--fix-lockfile` only repaired broken entries against the existing lockfile and did not re-run resolution under the changed pnpm version, config, and dependency ranges. This could commit an internally inconsistent `pnpm-lock.yaml` — most visibly when an upstream peer range changed (for example, a transitive raising its required `@effect/cluster` peer) and the new required peer was left unfilled, causing a downstream command to fail with `ERR_MODULE_NOT_FOUND`.

Regenerating the lockfile from scratch guarantees the committed `pnpm-lock.yaml` is correct and installable for the resolved pnpm version, config dependencies, and declared ranges.

* Expect larger `pnpm-lock.yaml` diffs in update PRs than before. Because the action obeys declared ranges, lockfile regeneration will advance transitive dependencies within their ranges. This is intentional — the previous behavior was silently suppressing those advancements.
* Requires pnpm 11+ for `pnpm clean`. If your root `package.json` defines a `clean` or `purge` script, pnpm will run that instead of the built-in lockfile cleanup; rename those scripts if they conflict.

### Dependencies

* | [`bd4a09e`](https://github.com/savvy-web/silk-update-action/commit/bd4a09ed693c2b06e84228bc7e88442aa17fb0af) | Dependency    | Type    | Action  | From    | To |
  | :----------------------------------------------------------------------------------------------------------- | :------------ | :------ | :------ | :------ | -- |
  | runtime-resolver                                                                                             | dependency    | updated | ^0.3.12 | ^0.3.13 |    |
  | @savvy-web/silk                                                                                              | devDependency | updated | ^0.5.0  | ^1.0.0  |    |

### `source-branch` and `target-branch` inputs

`source-branch` (default `main`) is the branch the dedicated dependency-update branch is created from and reset to on each run. The pull request targets this branch unless `target-branch` overrides it.

`target-branch` (default empty) is the branch the pull request merges into. Leave it unset to follow `source-branch`; set it only when you want to cut the update from one branch but merge the PR into a different one.

```yaml
- uses: savvy-web/silk-update-action@v3
  with:
    # Cut the update branch from dev, PR into main
    source-branch: dev
    target-branch: main
```

Both refs are validated before the action performs its destructive delete-and-recreate of the update branch. If either ref does not exist, the action fails fast with a clear input error rather than mid-run.

## 3.1.0

### Features

* [`c5e91bb`](https://github.com/savvy-web/silk-update-action/commit/c5e91bb737016f06b5067da87edc71f82ad9e7fd) ### Caret-on-zero regular deps roll forward to the first stable major

Regular dependencies declared with a caret on a pre-1.0 version (`^0.y.z`) now
resolve within a widened range (`>=0.y.z <2.0.0`) instead of the literal caret
range (`0.y.x`). This lets a pre-stable dependency advance across `0.x` minor
lines and adopt the first stable `1.x` release when one is available, rather
than being trapped by npm's caret-on-zero semantics.

All other specifier forms are unchanged: tilde (`~0.y.z`), exact pins (`0.y.z`),
comparator ranges (`>=0.y.z`), and caret deps on `>=1.0.0` versions continue to
resolve within the literal specifier.

```yaml
# package.json (before)
"some-lib": "^0.14.0" # was trapped in 0.14.x

# package.json (after a run with some-lib@1.2.0 published)
"some-lib": "^1.2.0" # advanced to latest stable major
```

### Dependencies

* | [`3682f03`](https://github.com/savvy-web/silk-update-action/commit/3682f0354464afeebb3dbf27af7df3287016b3c9) | Dependency    | Type    | Action | From   | To |
  | :----------------------------------------------------------------------------------------------------------- | :------------ | :------ | :----- | :----- | -- |
  | @savvy-web/silk-effects                                                                                      | dependency    | updated | ^1.0.1 | ^1.1.0 |    |
  | @savvy-web/github-action-builder                                                                             | devDependency | updated | ^0.7.7 | ^0.7.8 |    |

## 3.0.1

### Bug Fixes

* [`f59107d`](https://github.com/savvy-web/silk-update-action/commit/f59107da57e11bad2b071eca5c6bd434c991303f) ### Version selection now respects declared semver ranges

Previously, both regular and config dependency updates resolved to npm's absolute `latest` tag, ignoring the specifier declared in `package.json` or `pnpm-workspace.yaml`. This caused caret- and tilde-pinned deps to silently cross major boundaries — for example, a `^4.0.0` entry could be bumped to `5.x`.

Version selection now honors the existing specifier:

* **Regular dependencies** (`dependencies` input): resolves the highest published version satisfying the existing `package.json` specifier. A `^4.0.0` entry stays within `4.x`, a `~3.0.0` entry stays within `3.0.x`, and an exact pin (e.g. `4.0.0`) is left untouched. Prereleases are excluded. An unbounded range such as `>=4.0.0` may still advance across majors, matching its declared intent.

* **Config dependencies** (`config-dependencies` input, hash-pinned entries in `pnpm-workspace.yaml`): resolves within a conservative range derived from the current version's major. A `>=1.0.0` dep stays within its major; a pre-stable dep (`0.x`) may advance to the first stable major but never crosses two majors in one step.

## 3.0.0

### Build System

* [`cd35626`](https://github.com/savvy-web/silk-update-action/commit/cd356264c19248eb7d853f29a21b4bada2aa9216) Upgrades to release workflow v2

## 2.0.1

### Dependencies

* | [`eddac0f`](https://github.com/savvy-web/silk-update-action/commit/eddac0f3d778f3c4d2ed67c3cee15f7219995960) | Dependency    | Type    | Action | From   | To |
  | :----------------------------------------------------------------------------------------------------------- | :------------ | :------ | :----- | :----- | -- |
  | @savvy-web/github-action-effects                                                                             | dependency    | updated | ^2.1.0 | ^2.1.1 |    |
  | @savvy-web/silk-effects                                                                                      | dependency    | updated | ^0.6.0 | ^0.6.1 |    |
  | @savvy-web/github-action-builder                                                                             | devDependency | updated | ^0.7.3 | ^0.7.4 |    |
  | @savvy-web/silk                                                                                              | devDependency | updated | ^0.3.0 | ^0.3.1 |    |
  | @savvy-web/vitest                                                                                            | devDependency | updated | ^1.3.2 | ^1.4.0 |    |

## 2.0.0

### Breaking Changes

* [`acbe9c7`](https://github.com/savvy-web/silk-update-action/commit/acbe9c797f33592f0b90c5a7464c8d7db89669bd) ### Input renamed: `update-pnpm` → `upgrade-package-manager`

The pnpm self-upgrade input has been renamed from `update-pnpm` to `upgrade-package-manager` for consistency with the `upgrade-runtime-*` inputs. The old name is no longer recognized — consumers must rename the input in their workflow files.

```yaml
# Before
- uses: savvy-web/silk-update-action@v3
  with:
    update-pnpm: true

# After
- uses: savvy-web/silk-update-action@v3
  with:
    upgrade-package-manager: true
```

The input accepts `false` | `true` | `auto` | a semver range (default `true`). It currently upgrades pnpm only; support for other package managers is planned.

### Features

* [`acbe9c7`](https://github.com/savvy-web/silk-update-action/commit/acbe9c797f33592f0b90c5a7464c8d7db89669bd) ### Direct-edit pnpm upgrade with hash pinning and range support

`PnpmUpgrade` now edits the root `package.json` `packageManager` and `devEngines.packageManager` fields directly instead of running `corepack use` (which errors when both fields are present). The resolved version is written as a corepack-canonical `version+sha512.<hex>` hash derived from the npm registry integrity, so the committed fields are identical to what `corepack use` would produce.

The input also accepts explicit semver ranges (e.g. `^11`) that may cross majors and can add a `packageManager` field when none exists. `true`/`auto` resolve the latest within the current major, favoring the `devEngines.packageManager` version as the reference. The pnpm upgrade now triggers `pnpm install --fix-lockfile` to activate the new version via corepack reading the updated fields.

### Maintenance

* [`acbe9c7`](https://github.com/savvy-web/silk-update-action/commit/acbe9c797f33592f0b90c5a7464c8d7db89669bd) Action and package renamed from `pnpm-config-dependency-action` to `silk-update-action` to align with the Silk Suite. Update `uses:` references accordingly:

```yaml
# Before
uses: savvy-web/pnpm-config-dependency-action@v1

# After
uses: savvy-web/silk-update-action@v3
```

## 1.1.4

### Dependencies

* | [`fe89d45`](https://github.com/savvy-web/silk-update-action/commit/fe89d4521ca4b92df4910dbf08caf8cbedd02760) | Dependency | Type    | Action  | From    | To |
  | :----------------------------------------------------------------------------------------------------------- | :--------- | :------ | :------ | :------ | -- |
  | runtime-resolver                                                                                             | dependency | updated | ^0.3.10 | ^0.3.11 |    |

## 1.1.3

### Dependencies

* | [`19f5115`](https://github.com/savvy-web/silk-update-action/commit/19f5115f3b26207f57fef2d4e0745cb0978ab570) | Dependency    | Type    | Action | From   | To |
  | :----------------------------------------------------------------------------------------------------------- | :------------ | :------ | :----- | :----- | -- |
  | @savvy-web/github-action-effects                                                                             | dependency    | updated | ^2.0.1 | ^2.0.2 |    |
  | @savvy-web/github-action-builder                                                                             | devDependency | updated | ^0.7.1 | ^0.7.2 |    |

## 1.1.2

### Dependencies

* | [`a07cf34`](https://github.com/savvy-web/silk-update-action/commit/a07cf34b708f0054c13473b504635f511cf333fc) | Dependency    | Type    | Action | From    | To |
  | :----------------------------------------------------------------------------------------------------------- | :------------ | :------ | :----- | :------ | -- |
  | @savvy-web/github-action-effects                                                                             | dependency    | updated | ^2.0.0 | ^2.0.1  |    |
  | @savvy-web/silk-effects                                                                                      | dependency    | updated | ^0.4.1 | ^0.5.0  |    |
  | @savvy-web/commitlint                                                                                        | devDependency | updated | ^0.9.1 | ^0.10.0 |    |
  | @savvy-web/lint-staged                                                                                       | devDependency | updated | ^1.1.0 | ^1.2.0  |    |

## 1.1.1

### Bug Fixes

* [`0626369`](https://github.com/savvy-web/silk-update-action/commit/0626369652e3cd1865793cc87e473a4d40dc5fc0) Stops the action from creating an empty commit and opening a spurious pull request when a `run` command leaves the working tree dirty only by an executable-bit change (for example, husky chmod-ing `.husky` hook scripts during `savvy-commit init`).

- Change detection now runs `git status` with `core.fileMode=false`, so file-mode-only changes are ignored and no longer bypass the no-changes early exit
- This matches what the action actually commits — file content via the GitHub API at mode `100644` — so a mode-only diff can no longer produce an empty commit

## 1.1.0

### Features

* [`3eff0ab`](https://github.com/savvy-web/silk-update-action/commit/3eff0abe855961357470ca61a82a02195adba95a) ### devEngines Runtime Upgrade

Adds optional automatic upgrading of `devEngines.runtime` entries (`node`, `deno`, `bun`) in the root `package.json` via a new `RuntimeUpgrade` service backed by the `runtime-resolver` package.

Four new action inputs control the feature:

| Input                  | Default   | Behavior                                                                                                                                                                                                                                                                                     |
| :--------------------- | :-------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upgrade-runtime-node` | `false`   | `false` disables; `auto` bumps within the existing range preserving the operator; a semver range (e.g. `^22`) selects which line to resolve but preserves the existing entry's operator on write (an exact pin stays exact), using the range's own operator only when adding a missing entry |
| `upgrade-runtime-deno` | `false`   | Same semantics as `upgrade-runtime-node`                                                                                                                                                                                                                                                     |
| `upgrade-runtime-bun`  | `false`   | Same semantics as `upgrade-runtime-node`                                                                                                                                                                                                                                                     |
| `runtime-data`         | `offline` | `offline` uses the bundled release cache only; `live` fetches current data with fallback to the bundled cache                                                                                                                                                                                |

Resolution is limited to currently-maintained (non-end-of-life) major lines. `auto` mode is a no-op when the field is a static pin or already current. Runtime bumps appear in the PR body, commit message, and Actions summary but never trigger `pnpm install` and never create a changeset — consistent with how pnpm tooling upgrades are handled.

**Example — bump Node.js within its existing range:**

```yaml
- uses: savvy-web/silk-update-action@v3
  with:
    upgrade-runtime-node: auto
```

**Example — move Node.js to a specific major line with live data:**

```yaml
- uses: savvy-web/silk-update-action@v3
  with:
    upgrade-runtime-node: "^22"
    runtime-data: live
```

### Dependencies

* | [`54aa2b0`](https://github.com/savvy-web/silk-update-action/commit/54aa2b00d0ecc505aa1d78be8153cac722d3a575) | Dependency    | Type    | Action | From   | To |
  | :----------------------------------------------------------------------------------------------------------- | :------------ | :------ | :----- | :----- | -- |
  | @savvy-web/silk-effects                                                                                      | dependency    | updated | ^0.4.0 | ^0.4.1 |    |
  | workspaces-effect                                                                                            | dependency    | updated | ^1.0.0 | ^1.1.0 |    |
  | yaml                                                                                                         | dependency    | updated | ^2.8.3 | ^2.9.0 |    |
  | @savvy-web/lint-staged                                                                                       | devDependency | updated | ^1.0.1 | ^1.1.0 |    |

## 1.0.0

### Breaking Changes

* [`1410542`](https://github.com/savvy-web/silk-update-action/commit/1410542223c745e1ddadf03927d562552beb17f4) The `app-id` input has been renamed to `app-client-id`. Update your workflow's `with:` block when upgrading.

### Features

* [`1410542`](https://github.com/savvy-web/silk-update-action/commit/1410542223c745e1ddadf03927d562552beb17f4) Migrate to `@savvy-web/github-action-effects` 2.0 and `workspaces-effect` 1.0, adopting a three-phase (pre/main/post) GitHub App token lifecycle. The installation token is provisioned in a pre step — with up-front verification that the App grants `contents`, `pull-requests`, and `checks` write — and revoked in a post step via the `GitHubToken` namespace, replacing the previous in-process token bridge. A new optional `skip-token-revoke` input skips revocation in the post step (tokens expire after 1 hour regardless).

Adopt `@savvy-web/silk-effects` for publishability detection, replacing the action's local copy of the silk rules. Changeset creation now honors `.changeset/config.json` `ignore`: a package listed there is never given a changeset, even when `privatePackages.version` is enabled.

## 0.12.1

### Bug Fixes

* [`66ebacd`](https://github.com/savvy-web/silk-update-action/commit/66ebacd92c126eb454b45f26a7d5dada28955933) ### Match dependencies across all writable sections

The `dependencies` input now matches against `dependencies`,
`devDependencies`, and `optionalDependencies` of each workspace
package's `package.json`. Previously, only `devDependencies` were
scanned, so deps declared in `dependencies` (e.g. a runtime dep of a
publishable package) or `optionalDependencies` were silently skipped
even when they matched a configured pattern.

`peerDependencies` remain intentionally excluded — peer ranges are
managed by the `peer-lock` and `peer-minor` inputs via `syncPeers`.

A dependency that appears in more than one section of the same
package (e.g. both `dependencies` and `devDependencies`) is now
updated in every section it appears in, with one update record per
section.

### Refactoring

* [`66ebacd`](https://github.com/savvy-web/silk-update-action/commit/66ebacd92c126eb454b45f26a7d5dada28955933) Removed the local `Workspaces` service wrapper now that
  `workspaces-effect@0.5.1` exposes `WorkspaceDiscovery.listPackages(cwd)`
  and `WorkspaceDiscovery.importerMap(cwd)` upstream. Domain services
  yield `WorkspaceDiscovery` directly; `makeAppLayer` wires
  `WorkspaceDiscoveryLive` and `WorkspaceRootLive` with `NodeContext.layer`.
  No user-facing API changes.

### Accurate dependency type reporting

`DependencyUpdateResult.type` now reflects the actual section a dep
was found in (`dependency` / `devDependency` / `optionalDependency`)
instead of always reporting `devDependency`. `Changesets.create`
routes these by `update.type`: `dependency` and `optionalDependency`
trigger changeset emission for the affected workspace package, and
`devDependency` remains informational only. Catalog-resolved peer
changes and peer-sync rewrites continue to trigger as before.

## 0.12.0

### Features

* [`d06ac37`](https://github.com/savvy-web/silk-update-action/commit/d06ac37f48542eb67b8de34082419ffdbeb8eb5c) ### Versionable + trigger-driven changeset emission

Changesets now follow precise rules:

* A workspace package gets a changeset only if it is **versionable** (publishable per silk or vanilla mode rules, OR non-publishable with `privatePackages.version: true` in `.changeset/config.json`).
* A versionable package gets a changeset only when at least one **trigger** fires for it: a `dependencies` / `optionalDependencies` / `peerDependencies` specifier change in its own `package.json`, a peer-sync rewrite of one of its peers, or a non-dev catalog reference resolving to a different version after the run.
* `devDependencies`-only changes never produce a changeset (they appear in the table only when a changeset is being written for other reasons).
* Empty changesets are no longer emitted.

### Bug Fixes

* [`d06ac37`](https://github.com/savvy-web/silk-update-action/commit/d06ac37f48542eb67b8de34082419ffdbeb8eb5c) ### Catalog consumer detection on pnpm v9 lockfiles

`findCatalogConsumers` in the lockfile service now reads catalog specifiers from the importer's flat `specifiers` map (the pnpm v9 lockfile shape) instead of incorrectly looking for a `.specifier` property on the per-dep value (which is just a version string). Previously, catalog changes never surfaced as triggers because consumers were never matched. Catalog reference changes consumed in `dependencies`, `optionalDependencies`, or `peerDependencies` now correctly trigger changesets for the consuming workspace.

* [`ef5b742`](https://github.com/savvy-web/silk-update-action/commit/ef5b7420ca76d66232a1f910622983acfe9cfd41) ### Root-package name resolution

The action now correctly resolves the root workspace package's name when emitting changesets. Previously, dependency changes affecting the root would produce a changeset with the literal frontmatter key `"."` instead of the root's actual `name` field from `package.json`. The root cause was the underlying `workspace-tools` dependency excluding the root package from its package list; replaced with `workspaces-effect` which always includes the root.

* [`cadb1df`](https://github.com/savvy-web/silk-update-action/commit/cadb1dfc766d0112a611ddd80f2766f8ef1e3080) ### Preserve transitive dependencies during install

The action's lockfile-refresh step previously deleted `node_modules` and `pnpm-lock.yaml` before running `pnpm install`, forcing a from-scratch resolve. This had the side effect of bumping transitive dependencies for packages the action was not asked to touch — every run could quietly move unrelated transitives forward to whatever the registry currently resolved them to.

* [`ef5b742`](https://github.com/savvy-web/silk-update-action/commit/ef5b7420ca76d66232a1f910622983acfe9cfd41) Replace `workspace-tools` with `workspaces-effect` for workspace discovery and package metadata, via a new `Workspaces` domain service in `src/services/`.
* Add integration test infrastructure under `__test__/integration/` with two committed mock-workspace fixtures (`single-package-private-root` and `multi-package-public-root`).

The step now runs `pnpm install --frozen-lockfile=false --fix-lockfile` instead. The new command reconciles the lockfile against the just-modified `package.json` and `pnpm-workspace.yaml` files and installs `node_modules` to match, touching only the directly-bumped specifiers and their strict transitives. Unrelated transitives stay at their currently-pinned versions.

The `--frozen-lockfile=false` flag is required because pnpm auto-enables `--frozen-lockfile` in CI (`CI=true` is always set in GitHub Actions), which would otherwise refuse to write the lockfile changes the action just made.

### Maintenance

* [`ef5b742`](https://github.com/savvy-web/silk-update-action/commit/ef5b7420ca76d66232a1f910622983acfe9cfd41) Replace `workspace-tools` with `workspaces-effect` for workspace discovery and package metadata, via a new `Workspaces` domain service in `src/services/`.
* Add integration test infrastructure under `__test__/integration/` with two committed mock-workspace fixtures (`single-package-private-root` and `multi-package-public-root`).

### Per-importer per-section catalog change records

`compareCatalogs` now emits one `LockfileChange` per `(catalog change, consuming importer, dep section)` triple instead of a single aggregated record. Each record carries the accurate `type` field, so changes consumed only in `devDependencies` no longer incorrectly produce changesets for those workspaces.

## 0.11.2

### Other

* [`f7c001d`](https://github.com/savvy-web/silk-update-action/commit/f7c001dd755f341d0210f3bf79623bdad1eec9e5) Upgrades internals for distribution

## 0.11.1

### Bug Fixes

* [`34dbb1f`](https://github.com/savvy-web/silk-update-action/commit/34dbb1f9d4d805e33a485a4da6fb800d4695097e) Pins workspace-tools to 0.41.0 due to breaking upstream issue.

### Dependencies

* | [`1ece353`](https://github.com/savvy-web/silk-update-action/commit/1ece3531032449542e86fc8cb074c3919a9e768b) | Dependency    | Type    | Action | From   | To |
  | :----------------------------------------------------------------------------------------------------------- | :------------ | :------ | :----- | :----- | -- |
  | @savvy-web/commitlint                                                                                        | devDependency | updated | ^0.4.1 | ^0.4.3 |    |
  | @savvy-web/lint-staged                                                                                       | devDependency | updated | ^0.6.2 | ^0.6.4 |    |

## 0.11.0

### Features

* [`4798d16`](https://github.com/savvy-web/silk-update-action/commit/4798d163ba9f2b99550a3412b78b8a0e67f5e92d) Add granular peer dependency sync with `peer-lock` and `peer-minor` inputs.

- `peer-lock`: Sync peerDependency range on every devDependency version bump
- `peer-minor`: Sync peerDependency range only on minor+ bumps (floor patch to .0)
- Narrow `dependencies` input to match `devDependencies` only
- Fix changeset table `Type` column to use specific values (`devDependency`, `peerDependency`, `dependency`, `config`)
- Changesets only trigger on consumer-facing changes (peer range or runtime dependency changes), not devDependency-only updates
- PR body uses per-package tables with Dependency/Type/Action/From/To columns

## 0.10.0

### Features

* [`d7c18a6`](https://github.com/savvy-web/silk-update-action/commit/d7c18a6b5f741b526d7048b37815d5543024816d) Migrate to @savvy-web/github-action-effects v0.11 API, replacing legacy
  `@actions/*` imports and `Action.parseInputs()` with the modern library API.

- Use Effect's `Config.*` API for typed input parsing
- Use `ActionEnvironment` for GitHub context (SHA, repository)
- Use `Redacted` for secure private key handling
- Separate program logic from entry point for clean test imports
- Wire `OctokitAuthAppLive` and `GitHubClientLive` layers for GitHub App auth

## 0.9.0

### Features

* [`14da150`](https://github.com/savvy-web/silk-update-action/commit/14da150ca9e12d8dea62d65c2f9faf7221c0683e) Changeset summaries now use the structured GFM dependency table format from `@savvy-web/changesets`. The `## Dependencies` section renders a five-column table (Dependency, Type, Action, From, To) instead of bullet lists with arrows.

## 0.8.1

### Bug Fixes

* [`17d8b35`](https://github.com/savvy-web/silk-update-action/commit/17d8b358c23b3c2775a52d31f5195b3fc7709ad0) Add `log-level` action input using the standard `@savvy-web/github-action-effects` log-level setup with `auto`, `info`, `verbose`, and `debug` levels

## 0.8.0

### Breaking Changes

* [`035cae1`](https://github.com/savvy-web/silk-update-action/commit/035cae1369b48cc1b3c9151637dbd7ee5902b215) Collapse three-phase execution (pre/main/post) into single-phase architecture
* Remove `skip-token-revoke` and `log-level` inputs from action.yml
* Remove `token` output from action.yml

### Features

* [`035cae1`](https://github.com/savvy-web/silk-update-action/commit/035cae1369b48cc1b3c9151637dbd7ee5902b215) Upgrade @savvy-web/github-action-effects from v0.3.0 to v0.4.0
* Use `GitHubApp.withToken()` bracket pattern for automatic token lifecycle management
* Use `CheckRun.withCheckRun()` bracket pattern for check run lifecycle
* Use `Action.parseInputs()` for declarative, Schema-based input parsing
* Replace custom services (GitHubClient, GitExecutor, PnpmExecutor) with library equivalents (CommandRunner, GitBranch, GitCommit, GitHubClient)
* Use `AutoMerge.enable()` from library for auto-merge support

## 0.7.1

### Dependencies

* [`b538fde`](https://github.com/savvy-web/silk-update-action/commit/b538fde5724a8de53f5e509163f58cfe424b5f3e) @savvy-web/changesets: ^0.1.1 → ^0.4.1
* @savvy-web/commitlint: ^0.3.3 → ^0.4.0
* @savvy-web/github-action-builder: ^0.1.4 → ^0.2.0
* @savvy-web/lint-staged: ^0.4.5 → ^0.5.0
* @savvy-web/vitest: ^0.1.0 → ^0.2.0

## 0.7.0

### Features

* [`babbee1`](https://github.com/savvy-web/silk-update-action/commit/babbee17435d86dbd7f652cffee07e3f088105e4) Replace `pnpm add --config` with direct npm registry queries and YAML editing for config dependency updates, avoiding catalog promotion when `catalogMode: strict` is enabled

## 0.6.0

### Minor Changes

* [`ec30b5a`](https://github.com/savvy-web/silk-update-action/commit/ec30b5a96bcf93602b850d32344f2c0c4a69e2b4) Replace `pnpm up --latest` with direct npm queries for regular dependency updates to avoid promoting dependencies to catalogs when `catalogMode: strict` is enabled

## 0.5.1

### Bug Fixes

* [`c223a90`](https://github.com/savvy-web/silk-update-action/commit/c223a9077669478c82f4c7783cf51cca35cb6f45) Supports @savvy-web/vitest

## 0.5.0

### Bug Fixes

* [`e36fba1`](https://github.com/savvy-web/silk-update-action/commit/e36fba14758a90bd7b98d83b842170d7151f695b) Fix missing dependency detection for catalog resolved version changes.

When a clean install resolves a newer version within the same semver range (e.g., `^2.8.4` stays unchanged but resolves `2.8.6` to `2.8.7`), the action now correctly detects and reports the change. Previously, `compareCatalogs()` only compared the `specifier` field of catalog entries, ignoring the `version` (resolved) field. This caused changes that stayed within the declared semver range to fall through both the catalog and importer comparison paths undetected, resulting in 0 reported changes and an empty PR body.

The fix compares both `specifier` and `version` fields of `ResolvedCatalogEntry`. When only the resolved version changed, the reported from/to values use the concrete resolved versions (e.g., `2.8.6` to `2.8.7`). When the specifier itself changed, existing behavior is preserved (e.g., `^2.8.4` to `^2.9.0`).

## 0.4.0

### Minor Changes

* 85f1c06: Add `changesets` input option (default: `true`) to control whether changesets are created during dependency updates. When set to `false`, the action skips changeset creation, which is useful for repos that don't need the release cycle and just want a dependency update PR.

## 0.3.0

### Minor Changes

* 127b7b6: Add auto-merge support for dependency update PRs. A new `auto-merge` input
  accepts `merge`, `squash`, or `rebase` to enable GitHub's auto-merge via the
  GraphQL API after PR creation. Failures are handled gracefully with a warning
  log, requiring repository-level "Allow auto-merge" and branch protection to
  be configured.

## 0.2.0

### Minor Changes

* eec6269: Add pnpm self-upgrade step that detects pnpm versions from `packageManager` and `devEngines.packageManager` fields in root `package.json`, resolves the latest version within the `^` semver range, and upgrades via `corepack use`. Controlled by the new `update-pnpm` input (default: `true`). The upgrade runs before config dependency updates and is reported alongside them in the PR body.

## 0.1.0

### Minor Changes

* 826309a: Initial release of the Silk Update Action.

  A GitHub Action that automates updates to pnpm config dependencies and regular
  dependencies, filling the gap left by Dependabot's lack of support for pnpm's
  `configDependencies` feature in `pnpm-workspace.yaml`.

  ### Features

  * **Config dependency updates**: Updates config dependencies via `pnpm add --config`,
    tracking version changes with before/after comparison
  * **Regular dependency updates**: Updates regular dependencies via `pnpm up --latest`
    with glob pattern support (e.g., `effect`, `@effect/*`, `@savvy-web/*`)
  * **Custom post-update commands**: Execute commands after dependency updates via the
    `run` input (e.g., `pnpm lint:fix`, `pnpm test`). All commands run sequentially;
    if any fail, the job fails and no PR is created
  * **Changeset integration**: Automatically creates patch changesets for affected
    packages, with empty changesets for root workspace config dependency updates
  * **Verified commits**: Creates signed/verified commits via the GitHub API using
    GitHub App authentication (no SSH or GPG keys required)
  * **Branch management**: Manages a dedicated update branch with automatic creation
    or reset to the default branch on each run
  * **Lockfile diffing**: Compares `pnpm-lock.yaml` snapshots before and after updates
    to detect actual dependency changes, including catalog entry tracing to identify
    affected workspace packages
  * **Detailed PR summaries**: Generates Dependabot-style PR descriptions with
    dependency tables, npm links, and per-package changeset details
  * **GitHub App authentication**: Uses short-lived installation tokens with
    fine-grained permissions for secure automation
  * **Check run integration**: Creates GitHub check runs for visibility into action
    progress and results
  * **Dry-run mode**: Detect changes without committing, pushing, or creating PRs
  * **Debug logging**: Configurable log levels for troubleshooting

  ### Architecture

  Built with Effect-TS for typed error handling, retry logic, and service-based
  dependency injection. Uses a three-phase execution model (pre/main/post) with
  13 orchestration steps in the main phase.
