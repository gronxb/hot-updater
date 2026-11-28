---
"@hot-updater/plugin-core": patch
"@hot-updater/cloudflare": patch
"@hot-updater/supabase": patch
---

perf(plugin-core): index each multi-valued index table, such as `bundle_events__byBundle`, by its row's key. Replacing a row's entries on a patch or a delete, and the retention prune on PostgreSQL and Supabase, read the whole index table without it.
