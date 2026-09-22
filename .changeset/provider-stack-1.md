---
"@hot-updater/cloudflare": patch
"@hot-updater/supabase": patch
"@hot-updater/postgres": patch
"@hot-updater/server": patch
---

Remove the unused fingerprint-only Release index from generated schemas and keep idempotent channel commits in the single unreleased 1.0.0 initialization migration. Existing RC databases must reconcile their schema instead of replaying initialization.
