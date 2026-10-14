---
"@hot-updater/react-native": patch
"hot-updater": patch
---

Every native build now ships its own build time as `MIN_BUNDLE_ID`, on the same epoch millisecond clock as the bundle IDs `hot-updater deploy` issues, whether it is built in Xcode, with `xcodebuild`, with Gradle, or through the CLI. A bundle deployed before the native build is no longer applied to it on iOS (#1543).

- iOS: a script phase in `HotUpdater.podspec` writes the value into a header before every compile of the pod. It replaces the compile time of `HotUpdater.mm` minus 26 hours, which stayed at the last compile of that file while DerivedData was reused, and the `HOT_UPDATER_MIN_BUNDLE_ID` Info.plist key. The `HOT_UPDATER_MIN_BUNDLE_ID` build setting still wins, and `hot-updater build:ios` no longer adds the Info.plist slot.
- Android: a build task writes the value into a generated source on every build, replacing `BuildConfig.BUILD_TIMESTAMP` and `BuildConfig.MIN_BUNDLE_ID`. `-PMIN_BUNDLE_ID` still wins.
- A `HOT_UPDATER_MIN_BUNDLE_ID` or `MIN_BUNDLE_ID` that is not a UUIDv7 fails the build.

Run `pod install` and rebuild the native app.
