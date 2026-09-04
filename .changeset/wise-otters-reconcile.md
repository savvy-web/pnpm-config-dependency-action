---
"silk-update-action": patch
---

## Maintenance

Reconciles the repository against the 2026-09-04 `@effected` action canon (#394). No input, output, or runtime behavior changed — the bundle is rebuilt and dead build/test scaffolding is removed.

* Removed the `build.ignore` entry from `action.config.ts` — it aliased three optional `@cyclonedx/cyclonedx-library` plugins (`xmlbuilder2`, `libxmljs2`, `ajv-formats-draft2019`) that only ever arrived transitively through the long-deleted `@savvy-web/github-action-effects`. `cyclonedx` has zero occurrences in the lockfile; rebuilding without the entry changed `dist/main.js` by minifier variable renaming only
* Removed `.actrc` and `.github/workflows/act-test.yml`. The workflow referenced `./.github/actions/local`, a path this repo has never generated, so it could only ever fail. `persistLocal` stays disabled — persisting it would roughly double the bundle every consumer downloads on each run, for an `act` loop nothing here exercises
* Rebuilt `dist/` against the current dependency tree

## Refactoring

* Removed the unused `Lockfile` `Context.Service` tag and layer from `src/services/lockfile.ts` — nothing in `src/` ever resolved it; the standalone helpers (`captureLockfileState`, `compareLockfiles`, `groupChangesByPackage`) that the action actually calls are unchanged
