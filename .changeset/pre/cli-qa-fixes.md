---
"hot-updater": patch
"@hot-updater/cli-tools": patch
"@hot-updater/plugin-core": patch
"@hot-updater/server": patch
"@hot-updater/standalone": patch
"@hot-updater/expo": patch
"@hot-updater/test-utils": patch
---

CLI prompts refuse to ask without a terminal instead of waiting: `keys export-public` names `-y` and `-p`, `keys remove`, `db migrate`, `db generate`, and `native-build ios|android` without `--scheme` name the option that skips the prompt, and every other prompt fails with an error. `native-build find` no longer runs the build adapter's prebuild, so a lookup leaves `ios/` and `android/` as they are: the Expo adapter reports the app version and channel `expo prebuild` would write from the Expo config (`nativeBuild.getNativeProjectValues`), and other adapters' native projects are read as they are. `hot-updater native-build delete <id>` deletes a registered native build, its built-in bundle, and its stored artifact, through core's new `deleteNativeBuild` and the admin API's `DELETE /native-builds/:id`.
