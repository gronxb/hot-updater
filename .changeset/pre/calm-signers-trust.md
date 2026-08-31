---
"@hot-updater/cli-tools": patch
"@hot-updater/console": patch
"@hot-updater/expo": patch
"@hot-updater/plugin-core": patch
"hot-updater": patch
---

Separate bundle signer identity from the native trust anchor. Signing providers
now expose public identity only through `getPublicKey()`, while Expo reads its
public trust-anchor file exclusively from the app config plugin and includes it
in native fingerprints. Add public-key materialization for Expo and validate
Expo CNG trust anchors during deploy and doctor without loading signing
credentials during prebuild.
