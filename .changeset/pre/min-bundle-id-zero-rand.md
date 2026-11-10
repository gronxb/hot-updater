---
"hot-updater": patch
"@hot-updater/cli-tools": patch
"@hot-updater/android-helper": patch
"@hot-updater/apple-helper": patch
---

`hot-updater native-build ios|android`, and `buildAndroid` and `buildIos` without a `minBundleId`, issue the MIN_BUNDLE_ID the SDK's podspec script phase and Gradle task generate: the UUIDv7 of the build's millisecond with all-zero random bits (`<ts>-<ts>-7000-8000-000000000000`), instead of a platform byte and random bits. `createMinBundleId(nowMs?)` from `@hot-updater/cli-tools` takes no platform. Before a tracked build, the CLI reads the registry once and steps the ID 1 ms forward while a bundle holds it. Two builds that start in the same millisecond, such as an iOS and an Android job of one CI run, still get the same ID: the registry refuses the second registration, and `native-build` now says another build registered that built-in bundle first and to build again, instead of `native_builds: exists`. The build cache doesn't reuse this machine's cached build when another build registered its MIN_BUNDLE_ID, so building again issues a new one. `native-build import` and every reader keep accepting any UUIDv7, so artifacts an earlier CLI built, whose MIN_BUNDLE_ID has a platform byte, still import.
