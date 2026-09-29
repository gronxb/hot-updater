---
"@hot-updater/plugin-core": patch
"@hot-updater/server": patch
"@hot-updater/standalone": patch
"@hot-updater/console": patch
---

Bundle child counts come from each base bundle's reference counter alone. `HotUpdaterCoreApi` gains `countBundleChildren(ids)`, which reads the bundle rows in one batch and no patches, and admin API protocol 2 gains `GET /bundles/child-counts?ids=...` (1 to 100 IDs) for a standalone server. The console's patch counts use it instead of reading each bundle with its own patches.
