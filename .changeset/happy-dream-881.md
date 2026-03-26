---
"pnpm-config-dependency-action": minor
---

## Features

Add granular peer dependency sync with `peer-lock` and `peer-minor` inputs.

- `peer-lock`: Sync peerDependency range on every devDependency version bump
- `peer-minor`: Sync peerDependency range only on minor+ bumps (floor patch to .0)
- Narrow `dependencies` input to match `devDependencies` only
- Fix changeset table `Type` column to use specific values (`devDependency`, `peerDependency`, `dependency`, `config`)
- Changesets only trigger on consumer-facing changes (peer range or runtime dependency changes), not devDependency-only updates
- PR body uses per-package tables with Dependency/Type/Action/From/To columns
