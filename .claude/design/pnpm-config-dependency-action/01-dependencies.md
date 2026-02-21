# Dependencies

[Back to index](./_index.md)

## Runtime Dependencies (bundled into action)

```json
{
 "dependencies": {
  "@actions/core": "^3.0.0",
  "@actions/exec": "^3.0.0",
  "@actions/github": "^9.0.0",
  "@actions/glob": "^0.6.1",
  "@actions/http-client": "^4.0.0",
  "@actions/io": "^3.0.2",
  "@octokit/auth-app": "^8.1.2",
  "@octokit/rest": "^22.0.1",
  "@pnpm/catalogs.config": "^1.0.0",
  "@pnpm/catalogs.protocol-parser": "^1.0.0",
  "@pnpm/lockfile.fs": "^10.0.0",
  "@pnpm/lockfile.types": "^8.0.0",
  "@pnpm/workspace.read-manifest": "^6.0.0",
  "effect": "^3.0.0",
  "workspace-tools": "^0.40.0",
  "yaml": "^2.6.0",
  "semver": "^7.7.4"
 }
}
```

## Key Packages

- `@actions/core` - Logging, inputs, outputs, **state persistence between phases**
- `@actions/exec` - Execute shell commands (pnpm, git)
- `@actions/github` - GitHub context and Octokit client
- `@octokit/auth-app` - GitHub App JWT and installation token generation
- `effect` - Typed error handling, retry logic, resource management
- `yaml` - Parse and stringify `pnpm-workspace.yaml` with consistent formatting
- `semver` - Semantic version parsing, comparison, and range resolution for pnpm self-upgrade

## pnpm Official Packages (for lockfile/workspace analysis)

- `@pnpm/lockfile.fs` - Read/write `pnpm-lock.yaml`
  - `readWantedLockfile(pkgPath, opts)` - Read lockfile, get `LockfileObject`
  - Returns catalogs, packages, importers for diff comparison
- `@pnpm/lockfile.types` - TypeScript types for lockfile structures
  - `LockfileObject`, `CatalogSnapshots`, `ProjectSnapshot`
- `@pnpm/catalogs.config` - Extract catalogs from workspace manifest
  - `getCatalogsFromWorkspaceManifest(manifest)`
- `@pnpm/catalogs.protocol-parser` - Parse `catalog:` protocol references
  - `parseCatalogProtocol(version)` - Returns catalog name or null
- `@pnpm/workspace.read-manifest` - Read `pnpm-workspace.yaml`
  - `readWorkspaceManifest(workspaceRoot)`

## workspace-tools (Microsoft)

- `getWorkspaceManagerAndRoot(cwd)` - Detect pnpm/yarn/npm and workspace root
- `getWorkspaceInfos(cwd)` / `getWorkspaceInfosAsync(cwd)` - Get all package info
- `getWorkspacePackagePaths(cwd)` - Get paths to all workspace packages
- `getCatalogs(root, manager)` - Get catalogs for pnpm/yarn
