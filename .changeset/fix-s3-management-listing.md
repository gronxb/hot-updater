---
"@hot-updater/aws": patch
"@hot-updater/plugin-core": patch
"@hot-updater/console": patch
"hot-updater": patch
---

Reduce S3 management query work by excluding bundle artifact prefixes, deriving channels from canonical manifest keys, and batching multi-bundle deletion scans and commits.
