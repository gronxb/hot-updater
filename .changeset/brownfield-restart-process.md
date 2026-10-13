---
"@hot-updater/react-native": patch
---

Keep Hot Updater's restart process on Android from taking over the next launch. Android runs `Application.onCreate` in that process too, so a brownfield app that starts React Native there prepared a launch in it: it consumed the crash marker and launch state before the relaunched app could. `HotUpdater.getJSBundleFile` now returns the embedded bundle there without touching that state, and `HotUpdater.prepare` returns `Failed` there. The brownfield guide starts React Native only in the main process. Requires rebuilding the native app.
