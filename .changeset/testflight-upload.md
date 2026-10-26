---
"hot-updater": minor
"@hot-updater/apple-helper": minor
---

Upload an iOS build to TestFlight with `hot-updater testflight`, the shortcut for `hot-updater build:ios --scheme <scheme> --upload testflight --register`.

- `testflight` runs `build:ios`'s build, registers it unless `--no-register`, and takes `--scheme`, `--json`, and `--output-path`. Without `--scheme`, it builds the one `nativeBuild.ios` scheme TestFlight takes and says which; with several, it asks at a terminal, and in CI or without a terminal it exits listing them for `--scheme`. With none, it says why each scheme is refused and how to add one.

- The upload authenticates with an App Store Connect API key, the scheme's `signing.ascApiKey` or else the `secrets` adapter's `asc-api-key`, which the `HOT_UPDATER_ASC_KEY*` environment variables override. The key is resolved before the build adapter's prebuild and the build, and its temporary file is deleted when the upload ends.
- It uses the App Store Connect API's build uploads: it finds the app by the `.ipa`'s bundle ID, reserves its version and build number, uploads the file in the parts App Store Connect asks for, with only the headers each part lists, commits it, and waits up to 30 minutes for App Store Connect to accept the build, printing the warnings and errors it reports. A build number App Store Connect already has is reported as one to raise.
- Before the prebuild, the CLI refuses a scheme App Store Connect would not take: a simulator build, a Debug configuration, or a scheme that only archives; before the build, export options of another method than App Store Connect.
- `@hot-updater/apple-helper` exports `uploadToTestFlight`, `resolveTestFlightUploadKey`, and `assertTestFlightExportOptions`.
- `build:ios --register` also takes the built-in bundle out of an `.ipa` whose app name contains `[`, `*`, or `?`, which `unzip` read as wildcards.
