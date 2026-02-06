# Troubleshooting

Common issues and their solutions.

## Table of Contents

- [Authentication Errors](#authentication-errors)
- [No Changes Detected](#no-changes-detected)
- [Custom Commands Failing](#custom-commands-failing)
- [Branch Conflicts](#branch-conflicts)
- [Changeset Issues](#changeset-issues)
- [Lockfile Comparison Issues](#lockfile-comparison-issues)

## Authentication Errors

### "Pre-action failed: Failed to authenticate as GitHub App"

**Cause**: The `app-id` or `app-private-key` input is incorrect.

**Solutions**:

- Verify the App ID matches your GitHub App (found on the App settings page)
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

- Check the workflow logs for errors in the "Pre" section
- Ensure `action.yml` is using the correct `runs.pre` path
- Verify the runner has network access to `api.github.com`

## No Changes Detected

### "No dependency updates available"

**Cause**: All specified dependencies are already at their latest versions.

**Solutions**:

- Verify the dependency names in `config-dependencies` and `dependencies` match
  actual packages
- Check that the packages have newer versions available on npm
- Use `log-level: debug` to see detailed lockfile comparison output
- Run `pnpm outdated` locally to verify which packages have updates

### Changes exist but action reports none

**Cause**: The lockfile comparison may not detect certain types of changes.

**Solutions**:

- Enable `log-level: debug` to see the before/after lockfile structures
- Check that the dependency patterns in the `dependencies` input match the
  target packages (glob patterns must follow pnpm conventions)
- Verify that `pnpm install` resolves correctly (check the install step in logs)

## Custom Commands Failing

### "Custom commands failed: pnpm lint:fix"

**Cause**: A command in the `run` input exited with a non-zero status code.

**Solutions**:

- Run the command locally after updating the dependencies to see the full error
  output
- Check the workflow logs for the stderr output of the failed command
- Enable `log-level: debug` for detailed error information
- Ensure the command is valid and available in the runner environment

### Commands pass locally but fail in CI

**Cause**: Environment differences between local and CI.

**Solutions**:

- Ensure Node.js and pnpm versions match between local and CI
- Check for missing environment variables
- Verify that all dev dependencies are installed (the action runs after
  `pnpm install`)

## Branch Conflicts

### "Failed to delete branch"

**Cause**: The branch may have protection rules or the App lacks permissions.

**Solutions**:

- Ensure the GitHub App has `contents: write` permission
- Check that no branch protection rules prevent deletion of the update branch
- If the branch is locked, unlock it manually in the repository settings

### Branch is out of date after action runs

**Cause**: The action resets the branch to `main` before applying changes. If
`main` advanced after the action started but before it pushed, the branch may be
based on a slightly older commit.

**Solution**: This is expected behavior. The next run will reset the branch to
the latest `main` again.

## Changeset Issues

### No changesets created

**Cause**: The repository does not have a `.changeset/` directory, or no
packages were affected by the changes.

**Solutions**:

- Ensure `.changeset/` exists in the repository root (run `pnpm changeset init`
  if needed)
- Check that workspace packages actually use the updated dependencies
- Config dependency changes create empty changesets (no packages listed), which
  is intentional

### Changeset created for wrong package

**Cause**: The lockfile comparison maps catalog changes to all packages that use
that catalog reference.

**Solution**: This is expected behavior. If a catalog entry changes, all
packages referencing that catalog are affected. Review the changeset to verify
correctness.

## Lockfile Comparison Issues

### Debug output shows empty catalogs or importers

**Cause**: The lockfile format may differ between pnpm versions.

**Solutions**:

- Ensure pnpm is up to date on the runner
- Check that `pnpm-lock.yaml` is committed and not in `.gitignore`
- Enable `log-level: debug` to see the full lockfile structure

### "Cannot compare lockfiles: one or both are null"

**Cause**: The lockfile could not be read before or after updates.

**Solutions**:

- Verify `pnpm-lock.yaml` exists in the repository root
- Check for lockfile parsing errors in the debug output
- Ensure `pnpm install` completed successfully before the comparison
