---
"hot-updater": minor
"@hot-updater/apple-helper": minor
"@hot-updater/android-helper": minor
"@hot-updater/console": minor
---

Preview a pull request through TestFlight internal testing or Google Play's internal track, with the preview action's `ios-submit: testflight` and `android-submit: play-internal` on a sandbox scheme. Nothing changes for a preview that sets neither.

- The store build lives on the sandbox scheme's channel, so pull requests with the same fingerprint share it, with no new upload. The bundle deploys to the pull request's channel.
- The comment shows the store's link and state in place of **Download**. New outputs: `android-store-url`, `ios-store-url`, `android-store-state`, `ios-store-state`, and `store` in `previews`.
- `native-build find --store-status` asks the store for a submitted build's state. A TestFlight build near its expiry, or a Google Play build a newer release replaced, gets a new build.
- `native-build ios --testflight-group <name> --what-to-test <text>` adds a sandbox build to an internal TestFlight group and sets its What to Test. An external group stops the build before it starts.
- A sandbox `.aab`'s version code follows Google Play, as a sandbox `.ipa`'s build number follows App Store Connect, and a cached sandbox build the store may already hold gets a new number.
- The Console's Install card leads with the store for a build a store took, in place of its QR code.
