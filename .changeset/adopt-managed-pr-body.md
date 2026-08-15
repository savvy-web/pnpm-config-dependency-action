---
"silk-update-action": minor
---

## Features

* The pull request description is now written through the shared `silk-release` managed-region contract. Everything the action generates lives between the managed markers and is regenerated each run; **anything you write outside those markers survives**. Previously the whole description was overwritten on every run, so a review note added to the PR body was silently destroyed by the next dependency update.

## Bug Fixes

* The DCO signoff in the proposed squash-commit block and the one in the commit message are now rendered from a single function, so the two cannot drift apart and name different authors for the same eventual commit.
