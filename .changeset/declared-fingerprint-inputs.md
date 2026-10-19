---
"hot-updater": minor
"@hot-updater/cli-tools": minor
"@hot-updater/expo": minor
"@hot-updater/bare": minor
"@hot-updater/plugin-core": minor
---

Fingerprint Expo apps with Hot Updater's interface engine and drop `@expo/fingerprint`.

- The Expo build adapter now provides its own fingerprint with the bare and Rock adapters' engine. It reads the native packages from Expo's autolinking (React Native CLI on SDKs before 52 or with `EXPO_USE_COMMUNITY_AUTOLINKING=1`), and `jsEngine` and `newArchEnabled` from the app config. It never reads the generated `ios/` and `android/` folders, so `fingerprint create` before `expo prebuild` and the native build after it compute the same fingerprint. Changing `jsEngine` or `newArchEnabled` now changes the fingerprint; it didn't before. `jsEngine` counts as `hermes` when the app config leaves it out, as Expo builds. Config plugins don't count, like edits to a bare app's native projects: bump `fingerprint.nativeVersion` when one changes what JavaScript can call.
- `fingerprint hash` embeds the recorded fingerprint with a warning when the build adapter `fingerprint.json` records is not installed.
- The interface engine no longer reads `Podfile.lock`, which only exists after `pod install` and depends on the machine that ran it. An iOS engine choice made by an environment variable at `pod install` goes through `fingerprint.nativeVersion`.
- `hot-updater` no longer depends on `@expo/fingerprint`. A build adapter without its own fingerprint gets React Native CLI's.
- Expo projects and bare iOS fingerprints change once, so builds made before the upgrade need a rebuild to keep receiving updates.
