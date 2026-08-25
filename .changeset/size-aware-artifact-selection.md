---
"@hot-updater/core": minor
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"@hot-updater/cli-tools": minor
"hot-updater": minor
"@hot-updater/test-utils": minor
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/postgres": minor
"@hot-updater/standalone": minor
"@hot-updater/supabase": minor
---

Persist required immutable archive and patch byte sizes across the initial v1
Bundle contract and official database providers. Databases created from an
earlier unreleased `1.0.0` schema must be recreated; this pre-release change has
no incremental migration or backfill.

Record optional exact served-object sizes and hashes in Bundle manifests,
content-address new Brotli payloads by their compressed hash, and let the
server select the archive when known normal diff bytes are equal to or larger
than it. Unknown optional manifest metadata preserves the existing
manifest-first path, with no native protocol change or request-time storage
metadata probe.
