---
"@hot-updater/server": minor
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/supabase": minor
"hot-updater": patch
---

Serve Insights and API keys through plugins.

- **Insights routes:** `POST /events` and the admin Insights reads come from the `insights()` plugin. Without it, each answers 204 with `x-hot-updater-insights: disabled`.
- **API keys:** the `apiKeys()` plugin protects client routes with the same header the `clientAccess: { type: "api-key" }` option used, so a server that moves to plugins never falls back to public.
- **Core reads:** `hotUpdater.core` reads bundles, Releases, Catalogs, and channels. Plugins get the same reads as `ctx.core`, on the same engine. A plugin cannot take the id `core`.
- **Plugin APIs:** `hotUpdater.api.insights` and `hotUpdater.api.apiKeys` replace `hotUpdater.insights` and `hotUpdater.apiKeys`.
- **Providers:** `@hot-updater/aws`, `cloudflare`, `firebase`, and `supabase` export `plugins`, their managed server's plugin list (`insights()` and `apiKeys()`). The Lambda, Worker, Cloud Function, and Edge Function templates use it, with the same `x-api-key` header.
- **CLI:** `generate-standalone-sql` and the missing-export help text use the new options.
