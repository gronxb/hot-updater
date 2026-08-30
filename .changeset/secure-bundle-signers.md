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

Require RSA keys of at least 2048 bits, validate explicit public-key pins and
native key matches before deployment, and verify signatures before upload.
Prevent key generation from overwriting existing files and default to
cancelling replacement of a different or invalid embedded public key. Existing
v0 CLI-generated keys meet the key requirements; signing-key changes still
require a native-first rollout.
