---
"pnpm-config-dependency-action": patch
---

## Bug Fixes

### Root-package name resolution

The action now correctly resolves the root workspace package's name when emitting changesets. Previously, dependency changes affecting the root would produce a changeset with the literal frontmatter key `"."` instead of the root's actual `name` field from `package.json`. The root cause was the underlying `workspace-tools` dependency excluding the root package from its package list; replaced with `workspaces-effect` which always includes the root.

## Maintenance

- Replace `workspace-tools` with `workspaces-effect` for workspace discovery and package metadata, via a new `Workspaces` domain service in `src/services/`.
- Add integration test infrastructure under `__test__/integration/` with two committed mock-workspace fixtures (`single-package-private-root` and `multi-package-public-root`).
