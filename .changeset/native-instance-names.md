---
"@hot-updater/react-native": patch
---

Native `HotUpdaterOptions` take an optional `name`, so one native app can update several React Native bundles independently, like named Firebase apps.
- The default, `main`, is the state React Native's own `HotUpdater` uses, on the same paths as before.
- Each other name (1 to 32 of `a-z`, `0-9`, and `-`) keeps its downloaded bundles, channel, stored values, Release catalog cache, and queued native events apart. A channel reset or an app upgrade of one name leaves every other name's bundles alone.
- A named instance embeds a bundle of its own (its framework bundle on iOS, its `bundleAssetName` on Android), since React Native's runtime is told apart by the bundle it runs.
- Instances with the same name share that state. Creating one with another channel, fingerprint hash, or public key throws, as does another bundle (iOS, `main` included, also after `HotUpdater.bundleURL(bundle:)` launched it with one) or another bundle asset (Android).
- A named instance reads `channel`, `fingerprintHash`, and `publicKey` from its `HotUpdaterOptions`, then from its own embedded values: its framework bundle's `HOT_UPDATER_*` keys on iOS, the manifest on Android. It never reads `main`'s values.
- On Android, `HotUpdaterOptions` also take `bundleAssetName`, the embedded bundle in the app's assets, for a named instance.
- Bundle signatures are verified with each instance's own public key.
