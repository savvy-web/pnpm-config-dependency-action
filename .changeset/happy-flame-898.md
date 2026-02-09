---
"pnpm-config-dependency-action": minor
---

Add auto-merge support for dependency update PRs. A new `auto-merge` input
accepts `merge`, `squash`, or `rebase` to enable GitHub's auto-merge via the
GraphQL API after PR creation. Failures are handled gracefully with a warning
log, requiring repository-level "Allow auto-merge" and branch protection to
be configured.
