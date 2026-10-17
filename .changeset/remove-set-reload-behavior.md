---
"@hot-updater/react-native": minor
---

Remove `setReloadBehavior` and the `ReloadBehavior`, `ReloadBehaviorSetting` and `CustomReloadHandler` types. `hotUpdater.reload()` always restarts the process on Android, the previous default, and reloads React Native in place on iOS. The in-place React Native reload is gone on Android too: JavaScript from an earlier release that set `setReloadBehavior("reload")` restarts the process once it runs on this native code. A brownfield app downloads the update without calling `reload()` and lets the next launch load it.

Android hosts that called the Kotlin `HotUpdater.reload(context)` must remove the call, since the Kotlin API no longer has one; the update applies at the next launch. Rebuild the native app to pick up these changes.
