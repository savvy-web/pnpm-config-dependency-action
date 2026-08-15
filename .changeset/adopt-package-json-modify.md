---
"silk-update-action": minor
---

## Bug Fixes

* Runtime and package-manager version bumps are now written as surgical edits to `package.json` instead of re-serializing the whole file. Key order, indentation and line endings are preserved byte-for-byte, so the diff this action opens against your repository shows only the field it actually changed. Previously the manifest was rewritten from the parsed object with a guessed indent, which could reformat regions the run never intended to touch.
* A write is skipped entirely when the result would be byte-identical to what was read.

## Dependencies

| Dependency | Type | Action | From | To |
| :--------- | :--- | :----- | :--- | :-- |
| @effected/package-json | dependency | added | — | 0.9.0 |

Adopted for `PackageJsonFile.modify` only, which is decode-free: it reads, applies each field edit through the JSONC engine, and writes. The schema-decoding read path is deliberately **not** used, because it rejects manifests this action must still be able to edit — a private workspace root with no `name`/`version`, and a non-semver `version` such as `"1.0"`, are both legal in a package nobody publishes.
