---
"@hot-updater/plugin-core": patch
---

Insights and API key types and helpers are no longer exported. The Insights model types, `BundleEventRow`, `BundleEventRowBase`, `DatabaseBundleEventMetadata`, `ApiKeyModel`, and `ApiKeyRow` come from `@hot-updater/server/plugins/insights` and `@hot-updater/server/plugins/api-keys`, and `isDatabaseBundleEventMetadata`, `compareInsightsText`, `isInsightsMovementEvent`, and the Insights contract and overview helpers are internal to the Insights plugin. The sketch helpers are the storage engine's distinct counts: `addDistinct`, `mergeDistinct`, `countDistinct`, and `emptyDistinct` from `@hot-updater/plugin-core/internal`. `DatabaseModelMap`, `DatabaseModel`, `DatabaseRow`, and `DatabaseField` are removed.
