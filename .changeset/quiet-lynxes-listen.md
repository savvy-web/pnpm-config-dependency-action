---
"silk-update-action": patch
---

## Bug Fixes

`check-peers` no longer withholds auto-merge on repositories whose lockfile carries npm-aliased dependency edges (e.g. `foo: npm:bar@^1.0.0`) or `publishDirectory` workspace links. Both edge shapes were previously misclassified as unresolved, so the peer-check gate reported `unverified (unresolvedEdge)` and disabled auto-merge even when peer dependencies were actually satisfied. These lockfiles now gate as proven-clean.
