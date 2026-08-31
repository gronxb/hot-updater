---
"@hot-updater/cloudflare": patch
---

Keep the unreleased D1 1.0.0 schema in a single initial migration, including
required archive and patch byte sizes and their bounds. Remove the incremental
byte-size migration and its zero backfill defaults. Existing prerelease databases
are not upgraded in place; use a fresh database for the consolidated schema.
