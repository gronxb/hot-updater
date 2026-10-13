---
"@hot-updater/react-native": patch
"@hot-updater/protocol": patch
---

Add native update checks for brownfield apps, which start React Native from an existing native app. `HotUpdater.prepare` (Swift and Kotlin) checks for an update before React Native starts: a required update that stages within its deadline runs at this start, and anything else applies at the next one. It returns `upToDate`, `ready`, `pending`, or `failed`, and never throws. `HotUpdater.checkForUpdate`, `update.updateBundle(onProgress:)`, and `HotUpdater.resetChannel` cover custom flows. The next `HotUpdater.init` reports the native checks' `onUpdateCheck`, `onBundleDownloaded`, and `onUpdateError` events to its plugins, with the time each happened as `occurredAt`.
