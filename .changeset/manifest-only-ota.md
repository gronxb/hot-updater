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

Use the versioned manifest artifact protocol for every OTA install. Deploys
publish a manifest, content-addressed files and one tar.br bulk transport. The
native installer reuses byte-identical built-in assets and compares tar.br with
the remaining transfer cost. Complete downloads without patches may additionally
allow the signed TAR framing overhead to avoid request fanout. Failed archives
fall back once to verified original files; failed patches recover per file.

Remove `compressStrategy`, ZIP/gzip OTA extraction, format detection and archive
strategy branches. Archive identity and bounds belong to the signed manifest;
Bundle and provider rows stay manifest-based. The unreleased 1.0.0 schema and
initial migrations now require manifest metadata directly.

Validate complete descriptor sets before reuse, recheck cached target files,
and retain hash-verified staging files across retries. Download remaining files
with a fixed concurrency limit and report only network files in download progress.

Allow concurrent Supabase deploys to upload the same shared content-addressed
asset without failing on an already-existing object.
