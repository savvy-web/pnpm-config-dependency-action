---
"silk-update-action": minor
---

## Bug Fixes

### Commits are now signed off as the App bot that authored them

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

## Refactoring

* `corepackHashFromIntegrity` removed from `src/utils/pnpm.ts`, which now exports
  `detectIndent` alone. The kit shipped the conversion this repository's copy
  motivated upstream.
* `resolveSignoff()` added at `src/utils/commit-signoff.ts`, matching
  `silk-release-action`'s module of the same name — both actions commit through
  the Git Data API, so both must supply a trailer no porcelain adds. `Report`
  resolves it once when its layer is built.

## Tests

* Four cases pinning the package-manager pin and integrity behaviour above, two
  of which are verified to fail against the previous implementations.
* Five cases over `resolveSignoff`, covering both fallback depths.
* The in-memory `ActionState` double now **fails typed** on a missing key rather
  than dying, matching the real store. A defect is uncatchable, so code whose
  contract is to degrade when nothing was persisted read as broken under the
  double while being correct in production.

## Dependencies

| Dependency               | Type          | Action  | From    | To      |
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
direct call site for that grammar.
