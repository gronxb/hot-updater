# @hot-updater/postgres

## 1.0.0-rc.36

### Patch Changes

- Updated dependencies [c527bb2]
  - @hot-updater/protocol@1.0.0-rc.36
  - @hot-updater/server@1.0.0-rc.36
  - @hot-updater/plugin-core@1.0.0-rc.36

## 1.0.0-rc.35

### Patch Changes

- @hot-updater/protocol@1.0.0-rc.35
  - @hot-updater/server@1.0.0-rc.35
  - @hot-updater/plugin-core@1.0.0-rc.35

## 1.0.0-rc.34

### Patch Changes

- Updated dependencies [48241d4]
  - @hot-updater/protocol@1.0.0-rc.30
  - @hot-updater/server@1.0.0-rc.34
  - @hot-updater/plugin-core@1.0.0-rc.30

## 1.0.0-rc.33

### Patch Changes

- Updated dependencies [9fe6dfd]
  - @hot-updater/server@1.0.0-rc.33
  - @hot-updater/plugin-core@1.0.0-rc.29

## 1.0.0-rc.32

### Patch Changes

- Updated dependencies [384a5b6]
  - @hot-updater/protocol@1.0.0-rc.29
  - @hot-updater/server@1.0.0-rc.32
  - @hot-updater/plugin-core@1.0.0-rc.29

## 1.0.0-rc.31

### Patch Changes

- Updated dependencies [d846556]
  - @hot-updater/server@1.0.0-rc.31
  - @hot-updater/plugin-core@1.0.0-rc.28

## 1.0.0-rc.30

### Patch Changes

- @hot-updater/server@1.0.0-rc.30
  - @hot-updater/plugin-core@1.0.0-rc.28

## 1.0.0-rc.29

### Patch Changes

- Updated dependencies [80bb792]
  - @hot-updater/protocol@1.0.0-rc.28
  - @hot-updater/server@1.0.0-rc.29
  - @hot-updater/plugin-core@1.0.0-rc.28

## 1.0.0-rc.28

### Patch Changes

- @hot-updater/server@1.0.0-rc.28

## 1.0.0-rc.27

### Patch Changes

- Improve the readability of Console update failures by grouping check metrics separately, emphasizing nonzero failures, and making stage/reason details easier to scan. Preserve all report data and rate calculations. Prepare all public Hot Updater packages together as 1.0.0-rc.27.
- Updated dependencies
  - @hot-updater/plugin-core@1.0.0-rc.27
  - @hot-updater/protocol@1.0.0-rc.27
  - @hot-updater/server@1.0.0-rc.27

## 1.0.0-rc.26

### Patch Changes

- c9cfed7: Restore the rc.14 Insights metric layout in bundle rows and details while preserving current data, rates, links, and download failure reporting. Release all public Hot Updater packages together as 1.0.0-rc.26.
- Updated dependencies [c9cfed7]
  - @hot-updater/plugin-core@1.0.0-rc.26
  - @hot-updater/protocol@1.0.0-rc.26
  - @hot-updater/server@1.0.0-rc.26

## 1.0.0-rc.25

### Patch Changes

- c9cfed7: Release the legacy Hermes fallback correction at 1.0.0-rc.25 with all public Hot Updater packages on the same RC.
- Updated dependencies [c9cfed7]
  - @hot-updater/plugin-core@1.0.0-rc.25
  - @hot-updater/protocol@1.0.0-rc.25
  - @hot-updater/server@1.0.0-rc.25

## 1.0.0-rc.24

### Patch Changes

- c9cfed7: Release the project-scoped Expo, fingerprint, React Native, and Hermes resolution fixes at 1.0.0-rc.24 so projects can install the same RC of every Hot Updater package.
- Updated dependencies [c9cfed7]
  - @hot-updater/plugin-core@1.0.0-rc.24
  - @hot-updater/protocol@1.0.0-rc.24
  - @hot-updater/server@1.0.0-rc.24

## 1.0.0-rc.23

### Patch Changes

- c9cfed7: Release with the Expo SDK 58 config fix at 1.0.0-rc.23 so projects can install the same RC of every Hot Updater package.
- Updated dependencies [c9cfed7]
  - @hot-updater/plugin-core@1.0.0-rc.23
  - @hot-updater/protocol@1.0.0-rc.23
  - @hot-updater/server@1.0.0-rc.23

## 1.0.0-rc.22

### Patch Changes

- c9cfed7: Released with every Hot Updater package at 1.0.0-rc.22, so a project can install the same RC of each one.
- Updated dependencies [c9cfed7]
  - @hot-updater/plugin-core@1.0.0-rc.22
  - @hot-updater/protocol@1.0.0-rc.22
  - @hot-updater/server@1.0.0-rc.22

## 1.0.0-rc.21

### Patch Changes

- c9cfed7: Every package now shares one release candidate version: `hot-updater` and every `@hot-updater/*` package move to the same version, so an app, its server, and the console can pin one version.
- 4d15862: `@hot-updater/core` is renamed `@hot-updater/protocol`: the device-safe, zero-dependency package for what crosses a boundary, the formats and pure computations the app and the server share and the contracts between a host and its extensions on the device, such as the client plugin contract. `@hot-updater/plugin-core` is the kit that extends the server, with the adapter and server plugin contracts and their helpers: it runs wherever the server runs, and the app never imports it.
  - Import from `@hot-updater/protocol` where you imported `@hot-updater/core`. Every Hot Updater package that depended on `@hot-updater/core` depends on `@hot-updater/protocol` instead. `@hot-updater/core` stays on npm for 0.x.
  - `canonicalizeAppVersion` moves to `@hot-updater/protocol`, which bundles the version parsing it uses and has no dependencies. `@hot-updater/plugin-core` exports it as before.
  - `@hot-updater/react-native` no longer depends on `@hot-updater/plugin-core`: the app imports `@hot-updater/protocol` and the built-in Insights client, never `@hot-updater/plugin-core` or `@hot-updater/server`.
  - `@hot-updater/plugin-insights` takes `@hot-updater/plugin-core` as an optional peer dependency, which only its `./server` entry needs, and `@hot-updater/plugin-api-keys` as a peer dependency, so an app that installs `@hot-updater/react-native` no longer installs `@hot-updater/plugin-core`. A server gets it through `@hot-updater/server`.
  - Third-party server plugins and storage, build, and signing adapters import `@hot-updater/plugin-core` and list it in `peerDependencies`; client plugins do the same with `@hot-updater/protocol`. `@hot-updater/plugin-core` now also exports `addDistinct`, `countDistinct`, and `mergeDistinct`, so a plugin imports everything it needs from its root.
  - Client plugins import `defineClientPlugin` and its types from `@hot-updater/protocol`. `@hot-updater/react-native` still exports them for app code.
  - The `@hot-updater/react-native/plugins/insights` subpath is removed: import `insights` and its types from `@hot-updater/react-native`, as in `import { HotUpdater, insights } from "@hot-updater/react-native"`. Metro bundles the Insights client into every app, about 4 KB gzipped; it reports nothing until the app adds it to `plugins`. `hot-updater init` and the agent scaffold print that import, and `hot-updater doctor` looks for it.
  - `@hot-updater/protocol` exports the plugin host the SDK runs client plugins on, for any device SDK to reuse: `createPluginHost`, `pluginStorageKey`, `resolveBaseURL`, `HotUpdaterBaseURL`, and the `PluginHost*` types. `@hot-updater/react-native` has no subpaths, and `@hot-updater/test-utils/react-native` runs client plugins on protocol's host, without `@hot-updater/react-native` as a peer dependency.
  - `@hot-updater/cli-tools` adds `renderAppImports`, which groups the app's imports by module.
  - The `@hot-updater/plugin-core` root exports `definePlugin`, the schema DSL, the typed database handle, and the database errors.

- 61fcd51: `@hot-updater/server` is the runtime host: its root holds `createHotUpdater`, its types, the handlers and `toNodeHandler`, and its other entries are the built-in adapters (`./adapters/*`) and plugins (`./plugins/insights`, `./plugins/api-keys`). The storage engine, the database adapter kit, and core's schema move to `@hot-updater/plugin-core`, the kit adapters and plugins build on, and test code moves to `@hot-updater/test-utils`.
  - `@hot-updater/server/database`, `@hot-updater/server/node`, `@hot-updater/server/plugins`, and `@hot-updater/server/plugins/insights/testing` are removed:
    - Import from `@hot-updater/plugin-core` what you imported from `@hot-updater/server/database` or `@hot-updater/server/plugins`.
    - Import `toNodeHandler` from `@hot-updater/server`.
    - Import the Insights suites from `@hot-updater/test-utils`.
  - From `@hot-updater/server/db`:
    - `createMeasuredDatabase`, `MeasuredDatabase`, and `MeasuredDatabaseOptions` move to `@hot-updater/test-utils`.
    - `targetBaseCandidateKey` and `EngineSqlOptions` move to `@hot-updater/plugin-core`, beside `parseBaseCandidateKey`.
    - `settingsStatements` is private.
  - `createEngine` now has the signature `createEngine(database, { plugins, now })`. It takes a database as `createEngineDatabase` returns it, and returns `{ core, database(plugin), flush, dispose }`. rc.18's `createEngine({ adapter, schema, maxPageSize, verify, retry })` from `@hot-updater/server/database` is gone. A transaction's retries are the database's `retry` (`createEngineDatabase({ retry })`), and verify mode is `verifyAdapter(adapter)`.
  - These rc.18 names now exist in no package, because they are the storage engine's internals:
    - `aggregateBatchingModule`, `CheckIndex`, `checkSchemaFence`, `classifySqlError`, `CliFor`, `compareTuples`, `createDatabaseEngine`;
    - `DATABASE_MAX_MULTI_VALUES`, `DATABASE_MAX_QUERY_LIMIT`, `DatabaseEngine`, `DatabaseEngineOptions`, `DatabaseTestState`, `DatabaseValueError`;
    - `ENGINE_SCHEMA_KEY`, `ENGINE_SCHEMA_VERSION`, `InstanceFor`, `isMissingSchemaError`, `MAX_SHARDS`, `migrateSchema`, `normalizeStoredValue`;
    - `ReadRange`, `ResolvedReference`, `resolveSchema`, `SchemaModule`, `settingsStatements`, `SHARD_COLUMN`, `validateSchema`, `withSchemaFence`.
  - No package has an internal entry: `@hot-updater/plugin-core/internal`, `@hot-updater/plugin-insights/internal`, and `@hot-updater/plugin-api-keys/internal` are removed, and `@hot-updater/plugin-insights/testing` too. A package uses another only through its public API. `InsightsBadRequestError`, which Insights' API throws for an input it refuses, is exported from `@hot-updater/plugin-insights/server`.
  - `@hot-updater/plugin-core` exports `createEngine(database, { plugins, now })`, the storage engine as `createHotUpdater` runs it: core's tables and the plugins', the plugins' settings rows behind the schema fence, expired rows pruned during writes, and batched aggregates. `meterReads(database)` meters any database on the engine, a provider's included, for adapter cost analysis. `database.measureReads(read)` reports what a call read at the adapter and at the engine. Aggregate batching's compaction and flush reads during the call count.
  - An `EngineDatabase` takes an optional `retry`, which `createEngineDatabase` also takes: how a transaction that conflicts with another write runs again, with `onRetry` to observe each rerun. A store many writers contend on can take more attempts.
  - `MemoryAdapterOptions` keeps only `tablePrefix`.
  - `@hot-updater/plugin-core` also exports what an adapter, a provider's tooling, or a plugin outside it needs: `SETTINGS_TABLE`, `aggregateBatchingTables`, and `encodeKvKey` for setups and access policies; `createEngineSqlMigrator`, `createSettingsMigrator`, `sqlTableShapes`, and `quoteSql` for ORM adapters; `DATABASE_VERSION_COLUMN`, `rowKey`, `findPhysicalIndex`, and `findPhysicalColumn` for an adapter that is neither SQL nor key-value; `compareUtf8` and `isDatabaseJsonObject` for plugins; the types `verifyAdapter` returns and throws; and the option and tooling types of its public functions. `createEngineDatabase` takes `readSettings` for an adapter that reads stored settings itself.
  - `CoreSchema`, core's tables as `createEngine`'s `core` handle types them, is part of `@hot-updater/plugin-core`'s API: a change to core's schema releases `@hot-updater/plugin-core` and ships with the migration `schema.core` versions.
  - `@hot-updater/test-utils` uses the other packages only through their public API. `createMeasuredDatabase(adapter, plugins, { now, storage })` returns a promise of core, the plugins' APIs, their `clientAuth`, and `measureReads`, from `createHotUpdater` over `meterReads({ name, adapter: verifyAdapter(adapter) })`; `now` is the plugins' clock. `setupReadBudgetTestSuite` takes no `server`, and its `createAdapter` gets `SETTINGS_TABLE` among its `tables`. `createPluginTestHarness` and `setupAggregateBatchingTestSuite` run on `createEngine` and take no `engine`; the harness runs no retention passes. It also exports `createMemoryKeyValueStore`, the database fixtures, and the Insights suites, and `@hot-updater/test-utils/node` the SQL test executors and `createD1TestDatabase(db, statements)`, a D1 database over `node:sqlite`. `@hot-updater/server` and `@hot-updater/plugin-insights` are optional peer dependencies.
  - Published packages leave out specs and test helpers:
    - `@hot-updater/server` publishes `dist` only.
    - `@hot-updater/cloudflare`, `@hot-updater/supabase`, and `@hot-updater/react-native` leave their specs out of the source they ship.
    - `@hot-updater/react-native` also leaves out its Android unit tests.
    - `@hot-updater/cloudflare`'s D1 test database moves to `@hot-updater/test-utils/node`.
  - `@hot-updater/postgres` and `@hot-updater/console` import the storage engine kit and the plugin types from `@hot-updater/plugin-core`.

- Updated dependencies [c9cfed7]
- Updated dependencies [5ec6796]
- Updated dependencies [ab04e15]
- Updated dependencies [73f809e]
- Updated dependencies [f185d6d]
- Updated dependencies [f185d6d]
- Updated dependencies [ab04e15]
- Updated dependencies [4d15862]
- Updated dependencies [9dc4baf]
- Updated dependencies [48cdd14]
- Updated dependencies [049fad1]
- Updated dependencies [0d8d03b]
- Updated dependencies [61fcd51]
- Updated dependencies [bb57f25]
  - @hot-updater/protocol@1.0.0-rc.21
  - @hot-updater/plugin-core@1.0.0-rc.21
  - @hot-updater/server@1.0.0-rc.21

## 1.0.0-rc.18

### Patch Changes

- a084eda: Each provider's schema follows the plugins its server runs.
  - **PostgreSQL:** `sql/bundles.sql` holds core's tables and settings rows. Add the tables and settings rows of the server's plugins, such as `insights()`, with `hot-updater db migrate`.
  - **DynamoDB:** `migrateDynamoDB(config, plugins)` creates the table when it is missing and writes the settings items of core and `plugins`. `hot-updater init` and `dynamodb/schema-settings.json` from `hot-updater infra scaffold` use the managed server's `plugins`, as its IAM policy does.
  - **Firestore:** `migrateFirebaseDatabase(config, plugins)` writes the settings rows of core and `plugins`. `hot-updater init` passes the managed server's `plugins`.
  - **D1 and Supabase:** the checked-in migrations hold the tables of core and of the managed server's plugins, Insights and API keys. `hot-updater db generate` for a server on the REST `d1Database` or on `supabaseDatabase` writes core's tables and those of the plugins it runs.

- 530cca5: Each provider deletes rows past their table's retention with no scheduler. DynamoDB deletes items by Time to Live on `_ttl`: `migrateDynamoDB`, `hot-updater db migrate`, and the managed AWS setup turn it on, and `hot-updater infra scaffold` writes `dynamodb/enable-ttl.json`. Firestore deletes documents by a TTL policy on `expireAt`, declared in `firestore.indexes.json`. Cloudflare D1 and Supabase delete them during writes, in bounded batches, within D1's query limit for one Worker invocation and through Supabase's apply RPC. The D1 and Supabase schemas add the Insights daily and lifetime tables and the indexes pruning walks. A deployment from a 1.0.0 release candidate recreates its database and updates the server, app, and console together.
- b317d49: The PostgreSQL, D1, and Supabase schemas add the Insights update failure counters and sketches, and the `insights_sketches_lifetime` and `insights_failures` tables, under the plugin's schema `1.2.0`, and drop `bundle_event_heads.current_release_id`. The DynamoDB IAM policy covers the two new partitions: rerun `hot-updater init`. A deployment from a 1.0.0 release candidate recreates its database.
- Updated dependencies [e696e69]
- Updated dependencies [e696e69]
- Updated dependencies [9574287]
- Updated dependencies [9cd555b]
- Updated dependencies [9cd555b]
- Updated dependencies [1ddd5fc]
- Updated dependencies [9cd555b]
- Updated dependencies [530cca5]
- Updated dependencies [b317d49]
- Updated dependencies [9cd555b]
- Updated dependencies [9a6715f]
- Updated dependencies [9a6715f]
- Updated dependencies [a084eda]
- Updated dependencies [530cca5]
- Updated dependencies [b317d49]
  - @hot-updater/plugin-core@1.0.0-rc.17
  - @hot-updater/server@1.0.0-rc.18

## 1.0.0-rc.17

### Patch Changes

- Updated dependencies [038c804]
  - @hot-updater/server@1.0.0-rc.17

## 1.0.0-rc.16

### Minor Changes

- e542054: Run the Kysely adapter and the `postgres` plugin on the new storage engine. Their factory signatures are unchanged.
  - **Kysely:** `kyselyAdapter` runs PostgreSQL, MySQL, and SQLite through the shared SQL core with `kyselyExecutor`.
    - Its migrator applies the generated SQL schema: tables, indexes, and the settings rows, written last.
    - The migrator refuses a v0 or pre-engine database instead of converting it.
  - **Schema fence:** both adapters fence their schema. A database without the `schema.engine` row is refused before its first read, and handlers answer 503.
  - **`postgres` plugin:** `sql/bundles.sql` is now the generated SQL schema, and a test fails when the two differ.
  - **Removed:** the plugin-specific Insights helpers `getKyselyAppUsage`, `getKyselyReleaseActivity`, `readKyselyInsightsHead`, and `recordKyselyInsightsOverview` are no longer exported from `@hot-updater/server`.
  - **Upgrade note:** the 1.0.0 infrastructure upgrade note now says that RC databases created before the adapter redesign must be recreated.

- 8a03eb2: Narrow the database provider query contract to the operators Hot Updater uses. `DatabaseWhere` accepts only `eq`, `gt`, `gte`, `lt`, `lte`, and `in`, and conditions are always joined with AND. The `ne`, `not_in`, `contains`, `starts_with`, and `ends_with` operators, the `connector` (`OR`) and `mode` (`insensitive`) fields, and `findMany`'s `distinctOn` are removed from the types, the input validation, and every official provider.

  Custom providers built on `@hot-updater/plugin-core/internal` can delete their implementations of the removed operators. Validation rejects a where condition with any key other than `field`, `operator`, and `value`, and rejects `distinctOn`, instead of ignoring them.

- 228b6c7: Remove the legacy database contract. Every database runs on the storage engine, and core, its plugins, and the admin API are the only way to its data. Release candidate databases are recreated, not converted.
  - **Databases:** a provider returns an `EngineDatabase`, `{ name, adapter, dispose? }`, with `provider`, `createMigrator`, and `generateSchema` for `hot-updater db` where it has them. `createEngineDatabase({ name, adapter })` from `@hot-updater/server/database` puts the adapter behind the schema fence with the built-in settings; `builtInSchema`, `builtInSettings`, and `migrateBuiltInSchema` are the built-in tables, their settings rows, and their migration. `DatabasePlugin`, `createDatabasePlugin`, `createDatabaseClient`, the model and commit types, `commitReleaseCatalogMutation(s)`, and `BundleRepository` are gone.
  - **`createHotUpdater`:** takes `{ database, storage?, plugins?, clientAccess? }`; `plugins` defaults to none. `clientAccess` is `"public"`, or absent when a plugin provides clientAuth. A `clientAccess` object is a type error whose message names `apiKeys()`, and at startup a `HotUpdaterConfigError` that names it too. The instance is `{ handlers, core, api, adapterName }`: bundle, channel, release, Insights, and API key methods on it are gone; use `core` and the plugins' `api`. `registerApiKey`, `createApiKey`, `provisionApiKey`, and `createHandlers` are no longer exported; the `apiKeys()` plugin's API does the same work.
  - **Handlers:** client routes read catalogs and artifacts through core. The admin API speaks protocol 2 only: `v=2` is accepted and changes nothing, and `POST /database/commit`, `POST /bundles`, and `DELETE /bundles/:id` are gone (deploy with `POST /releases`, delete with `POST /bundles/delete`). `PATCH /bundles/:id` answers 204. The Insights routes come from `insights()`; without it they answer 204 with `x-hot-updater-insights: disabled`.
  - **Schema:** generated SQL, Drizzle, and Prisma schemas have no database foreign keys; the engine keeps references. CockroachDB and SQL Server are no longer supported, and `relationMode` is gone. The checked-in Postgres and Supabase SQL is regenerated.
  - **Providers:** `postgres`, `d1Database`, `supabaseDatabase`, `firebaseDatabase`, and `dynamoDB` return engine databases. `dynamoDB` invalidates the cached update-check routes after a write that changes a Release Catalog.
  - **`standaloneRepository`:** is `{ name, core, fetchAdmin }` over admin API protocol 2; its protocol 1 reads and custom bundle `routes` are gone.
  - **`@hot-updater/test-utils`:** `setupDatabaseTestSuite` runs core, bundles, the Release Catalog contract, and Insights through admin API protocol 2 over HTTP, and with `createInsightsModel` the Insights report contract. It replaces `setupDatabasePluginTestSuite` and `setupDatabaseClientTestSuite`. `setupBundleMethodsTestSuite` and `setupReleaseCatalogTestSuite` take `{ getClient }` on protocol 2.
  - **CLI and console:** they read and write through core only. `hot-updater api-key` manages keys through the config's `apiKeys()` plugin, and the console runs the config's `plugins`: without them, Insights and API keys are off.

### Patch Changes

- d482b13: Auto-patch bases match what `deploy` chose before the storage engine. `core.findBaseBundleIds` reads the new bundle's Release Catalog scope in one point read and keeps every enabled bundle release whose target app version range intersects the new target (the same fingerprint, in a fingerprint scope), newest release first, each bundle once and older than the new bundle, up to `patch.maxBaseBundles`. Targets such as `1.x`, `*`, or `>=1.2.0 <2` get bases again, a `*` or `1.x` release serves every version it covers, a release on another patch version of the same minor line no longer takes a slot, and a promoted or republished bundle counts from its newest release.

  `targetBaseCandidateKey` takes the channel name instead of its id, and its key names the catalog scope and the normalized range. The `base_candidates` aggregate and its gauge writes are gone, so each release change writes up to 16 fewer rows; the checked-in D1, Postgres, and Supabase schemas drop the table.

- Updated dependencies [152db48]
- Updated dependencies [23a972d]
- Updated dependencies [802374f]
- Updated dependencies [d482b13]
- Updated dependencies [d482b13]
- Updated dependencies [d482b13]
- Updated dependencies [fe03f59]
- Updated dependencies [8d60f68]
- Updated dependencies [294c53f]
- Updated dependencies [d482b13]
- Updated dependencies [94470aa]
- Updated dependencies [2431c0a]
- Updated dependencies [7758a1e]
- Updated dependencies [7ba867c]
- Updated dependencies [94b56f3]
- Updated dependencies [d482b13]
- Updated dependencies [b3576f2]
- Updated dependencies [af15ef3]
- Updated dependencies [aee193e]
- Updated dependencies [0f670c5]
- Updated dependencies [ad00722]
- Updated dependencies [d7df92c]
- Updated dependencies [d482b13]
- Updated dependencies [d482b13]
- Updated dependencies [d482b13]
- Updated dependencies [d482b13]
- Updated dependencies [d3a5570]
- Updated dependencies [d482b13]
- Updated dependencies [d3a5570]
- Updated dependencies [f6ffb68]
- Updated dependencies [d482b13]
- Updated dependencies [c68e9f3]
- Updated dependencies [d482b13]
- Updated dependencies [e542054]
- Updated dependencies [73b8920]
- Updated dependencies [065c457]
- Updated dependencies [8a03eb2]
- Updated dependencies [ff1e565]
- Updated dependencies [d482b13]
- Updated dependencies [aee193e]
- Updated dependencies [152db48]
- Updated dependencies [228b6c7]
- Updated dependencies [eef9466]
- Updated dependencies [065c457]
- Updated dependencies [3f30a23]
- Updated dependencies [065c457]
- Updated dependencies [754a73e]
- Updated dependencies [d482b13]
- Updated dependencies [df31037]
- Updated dependencies [a6c00ec]
  - @hot-updater/server@1.0.0-rc.16
  - @hot-updater/plugin-core@1.0.0-rc.16

## 1.0.0-rc.15

### Minor Changes

- f5fffea: Add atomic Release Insights aggregates, direct release-health and app-usage
  queries, and the redesigned Insights console without reconstructing metrics from
  raw event history.

### Patch Changes

- 79c3eea: Use the versioned manifest artifact protocol for every OTA install. Deploys
  publish a manifest, content-addressed files and one tar.br bulk transport. The
  native installer reuses byte-identical built-in assets and compares tar.br with
  the remaining transfer cost. Complete downloads without patches may additionally
  allow the signed TAR framing overhead to avoid request fanout. Failed archives
  fall back once to verified original files; failed patches recover per file.

  Remove `compressStrategy`, ZIP/gzip OTA extraction, format detection and archive
  strategy branches. Archive identity and bounds belong to the signed manifest;
  Bundle and provider rows stay manifest-based. The unreleased 1.0.0 schema and
  initial migrations now require manifest metadata directly.

  Validate complete descriptor sets before reuse, recheck cached target files,
  and retain hash-verified staging files across retries. Download remaining files
  with a fixed concurrency limit and report only network files in download progress.

  Allow concurrent Supabase deploys to upload the same shared content-addressed
  asset without failing on an already-existing object.

  Authenticate the versioned artifact endpoint. Preserve installed bundles across
  promotion failures and interrupted renames, and require durable metadata before
  activating an OTA. Remove manifestless launch and BUNDLE_ID compatibility paths,
  unused native progress fields, observers, and unused iOS task-state persistence.

- Updated dependencies [f5fffea]
- Updated dependencies [79c3eea]
- Updated dependencies [39f60f9]
  - @hot-updater/plugin-core@1.0.0-rc.15
  - @hot-updater/server@1.0.0-rc.15
  - @hot-updater/core@1.0.0-rc.15

## 1.0.0-rc.14

### Minor Changes

- 479c1e5: Report completed bundle downloads separately from applied updates. Persist the running bundle and pending selection, show Downloaded as waiting to apply, and keep Active, Downloaded, and Recovered totals visible above the activity chart tabs. Defer automatic No change reports until the update check finishes. Keep the unreleased 1.0.0 schema in its existing single initialization migration.
- b23db5e: Replace shared Insights installation storage with canonical events and provider-private indexes for current installation queries. SQL and MongoDB keep nine access fields and fetch full event payloads only for selected results; DynamoDB counts compact scope entries. Custom providers implement `recordEvent({ event })`, `findLatestEvents`, and explicit `countLatestEvents` predicates without lifecycle helpers. Move ancillary event fields into typed `metadata`, reusing Bundle JSON conventions, while preserving SDK requests and Console responses.

  This changes the unreleased 1.0.0 initialization and custom database contract from the previous installation-row design. The read-cost fix preserves the canonical-event contract and keeps current-state queries independent of retained event history. Append and index updates are atomic; measured read/write costs are documented.

### Patch Changes

- Align all Hot Updater packages on 1.0.0-rc.14 for a coordinated release candidate. Future releases continue to use independent package versions.
- Updated dependencies [479c1e5]
- Updated dependencies
- Updated dependencies [b23db5e]
  - @hot-updater/plugin-core@1.0.0-rc.14
  - @hot-updater/core@1.0.0-rc.14

## 1.0.0-rc.3

### Patch Changes

- 663d8e9: Finalize the unreleased v1 Insights contract with three event types: UPDATE_APPLIED, UNCHANGED, and RECOVERED. Same-file release selection reports UNCHANGED with null source bundle and update strategy while retaining release IDs. Remove RELEASE_ADOPTED from SDK payloads, server ingestion, database validators, and initial v1 schemas. No compatibility alias is accepted.

  Replace adopted outcomes and counters with unchanged in the Insights query API. Refresh all v1 SDK and infrastructure packages together; existing prerelease development databases require their obsolete event rows and constraints to be updated before using this contract.

- Updated dependencies [663d8e9]
  - @hot-updater/plugin-core@1.0.0-rc.3

## 1.0.0-rc.2

### Minor Changes

- 51300d4: Define the required Insights persistence contract as `record`, `listEvents`,
  object-based `findInstallations`, `countInstallations`, and `countEvents`. Core
  owns report preparation, filters, windows, cursors, and summaries; providers
  implement atomic report/latest-state storage, fixed indexed queries, and scalar
  counts. Duplicate event IDs are first-write-wins and never update installation
  state again.

  Add scoped recent-reporting counts and selected-bundle applied, recovered-from,
  and adopted report counts with matching event drill-down in Console. Recovery
  from B to A belongs to B's recovery count while latest state names A. Counts
  remain independent live measurements and do not claim an exact share or success
  rate.

  Include all Insights indexes and native writers in the initial `1.0.0` schema.
  MongoDB Insights requires native transactions on a replica set or sharded
  cluster. Regenerate standalone ORM schemas and apply emitted Prisma collation
  SQL where required.

  Prisma SQL Server Insights explicitly rejects before database I/O because its
  string identity/order semantics do not meet this contract; other models remain
  available. MongoDB counts require version 5+ snapshot reads.

### Patch Changes

- Updated dependencies [51300d4]
- Updated dependencies [590ca70]
- Updated dependencies [a837c71]
  - @hot-updater/plugin-core@1.0.0-rc.2

## 1.0.0-rc.1

### Minor Changes

- 6d0cdc7: Rename the built-in Analytics domain to Insights across the database model,
  server provider and HTTP query route, React Native option and transport,
  Console route and UI, and provider contracts. This is a breaking pre-release
  rename with no compatibility aliases; use `database.models.insights`,
  `createInsightsProvider`, `/bundles/:id/events/insights`, and `insights`.

  Enable React Native Insights reporting by default for both `HotUpdater.init`
  and `HotUpdater.wrap`. Set `insights: false` to opt out.

### Patch Changes

- Updated dependencies [6d0cdc7]
- Updated dependencies [8145d48]
  - @hot-updater/plugin-core@1.0.0-rc.1

## 1.0.0-rc.0

### Major Changes

- adb0e40: Release HotUpdater 1.0 with the Release Catalog architecture.

### Minor Changes

- 3b367e7: Add built-in API key authentication backed by the official
  `database.models.apiKeys` domain. Every `createHotUpdater` call must set
  `clientAccess` explicitly. `{ type: "api-key" }` protects OTA reads and
  Analytics ingestion with `x-api-key` by default; it does not grant Analytics
  query, Bundle management, or API key management access.

  Add `hot-updater api-key create`, `list`, and `revoke` for self-hosted
  deployments. Creation returns the plaintext API key exactly once, while the
  database stores only its SHA-256 hash and non-secret metadata. Managed AWS,
  Cloudflare, Firebase, and Supabase init use the same API key domain and persist
  the plaintext only in the local `HOT_UPDATER_API_KEY` environment entry.
  Console API key management uses the same domain directly.
  `createHotUpdater(...).apiKeys` exposes the common local create, list, and
  revoke management API without adding an HTTP management route.
  Self-hosted setup now recommends the `api-key` client policy: migrate the direct
  database, create a key from the same config, then pass the one-time plaintext to
  React Native through `x-api-key`. The `public` policy remains an explicit
  unauthenticated alternative.

  Rename the pre-release public API and storage terminology from Client Access
  Key to API Key, including `database.models.apiKeys`, `ApiKeyModel`,
  `ApiKeyRow`, `createApiKey`, and `registerApiKey`. Fresh v1 provider schemas use
  the canonical API key naming and do not migrate or reuse v0 databases.

  Remove the separate Better Auth package, generic authentication provider,
  managed route policy, universal component schema, and provisioning preset.

- b424d47: Replace the legacy database plugin API with the fixed official-domain contract:

  ```ts
  createDatabasePlugin({
    name,
    models: {
      bundles,
      bundlePatches,
      releases,
      releaseCatalogs,
      channels,
      analytics,
      apiKeys,
    },
    commit,
    dispose,
  });
  ```

  Provider callback transactions, generic CRUD, factories, runtime contexts,
  capability registries, `commitBatch`, and the former top-level model and query
  members are no longer public. `commit({ changes })` is now a declarative,
  ordered, atomic write boundary across every official model. Expected missing-row
  and live-reference conflicts identify the original change index; failed commits
  roll back all earlier changes. Providers without a suitable atomic primitive
  reject a multi-change commit before its first write.

  Add Channels as a normalized, persistent model with opaque `id` and exact,
  case-sensitive `name`. Channel IDs and names are non-empty and limited to 255
  Unicode code points. Releases reference `channel_id`; immutable Bundle rows do
  not carry Channel or delivery-policy fields. Channel listing reads the Channel
  model directly instead of scanning Bundles. Channels remain after their last
  Release is removed and can be deleted explicitly only when no Release references
  them.

  Schema `1.0.0` creates Channel, Bundle, Bundle patch, Release, Release Catalog,
  Analytics, and API key storage on an empty database. It rejects v0
  schema markers and does not backfill Bundle policy. Kysely, Drizzle, Prisma,
  MongoDB, Cloudflare D1, PostgreSQL, Supabase, Firebase, DynamoDB, and Mock
  implement the same logical contract.

  Add mount-relative Channel admin routes: `GET /channels`, `POST /channels`, and
  empty-only `DELETE /channels/:id`. With the recommended mount these are exposed
  under `/hot-updater/admin/channels`. Remove the legacy
  `/api/bundles/channels` route. Standalone remains a narrower remote
  `BundleRepository`, while self-hosted `createHotUpdater` owns the full database
  contract. The Console can create Channels and request safe deletion; a concurrent
  Release reference is reported as `not_empty` without losing data.

  Official providers implement the fixed access patterns used by the shared
  client: exact domain filters, id ordering, bounded pagination, row counts,
  patch lookup by owner IDs, exact Catalog reads, strongly consistent Release
  scope reads, and atomic ordered changes across official models. Provider-owned
  update selection and arbitrary distinct, projection, connector, and
  string-comparison query DSL operations are no longer part of the public
  database plugin contract. Cloudflare D1 rejects malformed count results instead
  of returning zero.

  The shared database client resolves the canonical Channel row before Release
  writes and compiles affected Catalogs in the same atomic commit. The v0
  `queries.getUpdateInfo` optimization and combined Bundle-policy writes are
  removed. `@hot-updater/test-utils` publishes conformance coverage for all-model
  commits, rollback, Channel persistence, canonical concurrent inserts, safe
  deletion, and the absence of bundle-scan Channel reads.

  Runtime-specific composition entrypoints keep the same provider names behind
  explicit package subpaths. `@hot-updater/cloudflare/worker` accepts a native D1
  binding through `d1Database(database)`, while `@hot-updater/supabase/edge`
  exports the Edge-compatible `supabaseDatabase` and `supabaseStorage`. Root
  entrypoints remain the configuration-time providers.

  Self-hosted runtimes always expose Analytics ingestion and query capabilities
  backed by `database.models.analytics`. Every `createHotUpdater` call explicitly
  sets the required `clientAccess` policy, which can protect update checks and
  Analytics ingestion through
  `database.models.apiKeys`. Client update routes are always available
  on `handlers.client`, while admin routes are exposed only by explicitly
  mounting `handlers.admin`. The CLI-only
  `standaloneRepository` stays a bundle repository; the physical database passed
  to the self-hosted `createHotUpdater` instance owns the full official contract.

- 5a2e1cd: Separate immutable Bundle artifacts from mutable Release policy and compile
  policy changes ahead of time into deterministic Release catalogs.
  Database plugins now expose Release and catalog models plus atomic Release
  revision/catalog generation expectations, and no longer expose provider update
  decision queries.

  Add canonical v2 Release-catalog and Bundle-artifact routes, short-lived
  authenticated shared caching, a v1-only device protocol boundary, Release
  management commands, catalog preflight/rebuild tooling, and a familiar Bundle
  management view backed by Releases. The Console keeps Bundle content, delivery settings,
  promote, and download actions in one workflow while Release identity stays
  secondary. Deploy and promote create Releases; rollback disables the current
  Release so clients select the previous compatible enabled Release or the
  built-in app. Rollout, targeting, enablement, and messages mutate Releases
  while patch, manifest, signing, and storage behavior remain Bundle-keyed.
  Release IDs are canonical UUIDv7 values. Console shadcn primitives now use Base
  UI instead of Radix while preserving the existing management flow and visual
  density.

  React Native clients select desired Releases locally, persist authority/scope
  generation high-water and full Release/Bundle receipts, support same-Bundle
  adoption and authenticated BUILTIN fallback, and use generation/context CAS so
  stale artifact work cannot commit. New catalogs retain an 11-artifact update
  frontier plus the complete compatible enabled rollback spine, so rollback keeps
  v0 predecessor semantics even for old active clients. The 256 KiB catalog cap
  remains atomic: an oversized history rejects the Release mutation instead of
  silently truncating rollback candidates. Analytics events now carry directional
  Release identity alongside Bundle identity.

  Migrate SQL, DynamoDB, D1, Firestore, Supabase, MongoDB, Drizzle, Kysely,
  Prisma, Standalone, mock, and in-memory implementations to schema `1.0.0`.
  Managed AWS and Cloudflare deployments place Release catalogs behind their
  supported pre-origin cache. Firebase and Supabase use their direct Function
  URLs as supported origin-only modes and report Function invocations separately
  from database catalog reads.

- e2455c5: Remove user-managed Catalog authority from configuration, generated provider
  environments, deployment output, and public React Native update state. Catalogs
  receive an opaque identity on their first atomic commit and preserve it across
  updates, rebuilds, and tombstones. CLI and server share the persisted identity
  without configuration. Native stale-generation and unexpected-Catalog guards
  remain in place.

  This changes the unreleased v1 database schema and internal JS/native protocol
  together. Catalog rows are part of persistent history and must be included in
  backups; a missing row with retained Releases cannot be regenerated safely.

- 7ec1a46: Persist required immutable archive and patch byte sizes across the initial v1
  Bundle contract and official database providers. This pre-release change has no
  general cross-provider backfill for earlier unreleased `1.0.0` schemas. DynamoDB
  readers default a missing archive byte size on existing Bundle rows to zero,
  while Cloudflare applies an incremental D1 migration that backfills missing
  Bundle and patch byte sizes with zero.

  Record optional exact served-object sizes and hashes in Bundle manifests,
  content-address new Brotli payloads by their compressed hash, and let the
  server select the archive when known normal diff bytes are equal to or larger
  than it. Unknown optional manifest metadata preserves the existing
  manifest-first path, with no native protocol change or request-time storage
  metadata probe.

- a9ffb2a: Create schema 1.0.0 from empty databases only. `db migrate` and `db generate` no longer accept or upgrade v0 schema markers, and managed SQL templates are a single 1.0.0 CREATE.

### Patch Changes

- a9ffb2a: Remove leftover v0 aliases that are not field compatibility. `HotUpdater.wrap({ updateMode: "manual" })` throws, findMany accepts only `orderBy`, and Supabase plugins require `supabaseServiceRoleKey`. Managed init still detects leftover `supabaseAnonKey` so skipped v0 configs fail closed.
- Updated dependencies [3b367e7]
- Updated dependencies [b424d47]
- Updated dependencies [9650748]
- Updated dependencies [88c163a]
- Updated dependencies [a9ffb2a]
- Updated dependencies [a9ffb2a]
- Updated dependencies [5a2e1cd]
- Updated dependencies [adb0e40]
- Updated dependencies [e2455c5]
- Updated dependencies [25af6ef]
- Updated dependencies [c355c26]
- Updated dependencies [7ec1a46]
- Updated dependencies [a9ffb2a]
  - @hot-updater/plugin-core@1.0.0-rc.0
  - @hot-updater/core@1.0.0-rc.0

## Unreleased

### Minor Changes

- Replace the aggregate PostgreSQL database plugin with the fixed `bundles`
  and `bundle_patches` row contract.
- Implement exact single- and compound-field distinct counts, ordered
  `distinctOn`, and every requested order clause, including an explicit `id`
  tie-break.

## 0.36.0

### Patch Changes

- Updated dependencies [9759e8a]
  - @hot-updater/plugin-core@0.36.0
  - @hot-updater/core@0.36.0

## 0.35.12

### Patch Changes

- Updated dependencies [6e8b32e]
  - @hot-updater/plugin-core@0.35.12
  - @hot-updater/core@0.35.12

## 0.35.11

### Patch Changes

- Updated dependencies [1a3a621]
  - @hot-updater/plugin-core@0.35.11
  - @hot-updater/core@0.35.11

## 0.35.10

### Patch Changes

- Updated dependencies [ce8d254]
  - @hot-updater/plugin-core@0.35.10
  - @hot-updater/core@0.35.10

## 0.35.9

### Patch Changes

- @hot-updater/core@0.35.9
- @hot-updater/plugin-core@0.35.9

## 0.35.8

### Patch Changes

- @hot-updater/core@0.35.8
- @hot-updater/plugin-core@0.35.8

## 0.35.7

### Patch Changes

- @hot-updater/core@0.35.7
- @hot-updater/plugin-core@0.35.7

## 0.35.6

### Patch Changes

- @hot-updater/core@0.35.6
- @hot-updater/plugin-core@0.35.6

## 0.35.5

### Patch Changes

- @hot-updater/core@0.35.5
- @hot-updater/plugin-core@0.35.5

## 0.35.4

### Patch Changes

- @hot-updater/core@0.35.4
- @hot-updater/plugin-core@0.35.4

## 0.35.3

### Patch Changes

- @hot-updater/core@0.35.3
- @hot-updater/plugin-core@0.35.3

## 0.35.2

### Patch Changes

- @hot-updater/core@0.35.2
- @hot-updater/plugin-core@0.35.2

## 0.35.1

### Patch Changes

- @hot-updater/core@0.35.1
- @hot-updater/plugin-core@0.35.1

## 0.35.0

### Patch Changes

- @hot-updater/core@0.35.0
- @hot-updater/plugin-core@0.35.0

## 0.34.0

### Patch Changes

- Updated dependencies [088f6c1]
- Updated dependencies [7244b65]
  - @hot-updater/plugin-core@0.34.0
  - @hot-updater/core@0.34.0

## 0.33.2

### Patch Changes

- @hot-updater/core@0.33.2
- @hot-updater/plugin-core@0.33.2

## 0.33.1

### Patch Changes

- Updated dependencies [a5c4467]
  - @hot-updater/plugin-core@0.33.1
  - @hot-updater/core@0.33.1

## 0.33.0

### Patch Changes

- Updated dependencies [e914f56]
  - @hot-updater/plugin-core@0.33.0
  - @hot-updater/core@0.33.0

## 0.32.0

### Patch Changes

- Updated dependencies [4e6d2ec]
  - @hot-updater/plugin-core@0.32.0
  - @hot-updater/core@0.32.0

## 0.31.4

### Patch Changes

- @hot-updater/core@0.31.4
- @hot-updater/plugin-core@0.31.4

## 0.31.3

### Patch Changes

- @hot-updater/core@0.31.3
- @hot-updater/plugin-core@0.31.3

## 0.31.2

### Patch Changes

- @hot-updater/core@0.31.2
- @hot-updater/plugin-core@0.31.2

## 0.31.1

### Patch Changes

- @hot-updater/core@0.31.1
- @hot-updater/plugin-core@0.31.1

## 0.31.0

### Minor Changes

- 5b0a0f5: Add signed manifest-based diff update support across deploy, server, provider storage, console tooling, and React Native runtime.

### Patch Changes

- Updated dependencies [5b0a0f5]
- Updated dependencies [5b0a0f5]
  - @hot-updater/core@0.31.0
  - @hot-updater/plugin-core@0.31.0

## 0.30.12

### Patch Changes

- @hot-updater/core@0.30.12
- @hot-updater/plugin-core@0.30.12

## 0.30.11

### Patch Changes

- @hot-updater/core@0.30.11
- @hot-updater/plugin-core@0.30.11

## 0.30.10

### Patch Changes

- @hot-updater/core@0.30.10
- @hot-updater/plugin-core@0.30.10

## 0.30.9

### Patch Changes

- @hot-updater/core@0.30.9
- @hot-updater/plugin-core@0.30.9

## 0.30.8

### Patch Changes

- Updated dependencies [6019156]
  - @hot-updater/plugin-core@0.30.8
  - @hot-updater/core@0.30.8

## 0.30.7

### Patch Changes

- @hot-updater/core@0.30.7
- @hot-updater/plugin-core@0.30.7

## 0.30.6

### Patch Changes

- @hot-updater/core@0.30.6
- @hot-updater/plugin-core@0.30.6

## 0.30.5

### Patch Changes

- @hot-updater/core@0.30.5
- @hot-updater/plugin-core@0.30.5

## 0.30.4

### Patch Changes

- @hot-updater/core@0.30.4
- @hot-updater/plugin-core@0.30.4

## 0.30.3

### Patch Changes

- @hot-updater/core@0.30.3
- @hot-updater/plugin-core@0.30.3

## 0.30.2

### Patch Changes

- @hot-updater/core@0.30.2
- @hot-updater/plugin-core@0.30.2

## 0.30.1

### Patch Changes

- @hot-updater/core@0.30.1
- @hot-updater/plugin-core@0.30.1

## 0.30.0

### Minor Changes

- 83c01c8: fix: keep target cohorts additive to rollout

### Patch Changes

- Updated dependencies [83c01c8]
  - @hot-updater/core@0.30.0
  - @hot-updater/plugin-core@0.30.0

## 0.29.8

### Patch Changes

- @hot-updater/core@0.29.8
- @hot-updater/plugin-core@0.29.8

## 0.29.7

### Patch Changes

- @hot-updater/core@0.29.7
- @hot-updater/plugin-core@0.29.7

## 0.29.6

### Patch Changes

- @hot-updater/core@0.29.6
- @hot-updater/plugin-core@0.29.6

## 0.29.5

### Patch Changes

- Updated dependencies [52208f4]
  - @hot-updater/plugin-core@0.29.5
  - @hot-updater/core@0.29.5

## 0.29.4

### Patch Changes

- @hot-updater/core@0.29.4
- @hot-updater/plugin-core@0.29.4

## 0.29.3

### Patch Changes

- Updated dependencies [d1ffb83]
  - @hot-updater/plugin-core@0.29.3
  - @hot-updater/core@0.29.3

## 0.29.2

### Patch Changes

- Updated dependencies [2a1bc80]
  - @hot-updater/core@0.29.2
  - @hot-updater/plugin-core@0.29.2

## 0.29.1

### Patch Changes

- @hot-updater/core@0.29.1
- @hot-updater/plugin-core@0.29.1

## 0.29.0

### Minor Changes

- a935992: feat: Rollout feature with control from 1% to 100%

### Patch Changes

- d0fe908: fix(console): rebuild copied bundles with fresh uuidv7 ids
- Updated dependencies [a935992]
- Updated dependencies [d0fe908]
  - @hot-updater/plugin-core@0.29.0
  - @hot-updater/core@0.29.0

## 0.28.0

### Patch Changes

- @hot-updater/core@0.28.0
- @hot-updater/plugin-core@0.28.0

## 0.27.1

### Patch Changes

- @hot-updater/core@0.27.1
- @hot-updater/plugin-core@0.27.1

## 0.27.0

### Minor Changes

- 81f9437: feat(android): for safe reloading, Android reloads the process (#869)

### Patch Changes

- Updated dependencies [81f9437]
  - @hot-updater/core@0.27.0
  - @hot-updater/plugin-core@0.27.0

## 0.26.2

### Patch Changes

- @hot-updater/core@0.26.2
- @hot-updater/plugin-core@0.26.2

## 0.26.1

### Patch Changes

- @hot-updater/core@0.26.1
- @hot-updater/plugin-core@0.26.1

## 0.26.0

### Patch Changes

- @hot-updater/core@0.26.0
- @hot-updater/plugin-core@0.26.0

## 0.25.14

### Patch Changes

- @hot-updater/core@0.25.14
- @hot-updater/plugin-core@0.25.14

## 0.25.13

### Patch Changes

- @hot-updater/core@0.25.13
- @hot-updater/plugin-core@0.25.13

## 0.25.12

### Patch Changes

- @hot-updater/core@0.25.12
- @hot-updater/plugin-core@0.25.12

## 0.25.11

### Patch Changes

- @hot-updater/core@0.25.11
- @hot-updater/plugin-core@0.25.11

## 0.25.10

### Patch Changes

- Updated dependencies [03c5adc]
  - @hot-updater/plugin-core@0.25.10
  - @hot-updater/core@0.25.10

## 0.25.9

### Patch Changes

- Updated dependencies [6b22072]
  - @hot-updater/plugin-core@0.25.9
  - @hot-updater/core@0.25.9

## 0.25.8

### Patch Changes

- @hot-updater/core@0.25.8
- @hot-updater/plugin-core@0.25.8

## 0.25.7

### Patch Changes

- @hot-updater/core@0.25.7
- @hot-updater/plugin-core@0.25.7

## 0.25.6

### Patch Changes

- @hot-updater/core@0.25.6
- @hot-updater/plugin-core@0.25.6

## 0.25.5

### Patch Changes

- @hot-updater/core@0.25.5
- @hot-updater/plugin-core@0.25.5

## 0.25.4

### Patch Changes

- @hot-updater/core@0.25.4
- @hot-updater/plugin-core@0.25.4

## 0.25.3

### Patch Changes

- @hot-updater/core@0.25.3
- @hot-updater/plugin-core@0.25.3

## 0.25.2

### Patch Changes

- @hot-updater/core@0.25.2
- @hot-updater/plugin-core@0.25.2

## 0.25.1

### Patch Changes

- @hot-updater/core@0.25.1
- @hot-updater/plugin-core@0.25.1

## 0.25.0

### Patch Changes

- @hot-updater/core@0.25.0
- @hot-updater/plugin-core@0.25.0

## 0.24.7

### Patch Changes

- 294e324: fix: update babel plugin path in documentation and plugin files
- Updated dependencies [294e324]
  - @hot-updater/core@0.24.7
  - @hot-updater/plugin-core@0.24.7

## 0.24.6

### Patch Changes

- @hot-updater/core@0.24.6
- @hot-updater/plugin-core@0.24.6

## 0.24.5

### Patch Changes

- @hot-updater/core@0.24.5
- @hot-updater/plugin-core@0.24.5

## 0.24.4

### Patch Changes

- Updated dependencies [7ed539f]
  - @hot-updater/plugin-core@0.24.4
  - @hot-updater/core@0.24.4

## 0.24.3

### Patch Changes

- @hot-updater/core@0.24.3
- @hot-updater/plugin-core@0.24.3

## 0.24.2

### Patch Changes

- @hot-updater/core@0.24.2
- @hot-updater/plugin-core@0.24.2

## 0.24.1

### Patch Changes

- @hot-updater/core@0.24.1
- @hot-updater/plugin-core@0.24.1

## 0.24.0

### Patch Changes

- @hot-updater/core@0.24.0
- @hot-updater/plugin-core@0.24.0

## 0.23.1

### Patch Changes

- @hot-updater/core@0.23.1
- @hot-updater/plugin-core@0.23.1

## 0.23.0

### Patch Changes

- Updated dependencies [e41fb6b]
  - @hot-updater/core@0.23.0
  - @hot-updater/plugin-core@0.23.0

## 0.22.2

### Patch Changes

- @hot-updater/core@0.22.2
- @hot-updater/plugin-core@0.22.2

## 0.22.1

### Patch Changes

- @hot-updater/core@0.22.1
- @hot-updater/plugin-core@0.22.1

## 0.22.0

### Patch Changes

- @hot-updater/core@0.22.0
- @hot-updater/plugin-core@0.22.0

## 0.21.15

### Patch Changes

- @hot-updater/plugin-core@0.21.15
- @hot-updater/core@0.21.15

## 0.21.14

### Patch Changes

- @hot-updater/core@0.21.14
- @hot-updater/plugin-core@0.21.14

## 0.21.13

### Patch Changes

- @hot-updater/core@0.21.13
- @hot-updater/plugin-core@0.21.13

## 0.21.12

### Patch Changes

- Updated dependencies [5c4b98e]
  - @hot-updater/plugin-core@0.21.12
  - @hot-updater/core@0.21.12

## 0.21.11

### Patch Changes

- e2b67d7: fix(cli-tools): esm only package bundle
- Updated dependencies [e2b67d7]
  - @hot-updater/core@0.21.11
  - @hot-updater/plugin-core@0.21.11

## 0.21.10

### Patch Changes

- @hot-updater/plugin-core@0.21.10
- @hot-updater/core@0.21.10

## 0.21.9

### Patch Changes

- Updated dependencies [aa399a6]
  - @hot-updater/plugin-core@0.21.9
  - @hot-updater/core@0.21.9

## 0.21.8

### Patch Changes

- Updated dependencies [3fe8c81]
  - @hot-updater/plugin-core@0.21.8
  - @hot-updater/core@0.21.8

## 0.21.7

### Patch Changes

- Updated dependencies [2b408f2]
  - @hot-updater/plugin-core@0.21.7
  - @hot-updater/core@0.21.7

## 0.21.6

### Patch Changes

- @hot-updater/core@0.21.6
- @hot-updater/plugin-core@0.21.6

## 0.21.5

### Patch Changes

- @hot-updater/core@0.21.5
- @hot-updater/plugin-core@0.21.5

## 0.21.4

### Patch Changes

- Updated dependencies [5d3070a]
  - @hot-updater/plugin-core@0.21.4
  - @hot-updater/core@0.21.4

## 0.21.3

### Patch Changes

- @hot-updater/core@0.21.3
- @hot-updater/plugin-core@0.21.3

## 0.21.2

### Patch Changes

- @hot-updater/core@0.21.2
- @hot-updater/plugin-core@0.21.2

## 0.21.1

### Patch Changes

- Updated dependencies [7b7bc48]
  - @hot-updater/plugin-core@0.21.1
  - @hot-updater/core@0.21.1

## 0.22.0

### Minor Changes

- afb084b: feat: validate bundle file with fileHash
- 036f8f0: feat: support `@hot-updater/server` for self-hosted (WIP)

### Patch Changes

- Updated dependencies [610b2dd]
- Updated dependencies [afb084b]
- Updated dependencies [036f8f0]
  - @hot-updater/plugin-core@0.22.0
  - @hot-updater/core@0.22.0

## 0.20.15

### Patch Changes

- Updated dependencies [526a5ba]
- Updated dependencies [ddf6f2c]
  - @hot-updater/plugin-core@0.20.15
  - @hot-updater/core@0.20.15

## 0.20.14

### Patch Changes

- Updated dependencies [a61fa0e]
  - @hot-updater/plugin-core@0.20.14
  - @hot-updater/core@0.20.14

## 0.20.13

### Patch Changes

- @hot-updater/core@0.20.13
- @hot-updater/plugin-core@0.20.13

## 0.20.12

### Patch Changes

- @hot-updater/core@0.20.12
- @hot-updater/plugin-core@0.20.12

## 0.20.11

### Patch Changes

- Updated dependencies [cb9c05b]
  - @hot-updater/plugin-core@0.20.11
  - @hot-updater/core@0.20.11

## 0.20.10

### Patch Changes

- @hot-updater/core@0.20.10
- @hot-updater/plugin-core@0.20.10

## 0.20.9

### Patch Changes

- @hot-updater/core@0.20.9
- @hot-updater/plugin-core@0.20.9

## 0.20.8

### Patch Changes

- Updated dependencies [ad7c999]
  - @hot-updater/plugin-core@0.20.8
  - @hot-updater/core@0.20.8

## 0.20.7

### Patch Changes

- a92992c: chore(tsdown): failOnWarn true
- Updated dependencies [a92992c]
  - @hot-updater/plugin-core@0.20.7
  - @hot-updater/core@0.20.7

## 0.20.6

### Patch Changes

- Updated dependencies [6a905d8]
  - @hot-updater/plugin-core@0.20.6
  - @hot-updater/core@0.20.6

## 0.20.5

### Patch Changes

- @hot-updater/core@0.20.5
- @hot-updater/plugin-core@0.20.5

## 0.20.4

### Patch Changes

- Updated dependencies [5314b31]
- Updated dependencies [711392b]
  - @hot-updater/plugin-core@0.20.4
  - @hot-updater/core@0.20.4

## 0.20.3

### Patch Changes

- Updated dependencies [e63056a]
  - @hot-updater/plugin-core@0.20.3
  - @hot-updater/core@0.20.3

## 0.20.2

### Patch Changes

- Updated dependencies [0e78fb0]
  - @hot-updater/plugin-core@0.20.2
  - @hot-updater/core@0.20.2

## 0.20.1

### Patch Changes

- Updated dependencies [a3a4a28]
  - @hot-updater/plugin-core@0.20.1
  - @hot-updater/core@0.20.1

## 0.20.0

### Patch Changes

- Updated dependencies [bc8e23d]
  - @hot-updater/plugin-core@0.20.0
  - @hot-updater/core@0.20.0

## 0.19.10

### Patch Changes

- Updated dependencies [2bc52e8]
  - @hot-updater/plugin-core@0.19.10
  - @hot-updater/core@0.19.10

## 0.19.9

### Patch Changes

- @hot-updater/core@0.19.9
- @hot-updater/plugin-core@0.19.9

## 0.19.8

### Patch Changes

- @hot-updater/core@0.19.8
- @hot-updater/plugin-core@0.19.8

## 0.19.7

### Patch Changes

- @hot-updater/core@0.19.7
- @hot-updater/plugin-core@0.19.7

## 0.19.6

### Patch Changes

- Updated dependencies [657a10e]
  - @hot-updater/plugin-core@0.19.6
  - @hot-updater/core@0.19.6

## 0.19.5

### Patch Changes

- 40d28c2: bump rnef
- Updated dependencies [40d28c2]
  - @hot-updater/core@0.19.5
  - @hot-updater/plugin-core@0.19.5

## 0.19.4

### Patch Changes

- Updated dependencies [0ddc955]
  - @hot-updater/plugin-core@0.19.4
  - @hot-updater/core@0.19.4

## 0.19.3

### Patch Changes

- Updated dependencies [0c0ab1d]
  - @hot-updater/plugin-core@0.19.3
  - @hot-updater/core@0.19.3

## 0.19.2

### Patch Changes

- @hot-updater/core@0.19.2
- @hot-updater/plugin-core@0.19.2

## 0.19.1

### Patch Changes

- @hot-updater/core@0.19.1
- @hot-updater/plugin-core@0.19.1

## 0.19.0

### Patch Changes

- Updated dependencies [886809d]
  - @hot-updater/plugin-core@0.19.0
  - @hot-updater/core@0.19.0

## 0.18.5

### Patch Changes

- 494ce31: feat: delete Bundle
- Updated dependencies [494ce31]
  - @hot-updater/plugin-core@0.18.5
  - @hot-updater/core@0.18.5

## 0.18.4

### Patch Changes

- @hot-updater/core@0.18.4
- @hot-updater/plugin-core@0.18.4

## 0.18.3

### Patch Changes

- @hot-updater/core@0.18.3
- @hot-updater/plugin-core@0.18.3

## 0.18.2

### Patch Changes

- 437c98e: fix: pagination doesn't work (edit database spec)
- Updated dependencies [437c98e]
  - @hot-updater/plugin-core@0.18.2
  - @hot-updater/core@0.18.2

## 0.18.1

### Patch Changes

- @hot-updater/core@0.18.1
- @hot-updater/plugin-core@0.18.1

## 0.18.0

### Minor Changes

- 73ec434: fingerprint-based update stratgy

### Patch Changes

- Updated dependencies [73ec434]
  - @hot-updater/plugin-core@0.18.0
  - @hot-updater/core@0.18.0
