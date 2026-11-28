---
"@hot-updater/react-native": patch
---

Keep what Android crash recovery reads by reflection from R8: `BridgelessReactContext`'s host, and `ReactRootViewTagGenerator` with its root view tag counter. In a minified release build of an app with named instances, R8 renamed them, so a named instance's fatal JavaScript error on the New Architecture skipped crash recovery, and a crash couldn't be attributed to the instance on screen. Apps need no ProGuard rules of their own: the library's consumer rules cover everything it reads by reflection.
