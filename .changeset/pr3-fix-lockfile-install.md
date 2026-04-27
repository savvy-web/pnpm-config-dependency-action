---
"pnpm-config-dependency-action": patch
---

## Bug Fixes

### Preserve transitive dependencies during install

The action's lockfile-refresh step previously deleted `node_modules` and `pnpm-lock.yaml` before running `pnpm install`, forcing a from-scratch resolve. This had the side effect of bumping transitive dependencies for packages the action was not asked to touch — every run could quietly move unrelated transitives forward to whatever the registry currently resolved them to.

The step now runs `pnpm install --frozen-lockfile=false --fix-lockfile` instead. The new command reconciles the lockfile against the just-modified `package.json` and `pnpm-workspace.yaml` files and installs `node_modules` to match, touching only the directly-bumped specifiers and their strict transitives. Unrelated transitives stay at their currently-pinned versions.

The `--frozen-lockfile=false` flag is required because pnpm auto-enables `--frozen-lockfile` in CI (`CI=true` is always set in GitHub Actions), which would otherwise refuse to write the lockfile changes the action just made.
