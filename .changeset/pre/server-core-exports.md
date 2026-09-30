---
"@hot-updater/server": patch
---

The root entry exports only core. `createInsightsProvider`, the Insights provider, domain, and model types, `BundleEventRow`, `API_KEY_HEADER_NAME`, and the API key management and row types come from `@hot-updater/server/plugins/insights` and `@hot-updater/server/plugins/api-keys`. `@hot-updater/server/plugins` exports `isDatabaseBusyError`, which tells a busy database (a transaction out of retries, or a throttled request) from a failure so a plugin's route can answer `503`, and `addDistinct`, `mergeDistinct`, and `countDistinct` for an aggregate's `distinct` metrics. A `clientAccess` object is rejected with a message that names no plugin: set `clientAccess: "public"`, or add a plugin that provides `clientAuth`.
