---
"hot-updater": patch
"@hot-updater/aws": patch
"@hot-updater/cloudflare": patch
"@hot-updater/console": patch
"@hot-updater/firebase": patch
"@hot-updater/mock": patch
"@hot-updater/plugin-core": minor
"@hot-updater/server": patch
"@hot-updater/standalone": patch
"@hot-updater/supabase": patch
---

Use deterministic content-addressed storage keys for manifest assets, require storage plugins to implement object existence checks, skip uploads when the object already exists, limit deploy upload concurrency, and report upload progress through 100%.
