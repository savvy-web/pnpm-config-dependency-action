---
"pnpm-config-dependency-action": minor
---

Add `changesets` input option (default: `true`) to control whether changesets are created during dependency updates. When set to `false`, the action skips changeset creation, which is useful for repos that don't need the release cycle and just want a dependency update PR.
