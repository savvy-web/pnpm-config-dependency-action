---
"silk-update-action": patch
---

## Bug Fixes

`check-peers` no longer withholds auto-merge on repositories whose lockfile carries npm-aliased dependency edges (e.g. `foo: npm:bar@^1.0.0`) or `publishDirectory` workspace links. Both edge shapes were previously misclassified as unresolved, so the peer-check gate reported `unverified (unresolvedEdge)` and disabled auto-merge even when peer dependencies were actually satisfied. These lockfiles now gate as proven-clean.

`check-peers` also no longer judges the post-update lockfile against pre-update peer suppression rules. The gate now refreshes the workspace catalog assembly before reading `peerDependencyRules`, so a run that bumps a config-dependency plugin reads the rules the freshly-installed plugin actually ships, rather than the rules in effect before this run started. Previously a plugin bump that newly allowed a peer mismatch could still report it as `required` and withhold auto-merge.
