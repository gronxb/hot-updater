---
"@hot-updater/aws": patch
"@hot-updater/cli-tools": patch
"@hot-updater/console": patch
"@hot-updater/expo": patch
"@hot-updater/firebase": patch
"@hot-updater/plugin-core": patch
"hot-updater": patch
---

Add plugin-based Bundle Signing with local PEM, AWS KMS, and Google Cloud
KMS-backed Firebase signers, require a pinned public key for native and Expo
builds, and expose only sanitized signing status in Console.
