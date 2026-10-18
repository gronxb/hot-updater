---
"hot-updater": minor
"@hot-updater/cli-tools": minor
"@hot-updater/expo": minor
"@hot-updater/bare": minor
"@hot-updater/plugin-core": minor
---

Fingerprint Expo apps with Hot Updater's interface engine and drop `@expo/fingerprint`.

- The Expo build adapter now provides its own fingerprint. It reads the native packages from Expo's autolinking, and `jsEngine`, `newArchEnabled`, and the config plugins (with their options and versions) from the app config. It never reads the generated `ios/` and `android/` folders, so `fingerprint create` before `expo prebuild` and the native build after it compute the same fingerprint. Changing `jsEngine` or `newArchEnabled` in the app config now changes the fingerprint; it didn't before.
- The interface engine no longer reads `Podfile.lock`, which only exists after `pod install` and depends on the machine that ran it. An iOS engine choice made by an environment variable at `pod install` goes through `fingerprint.nativeVersion`.
- `hot-updater` no longer depends on `@expo/fingerprint`. A build adapter without its own fingerprint gets React Native CLI's.
- Expo projects and bare iOS fingerprints change once, so builds made before the upgrade need a rebuild to keep receiving updates.
