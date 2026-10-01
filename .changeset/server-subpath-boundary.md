---
"@hot-updater/server": minor
"@hot-updater/plugin-core": minor
"@hot-updater/test-utils": minor
"@hot-updater/plugin-insights": minor
"@hot-updater/plugin-api-keys": minor
"@hot-updater/aws": patch
"@hot-updater/cloudflare": patch
"@hot-updater/firebase": patch
"@hot-updater/supabase": patch
"@hot-updater/react-native": patch
"hot-updater": patch
---

`@hot-updater/server` is the runtime host: its root holds `createHotUpdater`, its types, the handlers and `toNodeHandler`, and its other entries are the built-in adapters (`./adapters/*`) and plugins (`./plugins/insights`, `./plugins/api-keys`). The storage engine, the database adapter kit, and core's schema move to `@hot-updater/plugin-core`, the kit adapters and plugins build on, and test code moves to `@hot-updater/test-utils`.

- `@hot-updater/server/database`, `@hot-updater/server/node`, `@hot-updater/server/plugins`, and `@hot-updater/server/plugins/insights/testing` are removed. Import from `@hot-updater/plugin-core` what you imported from `@hot-updater/server/database` or `@hot-updater/server/plugins`, `toNodeHandler` from `@hot-updater/server`, and the Insights suites from `@hot-updater/test-utils`. `targetBaseCandidateKey` moves from `@hot-updater/server/db` to `@hot-updater/plugin-core`, beside `parseBaseCandidateKey`.
- No package has an internal entry: `@hot-updater/plugin-core/internal`, `@hot-updater/plugin-insights/internal`, and `@hot-updater/plugin-api-keys/internal` are removed, and `@hot-updater/plugin-insights/testing` too. A package uses another only through its public API. `InsightsBadRequestError`, which Insights' API throws for an input it refuses, is exported from `@hot-updater/plugin-insights/server`.
- `@hot-updater/plugin-core` exports `createEngine(database, { plugins, now, retry })`, the storage engine as `createHotUpdater` runs it: core's tables and the plugins', the plugins' settings rows behind the schema fence, expired rows pruned during writes, and batched aggregates. `meterReads(database)` meters any database on the engine, a provider's included, for adapter cost analysis: `database.measureReads(read)` reports what a call read at the adapter and at the engine.
- `@hot-updater/plugin-core` also exports what an adapter, a provider's tooling, or a plugin outside it needs: `SETTINGS_TABLE`, `aggregateBatchingTables`, and `encodeKvKey` for setups and access policies; `createEngineSqlMigrator`, `createSettingsMigrator`, `sqlTableShapes`, and `quoteSql` for ORM adapters; `DATABASE_VERSION_COLUMN`, `rowKey`, `findPhysicalIndex`, and `findPhysicalColumn` for an adapter that is neither SQL nor key-value; `compareUtf8` and `isDatabaseJsonObject` for plugins; the types `verifyAdapter` returns and throws; and the option and tooling types of its public functions. `createEngineDatabase` takes `readSettings` for an adapter that reads stored settings itself, and `EngineDatabase` and `StorageAdapter` take an optional `resource`, the provider resource a managed setup compares.
- `CoreSchema`, core's tables as `createEngine`'s `core` handle types them, is part of `@hot-updater/plugin-core`'s API: a change to core's schema releases `@hot-updater/plugin-core` and ships with the migration `schema.core` versions.
- `@hot-updater/test-utils` uses the other packages only through their public API. `createMeasuredDatabase(adapter, plugins, { now, storage })` returns a promise of core, the plugins' APIs, their `clientAuth`, and `measureReads`, from `createHotUpdater` over `meterReads({ name, adapter: verifyAdapter(adapter) })`; `now` is the plugins' clock. `setupReadBudgetTestSuite` takes no `server`, and its `createAdapter` gets `SETTINGS_TABLE` among its `tables`. `createPluginTestHarness` and `setupAggregateBatchingTestSuite` run on `createEngine` and take no `engine`; the harness runs no retention passes. It also exports `createMemoryKeyValueStore`, the database fixtures, and the Insights suites, and `@hot-updater/test-utils/node` the SQL test executors. `@hot-updater/server` and `@hot-updater/plugin-insights` are optional peer dependencies.
- Published packages leave out specs and test helpers: `@hot-updater/server` publishes `dist` only, and `@hot-updater/cloudflare`, `@hot-updater/supabase`, and `@hot-updater/react-native` leave their specs out of the source they ship.
