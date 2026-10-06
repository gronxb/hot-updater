---
"@hot-updater/react-native": patch
---

Build the Android library for the New Architecture unless the app sets `newArchEnabled=false`, and read that setting from the library project. React Native 0.82 and later run only the New Architecture and set it to `true` there, so an app that still has `newArchEnabled=false` in `gradle.properties`, or has no such line, no longer gets the old architecture build, whose crash recovery asked the app for a `ReactNativeHost` that throws when the app has none. `ReactNativeHost` code now builds only for the React Native versions that use it: the old architecture, and the bridge that React Native 0.81 and older can run the New Architecture on. Builds for React Native 0.82 and later no longer compile against `ReactNativeHost`, which React Native deprecates for removal. An app on React Native 0.81 or older that runs the old architecture keeps `newArchEnabled=false` in `gradle.properties`, as its template has. Requires rebuilding the native app.
