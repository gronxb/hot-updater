---
"@hot-updater/cli-tools": patch
"@hot-updater/console": patch
"@hot-updater/expo": patch
"@hot-updater/plugin-core": patch
"hot-updater": patch
---

Extend Bundle Signing with plugins for a generic remote signing endpoint, AWS
KMS, and Google Cloud KMS while preserving v0 local `enabled`/`privateKeyPath`
configuration. Local `publicKeyPath` is optional; signing plugins require it.
Support public-key-only native/Expo builds and sanitized read-only Console
inspection. Local PEM is the standard baseline, while AWS KMS and Google Cloud
KMS provide hardened, non-exportable key custody through optional SDK peers.
