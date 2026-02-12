---
"pnpm-config-dependency-action": minor
---

Fix missing dependency detection for catalog resolved version changes.

When a clean install resolves a newer version within the same semver range
(e.g., `^2.8.4` stays unchanged but resolves `2.8.6` to `2.8.7`), the
action now correctly detects and reports the change. Previously,
`compareCatalogs()` only compared the `specifier` field of catalog entries,
ignoring the `version` (resolved) field. This caused changes that stayed
within the declared semver range to fall through both the catalog and
importer comparison paths undetected, resulting in 0 reported changes and
an empty PR body.

The fix compares both `specifier` and `version` fields of
`ResolvedCatalogEntry`. When only the resolved version changed, the
reported from/to values use the concrete resolved versions (e.g.,
`2.8.6` to `2.8.7`). When the specifier itself changed, existing
behavior is preserved (e.g., `^2.8.4` to `^2.9.0`).
