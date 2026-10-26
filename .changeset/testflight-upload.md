---
"hot-updater": minor
"@hot-updater/apple-helper": minor
---

Upload an iOS build to TestFlight with `hot-updater native-build ios --submit testflight`, or its shortcut `hot-updater testflight`.

- `testflight` runs `native-build ios`'s build, which tracks it, and takes only `--scheme`: any other option or argument exits 1 naming the full command. Without `--scheme`, it builds the one `nativeBuild.ios` scheme TestFlight takes and says which; with several, it asks at a terminal, and in CI or without a terminal it exits listing them with the full command. With none, it says why each scheme is refused and how to add one.

- The upload authenticates with an App Store Connect API key, the scheme's `signing.ascApiKey` or else the `secrets` adapter's `asc-api-key`, which the `HOT_UPDATER_ASC_KEY*` environment variables override. The key is resolved before the build adapter's prebuild and the build, and its temporary file is deleted when the upload ends.
- It uses the App Store Connect API's build uploads: it finds the app by the `.ipa`'s bundle ID, reserves its version and build number, uploads the file in the parts App Store Connect asks for, with only the headers each part lists, commits it, and waits up to 30 minutes for App Store Connect to accept the build, printing the warnings and errors it reports. A build number App Store Connect already has is reported as one to raise.
- Before the prebuild, the CLI refuses, saying why, a scheme App Store Connect would not take: a simulator build, a Debug configuration, code signing turned off (`CODE_SIGNING_ALLOWED` or `CODE_SIGNING_REQUIRED` left `NO` after the overrides the build applies: `extraParams` settings, then the scheme's `xcconfig` and each `-xcconfig` in `extraParams`, resolved from `ios/` with their `#include`s, last assignment winning), a scheme that only archives, or an `exportOptionsPlist` of another method than App Store Connect; one the prebuild writes is checked before the build. `testflight` skips such schemes when it picks one.
- `@hot-updater/apple-helper` exports `uploadToTestFlight`, `resolveTestFlightUploadKey`, and `assertTestFlightExportOptions`.
- Tracking also takes the built-in bundle out of an `.ipa` whose app name contains `[`, `*`, or `?`, which `unzip` read as wildcards.
