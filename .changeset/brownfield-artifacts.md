---
"@hot-updater/react-native": patch
"hot-updater": patch
---

Fix OTA updates in brownfield apps that ship React Native as an XCFramework or AAR.

- iOS: the bundle passed to `HotUpdater.bundleURL(bundle:)` now also serves reloads and crash recovery, so a rollback finds the XCFramework's embedded `main.jsbundle` and assets. Hot Updater reads `HOT_UPDATER_CHANNEL`, `HOT_UPDATER_FINGERPRINT_HASH`, `HOT_UPDATER_PUBLIC_KEY` and `HOT_UPDATER_MIN_BUNDLE_ID` from that bundle's `Info.plist` before the app's, and a runtime channel switch now outranks `HotUpdater.configure(channel:)`, as on Android.
- Android: the Brotli decoder compiles into the SDK instead of a bundled jar, which AAR packaging dropped, so downloading an update no longer crashes a brownfield app with `NoClassDefFoundError`.
- Android: an update applied with `setReloadBehavior("reload")` now completes its launch when its first screen appears, on the New Architecture, the old architecture, and the bridge of React Native 0.81 and older. Before, the next cold start rolled the working update back as an unfinished launch.
- Android: a launch counts as able to show UI once a started activity shows a React Native view, not when any activity starts. A brownfield app that loads React Native with a native screen, and that the user closes without opening a React Native screen, keeps its update on the next start.
- CLI: `channel set`, `fingerprint create` and `keys export-public` write into an empty `<application />` element, such as a brownfield library module's manifest.
