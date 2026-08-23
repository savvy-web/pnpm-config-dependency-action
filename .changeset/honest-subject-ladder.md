---
"silk-update-action": patch
---

## Bug Fixes

Fix PR-title mislabeling of devDependencies as "dependencies". The subject
builder's header budget is raised from a self-imposed 72 characters to the 100
that commitlint actually enforces (`header-max-length` via
`@commitlint/config-conventional`), so the accurate typed breakdown
(`upgrade pnpm, update 1 config dependency and 3 devDependencies`) no longer
degrades to the coarse form on the most common run shape. The coarse form
itself is now honest as a last resort: a batch containing non-`dependencies`
sections is lumped as "packages", never as "dependencies", so a
release-neutral devDependency run can no longer read as release-triggering.
