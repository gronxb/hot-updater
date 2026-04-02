---
"@hot-updater/server": minor
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/supabase": minor
---

Add provider-specific serverless plugins for `createHotUpdater()` and refactor
the managed runtimes to use `hotUpdater.handler` directly with a legacy exact-path
rewrite route.
