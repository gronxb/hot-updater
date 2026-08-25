---
"@hot-updater/aws": patch
"@hot-updater/cli-tools": patch
"@hot-updater/console": patch
"@hot-updater/expo": patch
"@hot-updater/plugin-core": patch
"hot-updater": patch
---

Add provider-backed Bundle Signing with an AWS KMS remote signer, require a
separate public key for native and Expo builds, preserve local PEM signing as a
compatibility fallback, and expose only sanitized signing status in Console.
