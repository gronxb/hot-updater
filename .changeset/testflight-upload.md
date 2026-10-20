---
"hot-updater": minor
"@hot-updater/apple-helper": minor
---

Upload an iOS build to TestFlight with `hot-updater build:ios --upload testflight`.

- The upload authenticates with an App Store Connect API key, the scheme's `signing.ascApiKey` or else the vault's `asc-api-key`, which the `HOT_UPDATER_ASC_KEY*` environment variables override. The key is resolved before the build adapter's prebuild and the build, and its temporary file is deleted when the upload ends.
- It uses the App Store Connect API's build uploads: it finds the app by the `.ipa`'s bundle ID, reserves its version and build number, uploads the file in the parts App Store Connect asks for, with only the headers each part lists, commits it, and waits up to 30 minutes for App Store Connect to accept the build, printing the warnings and errors it reports. A build number App Store Connect already has is reported as one to raise.
- Before the prebuild, the CLI refuses a scheme App Store Connect would not take: a simulator build, a Debug configuration, export options of another method than App Store Connect, or a scheme that only archives.
- `@hot-updater/apple-helper` exports `uploadToTestFlight` and `resolveTestFlightUploadKey`.
