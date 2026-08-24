---
"silk-update-action": patch
---

## Dependencies

| Dependency | Type | Action | From | To |
| :--------- | :--- | :----- | :--- | :-- |
| @effected/pnpm-plugin-effect | config | updated | 0.6.4 | 0.6.5 |

The config dependency carries the catalog every `@effected/*` range resolves
through, so this is what moves `@effected/npm` to `0.12.0` and
`@effected/package-json` to `0.11.0` — the releases that carry `PackageTarball`
and `resolveEntryPoint`.

`TarballError.reason` widened from four members to five in that release:
`integrityUnverifiable` (the digest could not be computed) is now distinct from
`integrityMismatch` (two digests existed and differed). Config-dependency base
routing needed no change — an unrecognised reason already takes the
conservative skip route.
