---
"@hot-updater/cli-tools": patch
"@hot-updater/console": patch
"@hot-updater/expo": patch
"@hot-updater/plugin-core": patch
"hot-updater": patch
---

Add Bundle Signing with explicit built-in local PEM config plus plugins for a
generic remote signing endpoint, AWS KMS, and Google Cloud KMS; require a pinned
public key for native and Expo builds; and expose only sanitized signing status
in Console. Local PEM is the standard baseline, while AWS KMS and Google Cloud
KMS provide hardened, non-exportable key custody through optional SDK peers.
