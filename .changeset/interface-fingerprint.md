---
"hot-updater": minor
"@hot-updater/bare": minor
"@hot-updater/rock": minor
"@hot-updater/cli-tools": minor
"@hot-updater/plugin-core": minor
---

The bare and Rock build adapters fingerprint the native interface JavaScript calls with Hot Updater's own engine, `hot-updater/interface@1`, instead of `@expo/fingerprint`. The fingerprint covers:
- the React Native version;
- each autolinked native package by name and version, Expo modules included;
- the codegen specs of the app and of local native packages;
- patches to those packages;
- the new `fingerprint.nativeVersion` setting and `extraSources`.

Version and build numbers, native implementation edits, build settings, and JavaScript-only dependencies no longer change it, so OTA updates keep reaching every store build with the same native interface.

This changes the fingerprint of bare and Rock projects once. `doctor` and `deploy` report the change as an engine change. Run `npx hot-updater fingerprint create` and ship new store builds. Builds shipped with the old fingerprint receive no updates until users install a new build.

Build adapters can provide their own fingerprint through `nativeBuild.fingerprint` (`NativeFingerprintProvider` in `@hot-updater/plugin-core`). The Expo adapter keeps using `@expo/fingerprint`.
