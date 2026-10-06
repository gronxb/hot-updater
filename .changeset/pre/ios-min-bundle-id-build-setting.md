---
"@hot-updater/react-native": patch
---

Read the iOS built-in bundle ID from the `HOT_UPDATER_MIN_BUNDLE_ID` build setting. The CLI passes that setting to `xcodebuild` and adds the `$(HOT_UPDATER_MIN_BUNDLE_ID)` slot to `Info.plist`, as Android takes `-PMIN_BUNDLE_ID`, but the native module read `HOT_UPDATER_BUILD_TIMESTAMP`, so iOS always fell back to the time `HotUpdater.mm` was compiled. A value that is not a UUID is ignored with a warning, and an unset build setting still falls back to the compile time. Requires rebuilding the native app.
