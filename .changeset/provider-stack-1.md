---
"@hot-updater/cloudflare": patch
"@hot-updater/supabase": patch
"@hot-updater/postgres": patch
"@hot-updater/server": patch
---

Remove the unused fingerprint-only Release index from generated schemas and keep idempotent channel commits in the single unreleased 1.0.0 initialization migration. Existing RC databases must reconcile their schema instead of replaying initialization.

Include `id` after the owner/base key in patch relation indexes so cursor pages can seek directly without sorting relation history. Existing RC databases must recreate these two indexes with the updated columns.
