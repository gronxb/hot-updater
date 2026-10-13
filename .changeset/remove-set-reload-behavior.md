---
"@hot-updater/react-native": patch
---

Remove `setReloadBehavior` and the `ReloadBehavior`, `ReloadBehaviorSetting` and `CustomReloadHandler` types. `hotUpdater.reload()` now always restarts the process on Android, the previous default, and reloads React Native in place on iOS. A brownfield app downloads the update without calling `reload()` and lets the next launch load it.
