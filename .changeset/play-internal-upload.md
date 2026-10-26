---
"hot-updater": minor
"@hot-updater/android-helper": minor
---

Upload an Android build to Google Play's internal testing track with `hot-updater native-build android --submit play-internal`, or its shortcut `hot-updater google-play upload`.

- `google-play upload` runs `native-build android`'s build, which tracks it, and takes only `--scheme`: any other option or argument exits 1 naming the full command. Without `--scheme`, it builds the one `nativeBuild.android` scheme Google Play takes (an `.aab`, not a `Debug` variant) and says which; with several, it asks at a terminal, and in CI or without a terminal it exits listing them with the full command. With none, it says why each scheme is refused and how to add one.

- The upload authenticates with the `secrets` adapter's `play-service-account`, which `HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH` or `HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON` overrides. It is resolved before the build adapter's prebuild and the build, and stays in memory: the CLI writes the service account to no file, signs its token assertion in memory, and masks the private key and access token in its output.
- It uses the Google Play Developer API: it opens an edit, uploads the `.aab` in a resumable upload one chunk at a time, releases its version code to the `internal` track, and commits the edit, deleting it when any step fails. The package name is the `.aab`'s, read with `aapt2`, or else the scheme's `applicationId`.
- On an app Play Console has not published, the release is a draft; when the app's state requires it, the edit is committed without sending the changes for review. A taken version code, a missing app, and a service account without access are reported with what to change.
- Before the prebuild, the CLI refuses a scheme Google Play would not take as a release: an `.apk` or a debug variant. Before it uploads, it refuses an `.aab` signed with the Android debug keystore, which Google Play refuses, read with the JDK's `keytool`.
- `@hot-updater/android-helper` exports `uploadToPlay`, `resolvePlayUploadServiceAccount`, `assertPlaySigned`, and `readBuiltPackageName`.
