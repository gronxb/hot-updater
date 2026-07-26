---
"@hot-updater/cli-tools": patch
"hot-updater": patch
"@hot-updater/aws": patch
"@hot-updater/cloudflare": patch
"@hot-updater/firebase": patch
"@hot-updater/supabase": patch
---

Declare provider init inputs in one shared contract, ask once before saving
credential inputs, and support prompt-free infrastructure reconciliation with
`init --env-file .env.hotupdater`.
