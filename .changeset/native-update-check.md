---
"@hot-updater/react-native": patch
"@hot-updater/protocol": patch
"@hot-updater/plugin-insights": patch
---

Add native update checks for brownfield apps, which start React Native from an existing native app. `HotUpdater.prepare` (Swift and Kotlin) checks for an update before React Native starts: a required update that stages within its deadline runs at this start, and anything else applies at the first start after it is staged. It returns `upToDate`, `ready`, `pending`, or `failed`, and never throws; the first start after an update is `upToDate`. `HotUpdater.checkForUpdate`, `update.updateBundle(onProgress:)`, and `HotUpdater.resetChannel` cover custom flows. A channel reset, from JavaScript or native code, waits for a native check or download in progress, which would otherwise save its channel again. On iOS, `HotUpdaterCheckOptions(bundle:)` names the framework bundle that holds the embedded bundle and the `HOT_UPDATER_*` keys, so a check that runs before React Native starts reads the framework's values rather than the app's. The brownfield guide now starts React Native after `prepare`. The next `HotUpdater.init` reports the native checks' `onUpdateCheck`, `onBundleDownloaded`, and `onUpdateError` events to its plugins, with the time each happened as `occurredAt`, and Insights dates a replayed download or failure by that time.
