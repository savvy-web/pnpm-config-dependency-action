---
"silk-update-action": patch
---

## Dependencies

| Dependency                        | Type          | Action  | From    | To      |
| :-------------------------------- | :------------ | :------ | :------ | :------ |
| @effected/commands                | dependency    | updated | ^0.1.0  | ^0.2.0  |
| @effected/github                  | dependency    | updated | ^0.1.0  | ^0.2.1  |
| @effected/github-actions          | dependency    | updated | ^0.1.0  | ^0.4.0  |
| @effected/lockfiles               | dependency    | updated | ^0.2.1  | ^0.3.0  |
| @effected/npm                     | dependency    | updated | ^0.5.0  | ^0.8.0  |
| @effected/runtimes                | dependency    | updated | ^0.2.0  | ^0.2.2  |
| @effected/semver                  | dependency    | updated | ^0.2.1  | ^0.3.0  |
| @effected/workspaces              | dependency    | updated | ^0.9.0  | ^0.9.3  |
| @savvy-web/silk-effects           | dependency    | updated | ^5.0.0  | ^5.2.0  |
| @savvy-web/github-action-builder  | devDependency | updated | ^2.1.0  | ^2.2.0  |
| @savvy-web/silk                   | devDependency | updated | ^3.2.5  | ^3.3.0  |
| @vitest-agent/plugin              | devDependency | updated | ^2.0.9  | ^2.0.11 |
| pnpm                              | config        | updated | 11.17.0 | 11.19.0 |

## Maintenance

* Moves the `@effected` kit and `@savvy-web/silk-effects` to their current releases, with no action input, output or behavior changes
* Bumps the pinned pnpm version to 11.19.0 in `packageManager` and `devEngines.packageManager`

## Tests

* Adds `headSha` and `baseSha` to the pull-request test doubles, which `@effected/github` 0.2.1 made required fields of `PullRequestInfo`
* Silences the Effect logger in the suites that do not assert on their own log output, so a test run no longer writes stray log lines to the console
