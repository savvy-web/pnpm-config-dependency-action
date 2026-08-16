---
"silk-update-action": patch
---

## Bug Fixes

Fixes a startup failure introduced in 4.6.0 that failed **every run, in every
consumer repository**, immediately in the main phase — before the check run
was even created, so the GitHub UI showed nothing useful beyond a red job:

```text
Service not found: @effected/package-json/PackageJsonFile
```

The application layer provided the `PackageJsonFile` service to only one of
the two consumers that needed it, so the service graph failed to build and
the run died as an unhandled defect roughly 30ms in. If you're tracking the
`@v4` alias tag, taking this release fixes it automatically; if you're pinned
to `4.6.0` exactly, upgrade to pick up the fix.

* Adds a compile-time guard that fails the build if the application layer is
  ever again composed with a service it doesn't provide, naming the missing
  service directly in the error.
