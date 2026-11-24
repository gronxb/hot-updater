---
"@hot-updater/protocol": patch
"@hot-updater/react-native": patch
"@hot-updater/plugin-insights": patch
"@hot-updater/test-utils": patch
"hot-updater": patch
---

Name artifact IDs `bundleId` and release IDs `releaseId` in code. `ReleaseSelectionInput` and `ReleaseSelectionContextInput` in `@hot-updater/protocol` take the built-in bundle's ID as `minBundleId` instead of `minimumReleaseId`, as the React Native SDK and its iOS and Android code now name it, and the rollout functions name their first parameter `releaseId`, the ID they hash. A selection context hash is unchanged: its canonical JSON keeps the key `minimumReleaseId`, so receipts written by any patch still match. In `@hot-updater/plugin-insights`, the reads take and return a bundle's release ID as `releaseId` (`InsightsBundleSelection`, `getReportingOverview`'s input, and `ReportingOverview`'s `bundle`), while the HTTP API and `hot-updater insights overview --json` still call it `bundleId`; `toWireOverview` maps an overview to that shape. The docs call the release ID the bundle ID everywhere, and an artifact's ID the artifact ID.
