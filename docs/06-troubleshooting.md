# Troubleshooting

Common issues and their solutions.

## Table of contents

- [Input errors](#input-errors)
- [Authentication errors](#authentication-errors)
- [No changes detected](#no-changes-detected)
- [Custom commands failing](#custom-commands-failing)
- [Branch conflicts](#branch-conflicts)
- [Changeset issues](#changeset-issues)
- [Lockfile comparison issues](#lockfile-comparison-issues)

## Input errors

### "At least one update type must be active"

**Cause**: The workflow configured no update type. `config-dependencies`, `dependencies`, `upgrade-package-manager` and every `upgrade-runtime-*` input default to off, so a step that only passes the App credentials has nothing to do and fails rather than reporting a successful no-op run.

This also catches workflows written against an earlier version, where `upgrade-package-manager` defaulted to `true` and an otherwise empty configuration performed a package-manager upgrade implicitly.

**Solutions**:

- Add the dependencies you want updated to `config-dependencies` or `dependencies`
- To keep the old implicit package-manager bump, set `upgrade-package-manager` to `true`, `auto` or a semver range explicitly

### The run fails naming a single input

**Cause**: The input is present but its value cannot be parsed. Malformed values fail the run instead of falling back to the documented default, so a typo cannot silently change what the action does — a `dry-run: maybe` reading as `false` and performing a live run is the failure this guards against.

**Solutions**:

- `dry-run` and `changesets` accept only the YAML 1.2 booleans: `true`, `True`, `TRUE`, `false`, `False`, `FALSE`. `yes`, `on` and `1` are rejected
- `timeout` must be an integer number of seconds
- `upgrade-package-manager` must be `false`, `true`, `auto` or a parseable semver range; each `upgrade-runtime-*` input must be `false`, `auto` or a parseable semver range
- `runtime-data` must be `offline` or `live`. An unrecognized value fails rather than falling back to `offline`; the documented fallback to the bundled cache applies only when a `live` fetch fails at runtime
- An input left out entirely still takes its default — only a present, unparseable value fails

## Authentication errors

### "Pre-action failed: Failed to authenticate as GitHub App"

**Cause**: The `app-client-id` or `app-private-key` input is incorrect.

**Solutions**:

- Verify the client ID matches your GitHub App (found on the App settings page)
- Ensure the private key is the full PEM content, including the
  `-----BEGIN RSA PRIVATE KEY-----` and `-----END RSA PRIVATE KEY-----` markers
- Check that the secret was stored correctly (no extra whitespace or truncation)

### "Failed to get installation ID"

**Cause**: The GitHub App is not installed on the repository.

**Solutions**:

- Go to the App settings page and click **Install App**
- Ensure the repository is included in the installation scope
- If using organization-level installation, verify the repository is not
  excluded

### "Token not available"

**Cause**: The pre phase did not run or failed silently.

**Solutions**:

- Check the workflow logs for errors in the "Pre" section, where the token is provisioned
- Pin the action to a released version (the major alias tag `@v4`, or a full tag) rather than a branch or fork that may be missing the pre step
- Verify the runner has network access to `api.github.com`

## No changes detected

### "No dependency updates available"

**Cause**: All specified dependencies are already at their latest versions.

**Solutions**:

- Verify the dependency names in `config-dependencies` and `dependencies` match
  actual packages
- Check that the packages have newer versions available on npm
- Re-run with debug logging enabled (`ACTIONS_STEP_DEBUG`) to see detailed lockfile comparison output
- Run `pnpm outdated` locally to verify which packages have updates

### An available update is not proposed

**Cause**: The workspace declares pnpm's `minimumReleaseAge` setting (inline in `pnpm-workspace.yaml` or via a config dependency's `pnpmfile` `updateConfig` hook), and the newer version was published inside the age window. The action holds such versions back at resolution time so the install step cannot fail with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`.

**Solutions**:

- Check the logs for `Release-age gate: holding back ...` to confirm the gate fired
- Wait for the version to mature — a later run picks it up automatically
- Add the package to `minimumReleaseAgeExclude` if it should bypass the gate

### The package manager is not upgraded

**Cause**: `upgrade-package-manager` is set to `true` or `auto`, but neither `packageManager` nor `devEngines.packageManager` holds a value the action can read as a package-manager pin. The log line is `upgrade-package-manager: true/auto requested but no <pm> reference found`. A field naming a different manager than the one detected for the workspace is ignored on purpose, and so is a malformed value — a truncated version or a trailing typo is treated as no reference rather than as a version.

**Solutions**:

- Check that the field names the manager the run detected; the "Run context" block at the top of the log states which one that is
- Fix a malformed `packageManager` pin so it reads `<manager>@<version>` with an optional `+sha512.<hex>` tail
- A range in `devEngines.packageManager.version` such as `^11.0.0` is fine and anchors the upgrade; a range in `packageManager` is not, because corepack rejects one there
- Pass an explicit semver range instead of `auto` to upgrade a workspace that declares no reference at all

### Changes exist but action reports none

**Cause**: The lockfile comparison may not detect certain types of changes.

**Solutions**:

- Re-run with debug logging enabled (`ACTIONS_STEP_DEBUG`) to see the before/after lockfile structures
- Check that the dependency patterns in the `dependencies` input match the
  target packages (glob patterns must follow pnpm conventions)
- Verify that `pnpm install` resolves correctly (check the install step in logs)

## Custom commands failing

### "Custom commands failed: pnpm lint:fix"

**Cause**: A command in the `run` input exited with a non-zero status code.

**Solutions**:

- Run the command locally after updating the dependencies to see the full error
  output
- Check the workflow logs for the stderr output of the failed command
- Re-run with debug logging enabled (`ACTIONS_STEP_DEBUG`) for detailed error information
- Ensure the command is valid and available in the runner environment

### Commands pass locally but fail in CI

**Cause**: Environment differences between local and CI.

**Solutions**:

- Ensure Node.js and pnpm versions match between local and CI
- Check for missing environment variables
- Verify that all dev dependencies are installed (the action runs after
  `pnpm install`)

## Branch conflicts

### The update branch cannot be reset

**Cause**: The branch may have protection rules, or the App lacks permissions. Each run force-resets the update branch to the source branch.

**Solutions**:

- Ensure the GitHub App has `contents: write` permission
- Check that no branch protection rules prevent force-pushing the update branch
- If the branch is locked, unlock it manually in the repository settings

### Branch is out of date after action runs

**Cause**: The action resets the branch to the source branch (`source-branch`, default `main`) before applying changes. If the source branch advanced after the action started but before it pushed, the branch may be based on a slightly older commit.

**Solution**: This is expected behavior. The next run will reset the branch to the latest source branch again.

## Changeset issues

### No changesets created

**Cause**: The repository does not have a `.changeset/` directory, or no
packages were affected by the changes.

**Solutions**:

- Ensure `.changeset/` exists in the repository root (run `pnpm changeset init`
  if needed)
- Check that workspace packages actually use the updated dependencies as
  runtime/peer/optional dependencies. `devDependency`-only updates do not
  trigger changesets.
- Verify the affected packages are versionable: publishable, or a private package opted in via `privatePackages.version` in `.changeset/config.json`. Packages in the changeset `ignore` list and private packages without the opt-in are skipped.
- Config-only changes (`pnpm-workspace.yaml` `configDependencies`) do not
  produce a changeset on their own

### Changesets missing or empty on a shallow checkout

**Cause**: The changeset step diffs the working tree against the base branch
using `merge-base`. The default `actions/checkout` fetches a single commit
(`fetch-depth: 1`), which cannot resolve the merge-base, so the dependency diff
comes back empty or incorrect.

**Solution**: Set `fetch-depth: 0` on the checkout step when `changesets` is
enabled:

```yaml
- uses: actions/checkout@v7
  with:
    fetch-depth: 0
```

### Changeset created for wrong package

**Cause**: The lockfile comparison maps catalog changes to all packages that use
that catalog reference.

**Solution**: This is expected behavior. If a catalog entry changes, all
packages referencing that catalog are affected. Review the changeset to verify
correctness.

## Lockfile comparison issues

### Debug output shows empty catalogs or importers

**Cause**: The lockfile format may differ between pnpm versions.

**Solutions**:

- Ensure pnpm is up to date on the runner
- Check that `pnpm-lock.yaml` is committed and not in `.gitignore`
- Re-run with debug logging enabled (`ACTIONS_STEP_DEBUG`) to see the full lockfile structure

### "Cannot compare lockfiles: one or both are null"

**Cause**: The lockfile could not be read before or after updates.

**Solutions**:

- Verify `pnpm-lock.yaml` exists in the repository root
- Check for lockfile parsing errors in the debug output
- Ensure `pnpm install` completed successfully before the comparison
