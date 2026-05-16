---
"@hot-updater/server": minor
"@hot-updater/react-native": patch
---

Harden self-hosted bundle management and native bundle extraction.

Bundle management routes are now disabled by default and require an
authorization hook when enabled. Bundle list requests also validate `limit`
against a bounded range.

Android and iOS bundle extraction now reject unsafe archive entries and
manifest asset paths before writing or reusing files.
