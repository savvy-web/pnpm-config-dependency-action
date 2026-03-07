---
"pnpm-config-dependency-action": patch
---

## Other

Integrate @savvy-web/github-action-effects library to replace duplicated GitHub Actions plumbing code. All action I/O (inputs, outputs, state, logging) now goes through the shared library's Effect services instead of direct @actions/core imports.
