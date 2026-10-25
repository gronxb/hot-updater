---
"hot-updater": patch
---

`hot-updater doctor` now looks for `HotUpdater.bundleURL()` in `SceneDelegate` as well as `AppDelegate`, so apps that host React in a SceneDelegate are no longer reported as missing the iOS bundle provider.
