---
"silk-update-action": minor
---

## Bug Fixes

### A bun config-dependency merge no longer discards a user's catalog override

When the action merges a config dependency's catalogs under bun, it diffs the
new version against the version the lockfile says is installed — the merge
base. If that base could not be read, the merge fell back to a plugin-wins
algorithm: the plugin's entries overwrite the manifest's, and local additions
survive. That is the right answer when the base version is genuinely gone
(yanked or unpublished), because there is no base to diff against.

Every other way the base could fail to load arrived as the same result, so it
took the same path. A base tarball that failed its **integrity check** — bytes
that are not what the registry vouched for — was treated as a missing merge
base, and the plugin's value overwrote a deliberate user override, on a run
that reported success.

A base that cannot be read faithfully is not an absent base. The three
outcomes are now distinguished:

| Base outcome | Merge |
| :--- | :--- |
| Read successfully | Three-way merge against it, as before |
| No published tarball (yanked, unpublished) | Plugin-wins, as before |
| Fetched but ships no `catalogs` export | Three-way merge against an empty base |
| HTTP failure, integrity mismatch, extract failure | **Dependency is skipped entirely** |

The skip leaves the declared range unbumped too: writing a version whose
catalogs were never merged would leave the manifest describing a release it
never saw.

The empty-base row is a separate fix in the same area. A config dependency that
adds catalogs for the first time has a base that loaded perfectly and simply
ships none. That is an empty base, not a missing one — every entry already in
the manifest predates the plugin and is the user's by definition, so it is kept
verbatim while the new version's entries are added. Plugin-wins would have
overwritten a user's value on a key the plugin had only just started shipping.

## Refactoring

Tarball fetching, integrity verification and extraction now come from
`@effected/npm`'s `PackageTarball`, and entry-point resolution from
`@effected/package-json`'s `resolveEntryPoint`. Both were harvested out of this
action upstream. Loading the resolved entry stays here, because a dynamic
`import()` of a computed path is compiled into a context module by bundlers and
a kit-level loader would hand every bundling consumer that problem.

One behavior change comes with the resolver. When a package's `exports` field
is present but no condition matches, entry resolution now fails instead of
falling back to `main` and then `index.js`. `exports` encapsulates a package,
so the old fallback loaded a file the package deliberately does not export.
This affects a config dependency that ships `require`-only `exports` alongside
a `main`; such a package previously loaded and now does not.
