---
"silk-update-action": minor
---

## Features

### `check-peers` reports unsatisfied peer dependencies and can withhold auto-merge

A new `check-peers` input inspects the dependency graph this run is about to
commit and reports any unsatisfied peer dependencies in the pull request body,
the job summary and the structured `result` output.

Values are `false` (the default — the check does not run, matching the opt-in
posture of `upgrade-package-manager` and the `upgrade-runtime-*` inputs), `warn`
(report only, never gate) and `no-auto-merge` (report, and skip the auto-merge
request when a required peer is unsatisfied).

Under `no-auto-merge` the pull request is still created and pushed exactly as
before — auto-merge is a separate API call, and withholding it means that call is
not made. A repository with a broken peer graph therefore gets a pull request it
can review rather than a silent automatic merge, and needs no branch-protection
configuration for the gate to take effect.

`no-auto-merge` has no effect when `auto-merge` is itself disabled. That
combination warns rather than failing, because `auto-merge` is legitimately
driven by a workflow expression that may resolve to an empty value on some
events.

The check runs against the regenerated lockfile rather than `node_modules`, so it
answers a question about the artifact the pull request actually carries.

### The peer report is treated as clean only when it is proven clean

A report with no rows is not automatically a pass. Auto-merge is withheld unless
the package manager's lockfile format is supported, every importer resolved, and
the suppression policy was applied — because each of those, on its own, produces
an empty result that means "not examined" rather than "nothing wrong".

This matters because pnpm records resolution-affecting configuration in the
lockfile and discards reporting-affecting configuration: `peerDependencyRules`
appears nowhere in a lockfile, so a check reading the lockfile alone would report
peers that pnpm deliberately suppresses. Those rules are read through
`@effected/workspaces`, including rules injected by config-dependency plugins
rather than declared in `pnpm-workspace.yaml`.

Two limits are deliberate. Optional peers are reported but never gate. A pnpm
workspace package's own peer declarations cannot be checked at all, because pnpm
does not record them in the lockfile and `pnpm peers check` does not report them
either.
