# GitHub App setup

This guide explains how to create and configure the GitHub App required by the
Silk Update Action.

## Table of contents

- [Why a GitHub App](#why-a-github-app)
- [Step 1: Create the App](#step-1-create-the-app)
- [Step 2: Configure permissions](#step-2-configure-permissions)
- [Step 3: Generate a private key](#step-3-generate-a-private-key)
- [Step 4: Install the App](#step-4-install-the-app)
- [Step 5: Store secrets](#step-5-store-secrets)

## Why a GitHub App

The action authenticates as a GitHub App rather than with a personal access token. A GitHub App gives you four things a PAT does not.

- **Short-lived tokens**: an installation token expires after one hour, so a leaked token is useless within the hour
- **Fine-grained permissions**: the App is granted only the scopes the action needs and nothing more
- **Verified commits**: commits made through the GitHub API with an App token are signed and show the "Verified" badge
- **No user dependency**: the App is not tied to any individual user account, and the commits are attributed to the App in the audit trail

The DCO `Signed-off-by` trailer on those commits names the same bot identity (`<your-app>[bot]`), so the author and the sign-off agree. Repositories that enforce a DCO check comparing the two will see the trailer change from `github-actions[bot]` to the App's own bot on the first run after upgrading.

## Step 1: Create the App

1. Go to **Settings > Developer settings > GitHub Apps**
2. Click **New GitHub App**
3. Fill in the required fields:
   - **Name**: Choose a descriptive name (e.g. `my-org-dep-updater`)
   - **Homepage URL**: Your repository URL
   - **Webhook**: Uncheck "Active" (this app does not need webhooks)
4. Click **Create GitHub App**
5. Note the **Client ID** shown on the settings page (this is the value the action's `app-client-id` input expects, not the numeric App ID)

## Step 2: Configure permissions

Under **Permissions & events**, set the following repository permissions:

| Permission | Access | Purpose |
| --- | --- | --- |
| Contents | Read & write | Push commits, create/delete branches |
| Pull requests | Read & write | Create and update PRs |
| Checks | Read & write | Create check runs for status visibility |

No organization or account permissions are needed. No webhook events need to be
subscribed to.

## Step 3: Generate a private key

1. On the App settings page, scroll to **Private keys**
2. Click **Generate a private key**
3. A `.pem` file will download automatically
4. Store this file securely — it is used to authenticate as the App

The private key content (including the `-----BEGIN RSA PRIVATE KEY-----` and
`-----END RSA PRIVATE KEY-----` markers) is what you will store as a secret.

## Step 4: Install the App

1. On the App settings page, click **Install App** in the sidebar
2. Choose the organization or account
3. Select **Only select repositories** and choose the repositories that need
   dependency updates
4. Click **Install**

The App must be installed on every repository where you plan to use the action.

## Step 5: Store secrets

Add the App credentials as GitHub Actions secrets:

### Repository-level secrets

1. Go to the target repository
2. Navigate to **Settings > Secrets and variables > Actions**
3. Click **New repository secret**
4. Add `APP_CLIENT_ID` with the client ID from Step 1
5. Add `APP_PRIVATE_KEY` with the full contents of the `.pem` file from Step 3

### Organization-level secrets (recommended for multiple repos)

1. Go to **Organization Settings > Secrets and variables > Actions**
2. Add `APP_CLIENT_ID` and `APP_PRIVATE_KEY`
3. Set repository access to the repositories that use the action

## Verifying the setup

Run the action with `dry-run: true` to verify authentication works:

```yaml
- uses: savvy-web/silk-update-action@v4
  with:
    app-client-id: ${{ vars.APP_CLIENT_ID }}
    app-private-key: ${{ secrets.APP_PRIVATE_KEY }}
    config-dependencies: |
      typescript
    dry-run: true
```

If authentication succeeds, the pre step provisions the installation token without error and the run continues into the main step. If the pre step fails, open its log from the workflow run to see the reason and check:

- The client ID matches the correct App
- The private key is the full PEM content (not a file path)
- The App is installed on the repository
- The required permissions are granted
