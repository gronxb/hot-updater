---
"@hot-updater/server": patch
"@hot-updater/standalone": patch
---

A standalone server's bundle count reads only the counter row. Admin API protocol 2 gains `GET /bundles/count` (`platform` optional), and `standaloneRepository` counts through it instead of listing one bundle, with its patches, to read `total`.
