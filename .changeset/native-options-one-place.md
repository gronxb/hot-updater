---
"@hot-updater/react-native": minor
---

Set a native instance's values in one place: its `HotUpdaterOptions`.

- `main` now honors the `channel`, `fingerprintHash`, and `publicKey` of its `HotUpdaterOptions` on iOS and Android. On iOS, `HotUpdaterOptions(baseURL:requestHeaders:requestTimeout:bundle:name:channel:fingerprintHash:publicKey:)` gains the three fields. A value left out comes from the embedded values (the framework's `Info.plist` or the AAR's manifest), then the app's. A named instance reads only its options and its own embedded values.
- Create `main`'s `HotUpdaterInstance` (iOS) or call `HotUpdater.init` (Android) before React Native starts and before `bundleURL()` or `getJSBundleFile()` is read. Creating it with a channel, fingerprint hash, or public key other than the one an earlier instance or `HotUpdater.configure` set, or, once React Native read the bundle, other than the one in use, throws `HotUpdater instance "main" was already created with another <field>`.
- `HotUpdater.configure(...)` and the public `HotUpdaterConfig` setters are deprecated on iOS and Android, and will be removed in a future major release. They still work for `main`, and log a warning when they replace a value its `HotUpdaterOptions` set. Move `channel`, `fingerprintHash`, and `publicKey` to `HotUpdaterOptions`, and drop `isolationKey`.
- Under the fingerprint strategy, downloaded updates are now kept per fingerprint, the build's embedded bundle ID (`MIN_BUNDLE_ID`), and channel, instead of per fingerprint, native app version, and channel. A native release that ships the same artifact keeps its downloads, and a repackaged artifact or a new native build starts from its newer embedded bundle, so no `isolationKey` is needed. The appVersion strategy is unchanged, and an `isolationKey` set through the deprecated `configure` still replaces the key.
- Because the key changed, updating to this release discards the downloaded updates of fingerprint apps once: each device starts from its embedded bundle, and its next update check downloads the latest update again.
