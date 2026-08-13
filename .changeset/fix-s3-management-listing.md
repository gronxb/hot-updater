---
"@hot-updater/aws": patch
"@hot-updater/cli-tools": patch
"@hot-updater/plugin-core": patch
"@hot-updater/console": patch
"@hot-updater/server": patch
"hot-updater": minor
---

Reduce S3 management query work by excluding storage artifact prefixes, deriving channels from canonical manifest keys, and batching multi-bundle deletion scans and commits. Store new bundle artifacts below `bundles/<bundle-id>`, while preserving reads and cleanup for the legacy root layout. Add `hot-updater storage prune` to find orphaned bundle objects and unreferenced shared assets, with dry-run and minimum-age safeguards.
