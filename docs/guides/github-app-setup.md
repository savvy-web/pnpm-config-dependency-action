# GitHub App Setup

This guide explains how to create and configure the GitHub App required by the
pnpm Config Dependency Action.

## Table of Contents

- [Why a GitHub App?](#why-a-github-app)
- [Step 1: Create the App](#step-1-create-the-app)
- [Step 2: Configure Permissions](#step-2-configure-permissions)
- [Step 3: Generate a Private Key](#step-3-generate-a-private-key)
- [Step 4: Install the App](#step-4-install-the-app)
- [Step 5: Store Secrets](#step-5-store-secrets)

## Why a GitHub App?

The action uses GitHub App authentication instead of personal access tokens
(PATs) for several reasons:

- **Short-lived tokens**: Installation tokens expire after 1 hour, reducing the
  window of exposure if leaked
- **Fine-grained permissions**: Only the permissions the action needs are
  granted, nothing more
- **Verified commits**: Commits created through the GitHub API with an App token
  are automatically signed and marked as "Verified"
- **No user dependency**: The App is not tied to any individual user account
- **Audit trail**: All actions are attributed to the App, making it easy to
  track automated changes

## Step 1: Create the App

1. Go to **Settings > Developer settings > GitHub Apps**
2. Click **New GitHub App**
3. Fill in the required fields:
   - **Name**: Choose a descriptive name (e.g., `my-org-dep-updater`)
   - **Homepage URL**: Your repository URL
   - **Webhook**: Uncheck "Active" (this app does not need webhooks)
4. Click **Create GitHub App**
5. Note the **App ID** shown on the settings page

## Step 2: Configure Permissions

Under **Permissions & events**, set the following repository permissions:

| Permission | Access | Purpose |
| --- | --- | --- |
| Contents | Read & write | Push commits, create/delete branches |
| Pull requests | Read & write | Create and update PRs |
| Checks | Read & write | Create check runs for status visibility |

No organization or account permissions are needed. No webhook events need to be
subscribed to.

## Step 3: Generate a Private Key

1. On the App settings page, scroll to **Private keys**
2. Click **Generate a private key**
3. A `.pem` file will download automatically
4. Store this file securely -- it is used to authenticate as the App

The private key content (including the `-----BEGIN RSA PRIVATE KEY-----` and
`-----END RSA PRIVATE KEY-----` markers) is what you will store as a secret.

## Step 4: Install the App

1. On the App settings page, click **Install App** in the sidebar
2. Choose the organization or account
3. Select **Only select repositories** and choose the repositories that need
   dependency updates
4. Click **Install**

The App must be installed on every repository where you plan to use the action.

## Step 5: Store Secrets

Add the App credentials as GitHub Actions secrets:

### Repository-level secrets

1. Go to the target repository
2. Navigate to **Settings > Secrets and variables > Actions**
3. Click **New repository secret**
4. Add `APP_ID` with the App ID from Step 1
5. Add `APP_PRIVATE_KEY` with the full contents of the `.pem` file from Step 3

### Organization-level secrets (recommended for multiple repos)

1. Go to **Organization Settings > Secrets and variables > Actions**
2. Add `APP_ID` and `APP_PRIVATE_KEY`
3. Set repository access to the repositories that use the action

## Verifying the Setup

Run the action with `dry-run: true` to verify authentication works:

```yaml
- uses: savvy-web/pnpm-config-dependency-action@main
  with:
    app-id: ${{ secrets.APP_ID }}
    app-private-key: ${{ secrets.APP_PRIVATE_KEY }}
    config-dependencies: |
      typescript
    dry-run: true
```

If authentication succeeds, the workflow log will show:

```text
Token generated for app "your-app-name" (expires: ...)
```

If it fails, check:

- The App ID matches the correct App
- The private key is the full PEM content (not a file path)
- The App is installed on the repository
- The required permissions are granted
