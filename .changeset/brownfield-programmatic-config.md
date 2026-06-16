---
"@hot-updater/react-native": minor
---

feat(react-native): add native programmatic configuration for brownfield apps

Add `HotUpdater.configure(...)` on Android (`newarch`/`oldarch`) and iOS so brownfield / prebuilt-framework hosts can supply `fingerprintHash`, `publicKey`, and `channel` at runtime instead of relying on the host app's `AndroidManifest`/`strings.xml` or `Info.plist`, which the RN module cannot control when shipped as an AAR/XCFramework.

It also adds an optional `isolationKey` override. The default OTA storage isolation key embeds the host app version, so every native release invalidates the OTA cache and falls back to the binary-embedded bundle. A stable, version-independent key (e.g. keyed by fingerprint + channel) keeps downloaded updates across host app version bumps.

All overrides are opt-in and default to `null`/unset, so existing manifest/`Info.plist`-driven setups are unaffected.
