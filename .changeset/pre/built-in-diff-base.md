---
"hot-updater": minor
"@hot-updater/react-native": minor
---

A store install's first OTA downloads a Hermes patch from the built-in bundle of its registered native build.

- `hot-updater deploy` adds the built-in bundle of the newest native build `native-build ios|android` tracked for the deploy's channel, platform, and fingerprint or exact app version to its patch bases, beside the `patch.maxBaseBundles` released ones, in one indexed read. A built-in bundle newer than the deployed bundle, or a self-hosted server without the native build routes, adds none.
- With no OTA installed, the iOS and Android runtimes apply a patch whose base is the app's MIN_BUNDLE_ID to a copy of the packaged Hermes file, after checking it against the patch's base file hash. When store processing changed the file, they download the complete file instead, and report `patchFallback`.
- The runtimes choose between per-file downloads and `bundle.tar.br` counting only the patches they can apply: a built-in patch counts once the packaged file has been checked against its base.
