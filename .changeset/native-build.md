---
"hot-updater": minor
"@hot-updater/plugin-core": minor
"@hot-updater/android-helper": minor
"@hot-updater/apple-helper": minor
---

`build:android`, `build:ios`, `run:android`, and `run:ios` are available without `EXPERIMENTAL`. A build returns and prints the artifact (`.apk`, `.aab`, `.ipa`, or simulator `.app`) with the values compiled into it: the MIN_BUNDLE_ID, the fingerprint hash or app version, and the default channel (an iOS build reads the app version and channel from the built app's Info.plist). The build adapter's `prebuild`, such as `expo prebuild`, now runs before the commands read the native projects, and `run:*` runs the adapter's `prebuild` and `postbuild` too. The CLI issues each MIN_BUNDLE_ID with a platform byte and random bits after the build's millisecond, so an iOS and an Android build never share one, and two builds of one platform get different ones even in the same millisecond.

A `nativeBuild` scheme signs with a credential the CLI resolves while it builds: `signing: { keystore }` on Android passes an `android-keystore` to Gradle as the injected signing properties of release variants, and `signing: { ascApiKey }` on iOS signs device builds with automatic signing through an `asc-api-key`. Debug variants and simulator builds resolve nothing. An iOS device build always exports an `.ipa`: with `signing.ascApiKey` and no `exportOptionsPlist`, it exports for App Store Connect, and without either it fails before archiving. The unused `--message` option of `build:*` and `run:*` and `--app-id-suffix` of `run:android` are removed.
