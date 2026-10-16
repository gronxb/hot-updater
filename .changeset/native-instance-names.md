---
"@hot-updater/react-native": patch
---

Native `HotUpdaterOptions` take an optional `name`, so one native app can update several React Native bundles independently, like named Firebase apps.
- The default, `main`, is the state React Native's own `HotUpdater` uses, on the same paths and keys as before.
- Each other name (1 to 32 of `a-z`, `0-9`, and `-`) keeps its downloaded bundles, channel, stored values, Release catalog cache, and queued native events apart. A channel reset or an app upgrade of one name leaves every other name's bundles alone.
- A named instance embeds a bundle of its own (its framework bundle on iOS, its `bundleAssetName` on Android), since React Native's runtime is told apart by the bundle it runs.
- Instances with the same name share that state. Creating one with another bundle (iOS) or another channel, fingerprint, public key, or bundle asset (Android) throws.
- On iOS, a named instance reads `HOT_UPDATER_FINGERPRINT_HASH`, `HOT_UPDATER_CHANNEL`, and `HOT_UPDATER_PUBLIC_KEY` from its framework bundle.
- On Android, where one manifest serves every library, `HotUpdaterOptions` take `channel`, `fingerprintHash`, `publicKey`, and `bundleAssetName` (the embedded bundle in the app's assets) for a named instance.
- Bundle signatures are verified with each instance's own public key.
