---
"hot-updater": minor
"@hot-updater/cli-tools": minor
"@hot-updater/expo": minor
"@hot-updater/bare": minor
"@hot-updater/plugin-core": minor
---

Fingerprint Expo apps with Hot Updater's interface engine and drop `@expo/fingerprint`.

- The Expo build adapter now provides its own fingerprint. It reads the native packages from Expo's autolinking, and `jsEngine`, `newArchEnabled`, and the config plugins (with their options and versions) from the app config. It never reads the generated `ios/` and `android/` folders, so `fingerprint create` before `expo prebuild` and the native build after it compute the same fingerprint. Changing `jsEngine` or `newArchEnabled` in the app config now changes the fingerprint; it didn't before.
- A registry config plugin counts by its version and patches. A plugin from the project or a workspace counts by its name, not its code, as the bare adapter treats edits to `ios/` and `android/`; bump `fingerprint.nativeVersion`, or list its folder in `extraSources`, when a change to it alters what JavaScript can call.
- Hot Updater's own Expo plugin is recognized however the app config names it (the package, a path into it, or its function), so its channel never changes the fingerprint and its `publicKeyPath` always reaches bundle signing.
- `fingerprint hash` embeds the recorded fingerprint with a warning when the build adapter `fingerprint.json` records is not installed.
- The interface engine no longer reads `Podfile.lock`, which only exists after `pod install` and depends on the machine that ran it. An iOS engine choice made by an environment variable at `pod install` goes through `fingerprint.nativeVersion`.
- `hot-updater` no longer depends on `@expo/fingerprint`. A build adapter without its own fingerprint gets React Native CLI's.
- Expo projects and bare iOS fingerprints change once, so builds made before the upgrade need a rebuild to keep receiving updates.
