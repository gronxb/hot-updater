---
"@hot-updater/react-native": minor
"hot-updater": minor
"@hot-updater/bare": minor
"@hot-updater/rock": minor
"@hot-updater/expo": minor
---

Native builds embed their own fingerprint. A build step in the HotUpdater pod (or its Swift Package Manager plugin) and in the Android library writes the fingerprint into the binary before compiling, so a binary always carries the fingerprint of the native interface it was built from. `fingerprint create` no longer writes `HOT_UPDATER_FINGERPRINT_HASH` into `Info.plist` or `com.hotupdater.FINGERPRINT_HASH` into `AndroidManifest.xml`, and the native SDK no longer reads them.

- `fingerprint.json` records the inputs each fingerprint came from: the build adapter and its fingerprint settings.
- A Release build runs the new `npx hot-updater fingerprint hash -p <platform>`. It computes the fingerprint from those inputs without loading `hot-updater.config.ts`, so build machines need no deploy secrets.
- A Debug build uses the hash `fingerprint.json` holds.
- A `fingerprint.json` without `inputs`, written by an earlier `hot-updater`, is embedded as recorded with a warning, as is one whose build adapter is installed in a version without the new fingerprint export, so upgrading the React Native package alone doesn't break release builds.
- The reverse, a `@hot-updater/react-native` that still reads the fingerprint from `Info.plist` and `AndroidManifest.xml`, makes `fingerprint create`, `deploy`, `doctor`, and the Expo config plugin stop and ask you to update it, instead of building an app with a stale fingerprint.
- When the project changed after `fingerprint create`, the build still embeds the fingerprint it was built from and warns that `fingerprint.json` is stale.
- An app without `fingerprint.json` builds with no fingerprint, as the appVersion strategy expects. Under appVersion, `doctor` reports a leftover `fingerprint.json` as `FINGERPRINT_JSON_UNUSED` (`doctor --fix` deletes it), `deploy` warns about it, the native build commands refuse to build, and the Expo config plugin removes it at prebuild.
- Swift Package Manager builds always compute the fingerprint, since a package build plugin can't tell Debug from Release.
- Set `HOT_UPDATER_APP_ROOT` (an Xcode build setting or environment variable, or a Gradle property) when the native projects are not in `<app>/ios` and `<app>/android`.
- `HotUpdaterConfig`'s `fingerprintHash` and an instance's `HotUpdaterOptions.fingerprintHash` still take precedence over the embedded fingerprint. Named instances use the embedded fingerprint too, since every bundle comes from the project the build fingerprinted.

doctor drops `MISSING_FINGERPRINT_HASH` and `FINGERPRINT_HASH_MISMATCH`, and the Expo config plugin writes `fingerprint.json` without injecting the hash.
