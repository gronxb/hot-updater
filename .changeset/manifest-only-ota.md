---
"@hot-updater/aws": patch
"@hot-updater/cli-tools": patch
"@hot-updater/cloudflare": patch
"@hot-updater/console": patch
"@hot-updater/core": patch
"@hot-updater/firebase": patch
"@hot-updater/plugin-core": patch
"@hot-updater/postgres": patch
"@hot-updater/react-native": patch
"@hot-updater/server": patch
"@hot-updater/standalone": patch
"@hot-updater/supabase": patch
"hot-updater": patch
---

Replace whole OTA archives with the versioned manifest artifact protocol. Deploys
now publish a manifest and content-addressed files, while the native installer
reuses byte-identical built-in assets and falls back to verified original files.

Remove `compressStrategy` and archive fields from the v1 configuration, bundle,
database, provider, and native contracts. The unreleased 1.0.0 schema and initial
migrations now require manifest metadata directly.
