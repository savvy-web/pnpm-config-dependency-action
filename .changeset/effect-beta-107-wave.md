---
"silk-update-action": minor
---

## Dependencies

| Dependency | Type | Action | From | To |
| :--- | :--- | :--- | :--- | :--- |
| effect | dependency | updated | 4.0.0-beta.101 | 4.0.0-beta.107 |
| @effect/platform-node | dependency | updated | 4.0.0-beta.101 | 4.0.0-beta.107 |
| @effected/commands | dependency | updated | ^0.3.0 | ^0.4.0 |
| @effected/git | dependency | updated | ^0.5.2 | ^0.7.0 |
| @effected/github | dependency | updated | ^0.2.3 | ^0.3.0 |
| @effected/github-actions | dependency | updated | ^0.5.1 | ^0.6.0 |
| @effected/lockfiles | dependency | updated | ^0.3.2 | ^0.4.0 |
| @effected/npm | dependency | updated | ^0.8.3 | ^0.9.0 |
| @effected/runtimes | dependency | updated | ^0.2.5 | ^0.3.0 |
| @effected/semver | dependency | updated | ^0.3.2 | ^0.4.0 |
| @effected/workspaces | dependency | updated | ^0.10.0 | ^0.11.1 |
| @effected/yaml | dependency | updated | ^0.6.1 | ^0.7.0 |
| @savvy-web/silk-effects | dependency | updated | ^5.3.0 | ^5.5.2 |
| @effect/vitest | devDependency | updated | 4.0.0-beta.101 | catalog:effect |
| @effected/schemastore | devDependency | updated | 0.2.1 | ^0.3.0 |
| @savvy-web/github-action-builder | devDependency | updated | ^2.2.2 | ^2.2.3 |
| @savvy-web/silk | devDependency | updated | ^3.4.0 | ^3.5.2 |
| @vitest-agent/plugin | devDependency | updated | ^2.0.13 | ^2.0.16 |
| @effected/pnpm-plugin-effect | config | updated | 0.3.2 | 0.4.0 |
| @effect/platform-node-shared | dependency | removed | 4.0.0-beta.101 | — |

## Maintenance

Adopts the `@effected` kit's coordinated `effect@4.0.0-beta.107` wave. The whole
graph now resolves a single `effect` copy, which retires both the
`@effect/platform-node-shared` override and the duplicate `@effected/workspaces`
resolution that was previously bundled into `dist/main.js`.

`@effect/vitest` moves from an exact literal to `catalog:effect` — the same
catalog entry as `effect` itself — so the lockstep those two must keep is now
maintained by the catalog rather than by a hand-bumped pin.

## Refactoring

* Error classes in `src/errors/errors.ts` now extend `Schema.TaggedError`, which
  `effect@4.0.0-beta.107` renamed back from `Schema.TaggedErrorClass`. The curried
  shape is identical, so the four declarations are the only source change; the
  action's runtime behavior is unchanged.
* `DependencyType` now carries an explicit `identifier` annotation. The beta.107
  JSON Schema lowering hoists a sub-schema used in more than one place into
  `$defs` rather than inlining it at each use site, and names it positionally when
  there is no identifier to use.

## Documentation

* `docs/schema/run-result.schema.json` gains a `$defs/DependencyType` definition,
  and the `type` field of `DependencyUpdateResult` and `LockfileChange` now
  `$ref`s it instead of repeating the enum inline. The constraint each field
  imposes is unchanged, so validation of an existing `result` document is
  unaffected.
