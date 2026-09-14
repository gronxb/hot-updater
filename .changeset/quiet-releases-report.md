---
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/postgres": minor
"@hot-updater/supabase": minor
"@hot-updater/console": minor
"hot-updater": patch
---

Add materialized release activity summaries and bounded hourly report buckets.
Bundle rows now show current and lifetime installation counts without scanning raw
event history, while Insights charts read only the requested release and time
range. Fresh `1.0.0` infrastructure includes the required projection storage.
