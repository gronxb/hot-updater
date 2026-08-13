---
"@hot-updater/aws": patch
"@hot-updater/cli-tools": patch
"@hot-updater/plugin-core": patch
"@hot-updater/console": patch
"@hot-updater/server": patch
"hot-updater": minor
---

Reduce S3 management query work by skipping legacy UUIDv7 artifact traversal, deriving channels from canonical manifest keys, and batching multi-bundle deletion scans and commits. Store new bundle artifacts below `bundles/<bundle-id>` while preserving legacy reads, and add exact target app version filters to the CLI and Console. Add an exclusive-maintenance `hot-updater storage prune` command for orphaned bundle objects and unreferenced shared assets, with dry-run, minimum-age, and fail-closed reference validation safeguards.
