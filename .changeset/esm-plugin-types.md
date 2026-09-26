---
"@hot-updater/firebase": patch
"@hot-updater/supabase": patch
"@hot-updater/cloudflare": patch
---

`plugins` from `@hot-updater/firebase`, `@hot-updater/supabase/edge`, and `@hot-updater/cloudflare/worker` type-check with `createHotUpdater` in ESM projects. Their exports no longer pin the CommonJS declarations, which referenced the CommonJS types of `@hot-updater/server/plugins` while `createHotUpdater` used the ESM ones.
