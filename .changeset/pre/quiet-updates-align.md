---
"@hot-updater/react-native": patch
"@hot-updater/console": patch
"hot-updater": patch
---

Align the console ID, `HotUpdater.getBundleId()`, update-check results, completion callbacks, and `bundle list/show` with the selected update identity so promotions sharing an artifact remain distinguishable. The getter can reflect a staged update before reload. Remove the prerelease `getReleaseId()` getter, keep artifact and crash identities unchanged, and move Artifact IDs into Advanced diagnostics. `bundle list --json` returns the internal rows, and `bundle show` accepts the console ID. Use `HotUpdater.getManifest().bundleId` for BugSnag sourcemap matching.
