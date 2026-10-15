---
"@hot-updater/react-native": patch
---

Keep OTA updates installing on native code built before artifact protocol v2. The update check asks for v2 only when the app's native code has the new `installArtifact` method and installs over v1 otherwise, so this JavaScript delivered by OTA to an older native build no longer fails to install later updates. Native `updateBundle` still accepts what the first v2 JavaScript sends, so OTA Bundles built with it keep installing on new native builds.
