---
"@hot-updater/server": minor
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/supabase": minor
"hot-updater": patch
---

Serve Insights and API keys through plugins, next to the legacy options, which keep working with a warning until 1.0.

- **Insights routes:** with `plugins`, `POST /events` and the admin Insights reads come from the `insights()` plugin. Without it, each answers 204 with `x-hot-updater-insights: disabled`. Without `plugins`, Insights runs through the database plugin as before, and `createHotUpdater` warns once.
- **Legacy `clientAccess`:** `{ type: "api-key" }` warns. With `plugins`, it becomes `apiKeys()` with the same header, so it never falls back to public. `{ type: "public" }` warns and means `"public"`.
- **Core reads:** `hotUpdater.core` reads bundles, Releases, Catalogs, and channels. Plugins get the same reads as `ctx.core`, on the same engine. A plugin can no longer take the id `core`.
- **Deprecated:** `hotUpdater.insights` and `hotUpdater.apiKeys`; use `hotUpdater.api.insights` and `hotUpdater.api.apiKeys`.
- **Providers:** `@hot-updater/aws`, `cloudflare`, `firebase`, and `supabase` export `plugins`, their managed server's plugin list (`insights()` and `apiKeys()`). The Lambda, Worker, Cloud Function, and Edge Function templates use it instead of `clientAccess: { type: "api-key" }`, with the same `x-api-key` header.
- **CLI:** `generate-standalone-sql` and the missing-export help text use the new options.
