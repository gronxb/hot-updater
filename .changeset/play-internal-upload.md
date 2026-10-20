---
"hot-updater": minor
"@hot-updater/android-helper": minor
---

Upload an Android build to Google Play's internal testing track with `hot-updater build:android --upload play-internal`.

- The upload authenticates with the vault's `play-service-account`, which `HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH` or `HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON` overrides. It is resolved before the build adapter's prebuild and the build, and stays in memory: the CLI writes the service account to no file, signs its token assertion in memory, and masks the private key and access token in its output.
- It uses the Google Play Developer API: it opens an edit, uploads the `.aab` in a resumable upload one chunk at a time, releases its version code to the `internal` track, and commits the edit, deleting it when any step fails. The package name is the `.aab`'s, read with `aapt2`, or else the scheme's `applicationId`.
- On an app Play Console has not published, the release is a draft; when the app's state requires it, the edit is committed without sending the changes for review. A taken version code, a missing app, and a service account without access are reported with what to change.
- Before the prebuild, the CLI refuses a scheme Google Play would not take as a release: an `.apk` or a debug variant.
- `@hot-updater/android-helper` exports `uploadToPlay`, `resolvePlayUploadServiceAccount`, and `readBuiltPackageName`.
