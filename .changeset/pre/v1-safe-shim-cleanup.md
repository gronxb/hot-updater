---
"@hot-updater/react-native": minor
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"@hot-updater/supabase": minor
"@hot-updater/cli-tools": patch
"@hot-updater/postgres": patch
"@hot-updater/cloudflare": patch
"@hot-updater/firebase": patch
"@hot-updater/standalone": patch
---

Remove leftover v0 aliases that are not field compatibility. `HotUpdater.wrap({ updateMode: "manual" })` throws, findMany accepts only `orderBy`, and Supabase plugins require `supabaseServiceRoleKey`. Managed init still detects leftover `supabaseAnonKey` so skipped v0 configs fail closed.
