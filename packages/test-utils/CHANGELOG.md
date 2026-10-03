# @hot-updater/test-utils

## 1.0.0-rc.28

### Patch Changes

- 80bb792: Attach the latest catalog or artifact HTTP response to existing Insights reports without adding requests or changing launch/failure deduplication. Preserve successful, cached, and failed response text with a bounded body and its original observation timestamp. Console exposes the response from event and installation details and alongside error investigation. No database migration is required.

## 1.0.0-rc.27

### Patch Changes

- Improve the readability of Console update failures by grouping check metrics separately, emphasizing nonzero failures, and making stage/reason details easier to scan. Preserve all report data and rate calculations. Prepare all public Hot Updater packages together as 1.0.0-rc.27.

## 1.0.0-rc.26

### Patch Changes

- c9cfed7: Restore the rc.14 Insights metric layout in bundle rows and details while preserving current data, rates, links, and download failure reporting. Release all public Hot Updater packages together as 1.0.0-rc.26.

## 1.0.0-rc.25

### Patch Changes

- c9cfed7: Release the legacy Hermes fallback correction at 1.0.0-rc.25 with all public Hot Updater packages on the same RC.

## 1.0.0-rc.24

### Patch Changes

- c9cfed7: Release the project-scoped Expo, fingerprint, React Native, and Hermes resolution fixes at 1.0.0-rc.24 so projects can install the same RC of every Hot Updater package.

## 1.0.0-rc.23

### Patch Changes

- c9cfed7: Release with the Expo SDK 58 config fix at 1.0.0-rc.23 so projects can install the same RC of every Hot Updater package.

## 1.0.0-rc.22

### Minor Changes

- 54d46fe: `setupStorageAdapterTestSuite` takes `fetchDownloadUrls`. With it, the suite fetches every `http(s)` URL `getDownloadUrl` returns and requires the object's bytes. Set it when the adapter runs against a bucket or emulator whose URLs the test can reach.

## 1.0.0-rc.21

### Minor Changes

- 5ec6796: CLI commands exist only for user workflows. Checks move into `hot-updater doctor`, which can now repair what it finds with `--fix`, and plumbing commands are removed, with no aliases:
  - `hot-updater app-version` is removed. `doctor` shows each platform's app version in its native status, as `appVersion` in `--json`.
  - Bare `hot-updater channel` shows help. `doctor` shows the native default channels, and `channel set` stays.
  - Bare `hot-updater fingerprint` shows help. Under the fingerprint update strategy, `doctor` compares `fingerprint.json` with the project's fingerprint and reports `FINGERPRINT_JSON_STALE` with the sources that changed, or `FINGERPRINT_GENERATION_FAILED`. `fingerprint create` stays.
  - `hot-updater db catalog preflight` and `db catalog rebuild` are removed. When `hot-updater.config.ts` sets `database`, `doctor` opens it once per run and checks every scope that has a catalog row or a release:
    - `RELEASE_CATALOG_STALE` is a catalog that differs from a rebuild from its releases;
    - `RELEASE_CATALOG_IDENTITY_MISSING` is a scope whose releases have no catalog row, which devices get 404 for. The row must be restored from backup;
    - `RELEASE_CATALOG_CHECK_FAILED` is a scope core cannot compile, reported beside the other scopes' results;
    - a database doctor cannot reach is the warning `RELEASE_CATALOGS_UNCHECKED`, never a failure.
  - `hot-updater bundle preflight` is removed. `bundle update --dry-run` takes the same options and validates the update and shows the projected catalog, without saving or asking.
  - `hot-updater bundle artifact delete` is removed. Deleting a release deletes its artifact record when no other release uses it, whether the CLI, the console, or the admin API deletes it.
    - Every patch to or from that artifact goes with it, so a device running the deleted bundle downloads its next update in full.
    - `bundle delete` says so, and its `--json` output names the artifact in `deletedArtifactId`.
    - Stored files stay until `storage prune`.
    - Artifact records that an earlier release candidate's `bundle delete` left behind show up in `doctor` as `UNREFERENCED_ARTIFACTS`. `doctor --fix` deletes them, and `storage prune` then reclaims their files.
  - `hot-updater patch` no longer takes the hidden `--bundle-id` and `--base-bundle-id` aliases. Use `--artifact-id` and `--base-artifact-id`.
  - `hot-updater keys export-public` no longer takes `-i, --input <path>`. It exports the configured signing key.
  - `hot-updater build:android` needs `EXPERIMENTAL`, like `build:ios`, `run:android`, and `run:ios`.

  `hot-updater doctor --fix` runs the repairs doctor can make itself:
  - it rebuilds stale release catalogs from their releases;
  - it deletes the artifact records no release uses;
  - it writes what `fingerprint create` writes, where it differs;
  - it writes what `keys export-public --yes` writes.

  It names every write, in the output and in `details.fixes`, and checks again.

  It skips native files that `expo prebuild` generates. It never removes a public key: an issue with more than one remedy, such as `ORPHAN_PUBLIC_KEY`, stays report-only. When it wrote a native file, it ends by asking for a native rebuild.

  `@hot-updater/protocol` exports `parseReleaseCatalog`, the check a client runs on a fetched release catalog, with `hasExpectedReleaseCatalogScope`, `ExpectedReleaseCatalogScope`, `MAX_RELEASE_CATALOG_WIRE_BYTES`, and `getUtf8ByteLength`. The React Native update client and doctor's server checks both run it.

  `@hot-updater/test-utils` exports `storeBundles`, which stores bundles with no release through the storage engine.

- db4e053: Add `@hot-updater/test-utils/react-native` for testing client plugins. `setupClientPlugin(plugin, options)` and `setupClientPlugins(plugins, options)` set plugins up on the plugin host `@hot-updater/react-native` runs them on in an app, as `HotUpdater.init` does, so plugin ids are checked the same way. They return:
  - `hooks`: `onAppReady`, `onUpdateCheck`, `onBundleDownloaded`, and `onUpdateError`, called as the SDK calls them: the call doesn't wait for the hook, and a throw or rejection lands in `errors` instead of being raised.
  - `requests`: what plugins sent with `context.fetch`, with `requestHeaders` applied. The test's `respond` handler answers each request, or it gets `204 No Content`.
  - `storage`: each plugin's in-memory storage, scoped by plugin id and capped at 64 KB as on a device. Pass it to the next setup, or seed one from `createTestStorage()`, to start the plugins again on the same device.
  - `settled()`, which waits for the hooks called so far and the requests they started.

  The device's values (install id, platform, app version, bundle, channel, cohort, fingerprint hash, and clock) have fixed defaults, and a test can set each one. The subpath ships as ESM and CommonJS and loads neither React Native nor Vitest, so plugin tests run in plain Node under Vitest or Jest. `@hot-updater/react-native` is an optional peer dependency that only this subpath needs.

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

- ab464e7: Add `setupStorageAdapterTestSuite`, which checks a storage adapter against what deploy, patch, the Console, the server, and `hot-updater storage prune` rely on. It streams bodies through `put` with and without a `contentLength` and reads them back through `get`. It checks that `put` returns the canonical URI of each key below the base path, including keys with spaces, `#`, `%`, and Unicode, and that the URIs deploy derives from a manifest's URI resolve. It also covers `exists`, a `null` response for a missing object, an idempotent `delete`, rejecting URIs of another bucket or protocol, `getDownloadUrl`, and `listObjects` and `deleteObjects` with keys relative to the base path. It skips the cases of operations an adapter does not implement, or requires the ones passed as `operations`. Every official storage adapter runs it.

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

- 049fad1: Tooling reads a server through its definition, the value `createHotUpdater` returns. Beside `core`, `api`, and `handlers`, a definition has public, read-only properties:
  - `database`;
  - `storage` and `plugins`, frozen copies of the arrays the definition was created with;
  - `clientPlugins`;
  - `clientEndpoints`;
  - `clientAuth`, which names the plugin that guards client routes and the request headers its decision reads, in lowercase.

  `@hot-updater/server` now exports only its root, `./adapters/*`, `./plugins/insights`, and `./plugins/api-keys`.

  Removed from `@hot-updater/server`. All of these shipped in rc.18:
  - From `@hot-updater/server/db`:
    - `createDatabaseCoreApi` and `CoreApi`. Use a definition's `core`, typed `HotUpdaterCoreApi` from `@hot-updater/plugin-core`.
    - `createDatabasePluginApis`. Use a definition's `api`. In a test that is, for example, `createHotUpdater({ database, plugins, clientAccess: "public" }).api.insights`.
    - `serverPluginsOf`, `clientPluginsOf`, and `ClientPluginSpec`. Use a definition's `plugins` and `clientPlugins`. A client plugin is typed `PluginClientPlugin` from `@hot-updater/plugin-core`.
    - `HotUpdaterDBTarget`, with no replacement: tooling takes the definition.
    - `HOT_UPDATER_SERVER_VERSION`. Import it from the root.
    - `HotUpdaterSchemaMigrationRequiredError`, `generateEngineSql`, `DatabaseTooling`, `Migrator`, `SchemaGenerator`, `ToolingDatabase`, and `ToolingTarget`. Import them from `@hot-updater/plugin-core`.
    - `clientAuthOf`, `generateClientCredential`, `provisionClientCredential`, `createMigrator`, `generateSchema`, `generatesSchema`, `ClientAuthSpec`, `ClientCredentialSpec`, and `ProvisionedClientCredential`. Import them from `@hot-updater/cli-tools`, where each takes a definition.
  - From `@hot-updater/server/diff`: `createBundleDiff`, `CreateBundleDiffDependencies`, `CreateBundleDiffInput`, and `CreateBundleDiffOptions`. There is no public replacement: the `hot-updater` CLI creates bundle diffs itself, and `@hot-updater/server` no longer depends on `@hot-updater/bsdiff`.

  Over a direct database, the CLI and the console run `createHotUpdater` with the database, storage, and plugins in their config. They write through its `core`, the same path the server's own writes take, and call plugins through its `api`:
  - **Missing plugin migrations.** A command stops before it reads or writes if a plugin's migration has not run. `HotUpdaterSchemaMigrationRequiredError` lists every missing or stale settings row in `settings` and names their plugins in `plugins`. Its message gives the fix for the database:
    - `hot-updater db migrate`, or `hot-updater db generate` for a database migrated from files, run in the server's project: the `db` commands load the server file and don't read `hot-updater.config.ts`;
    - on a managed server, rerunning `hot-updater init --provider <provider>`.
  - **Expired rows on SQL databases.** When a retention pass is due, a write first deletes expired rows from plugins' tables:
    - The server and the CLI share one lease.
    - A pass deletes at most 500 rows from each table.
    - A failed pass, for example one whose credentials cannot delete, logs a warning and the write goes ahead. The pass is due again at once, so the next writer that can delete, such as the server, runs it. The process whose pass failed tries again in a minute.
  - **Key-value databases** (DynamoDB, Firestore) expire rows themselves, so their writes delete nothing.
  - **Storage.** Core resolves file URLs through the server's storage. A server over storage that only uploads, as the CLI's is, can still write, and its `core.getArtifactInfo` returns `null`, because it can neither read nor sign a file.

  Other changes:
  - **`@hot-updater/cli-tools`** adds `serverDefinitionOf` and `isServerDefinition`, which read a definition. Tooling refuses a definition from an older `@hot-updater/server` and says to upgrade it.
  - **Insights test suite.** `insightsTestSuite`'s `createModel` receives the database as an `EngineDatabase`.
  - **Managed init** reads the client headers, client plugins, and credential of the provider's plugins from a server it assembles over the database it set up.
  - **Agent infrastructure scaffolds.** `provision-client-credential.mjs` reads the properties of the scaffold's `app/hotUpdater.ts`, and refuses a clientAuth plugin whose `cli.clientCredential` lacks a label, header, env, `generate`, or `provision`. Firebase's `migrate.ts` imports `toolingTargetOf` from `@hot-updater/plugin-core`, which its app now lists.

- bb57f25: What fills one slot of a config is now an adapter: storage, build, database, and signing. What you list in `plugins` stays a plugin: server plugins, client plugins, and the Sentry, Datadog, and BugSnag integration plugins that wrap a build adapter.
  - `@hot-updater/plugin-core`: `StoragePlugin` is `StorageAdapter`, `createStoragePlugin` is `createStorageAdapter`, `StoragePluginWith` is `StorageAdapterWith`, `CreateStoragePluginOptions` is `CreateStorageAdapterOptions`, `BuildPlugin` is `BuildAdapter`, `BuildPluginConfig` is `BuildAdapterConfig`, `BasePluginArgs` is `BuildAdapterArgs`, `BundleSigningPlugin` is `BundleSigningAdapter`, and `DatabasePluginInputError` is `DatabaseAdapterInputError`. There are no aliases.
  - `@hot-updater/bare`, `@hot-updater/expo`, and `@hot-updater/rock`: their options types are `BareAdapterConfig`, `ExpoAdapterConfig`, and `RockAdapterConfig`.
  - The CLI, the server, and the console say "storage adapter", "build adapter", "database adapter", and "signing adapter" in their messages, such as `Storage adapter "<name>" does not implement <operation>.` and `No storage adapter for protocol: <protocol>`. `hot-updater init --build <adapter>` names its option accordingly.

  Package names and factory names do not change: `s3Storage()`, `r2Storage()`, `bare()`, `expo()`, `rock()`, `postgres()`, and the rest are configured as before.

## 1.0.0-rc.17

### Minor Changes

- 9cd555b: `setupDatabaseTestSuite` runs core's suites only; server plugins' suites run when a provider lists them in `plugins`. The Insights suites moved to the Insights plugin: pass `insightsTestSuite({ createModel })` from `@hot-updater/server/plugins/insights/testing`, which also exports `setupInsightsModelTestSuite` and `createBundleEventRowFixture`, and serve `insights()` from `createHttpClient`. `createInsightsModel` is no longer an option of `setupDatabaseTestSuite`, and `@hot-updater/test-utils` no longer exports the Insights suites.

### Patch Changes

- e696e69: Add `setupAggregateBatchingTestSuite`, which runs batched aggregates on a key-value store. It checks that reads return what transactional writes return in log and memory mode, that two servers compacting one log under 16 concurrent writers apply each log row once, and that a log row too large for one write is applied in parts.
- 530cca5: Tables and aggregates can expire their rows, with no scheduler. `defineTable` and `defineAggregate` take `retention: { field, days }`, where `field` is an integer field of epoch milliseconds and a row expires `days` after it; a model with retention takes part in no reference or rooted index. The days are a runtime value, so a plugin may take them as an option: the tables and indexes are the same for any period. DynamoDB and Firestore delete expired rows with their native TTL: the key-value helper stamps each row's items and index copies with their expiry, kept as `_ttl` and `expireAt`. MongoDB stamps `_expireAt`, a Date, under a TTL index. On PostgreSQL, MySQL, SQLite, D1, and Supabase, the adapter implements the optional `DatabaseAdapter.prune(table, before, limit)` over an index that leads with the field, which `hot-updater db generate` and `db migrate` create when the table has none, and the server prunes during writes: the write that takes the lease row in the settings table first deletes up to 500 expired rows a table, and other servers skip. The next pass is due in an hour, or in a minute while a pass still found a full batch. The adapter conformance suite takes `retention: "prune"` or `"ttl"` and checks either, and the read-budget suite expects recording an Insights event to read its 7 rows in 4 batch gets.
- 1ddd5fc: The read-budget and Insights model suites expect latest-event counts over whole UTC days, usage sketches per platform, and no stored `UNCHANGED` events.
- 9a6715f: The read-budget suite types the Insights reads it measures with its own copies of the Insights plugin's types, since `@hot-updater/plugin-core` no longer exports them.
- a084eda: `setupReadBudgetTestSuite` creates the tables of core and of the `plugins` it measures, through its `server`'s `toolingTargetOf`, the one from `@hot-updater/server/database`. `createPluginTestHarness` keeps the table names of a plugin with `namespace: false`.
- b317d49: The Insights suites in `@hot-updater/server/plugins/insights/testing` check update failures. The model suite checks that an update failure is listed in event lists and installation history without moving the latest report, and that a failed check is in no bundle list. The HTTP routes suite records a failure and reads it through `GET /failures`, and `createBundleEventRowFixture` no longer carries `username`. The read-budget suite in `@hot-updater/test-utils` reads a release's and a channel's update failures, over a period and since the release's first report, and its local Insights types follow the new event row.

## 1.0.0-rc.16

### Minor Changes

- b3576f2: Add aggregates to the storage engine's transactions. `tx.aggregate(model, identity, changes, { shardBy })` records counter and gauge deltas and HLL sketches for one shard row. `shardBy` picks the shard with a stable FNV-1a hash, and gauges of a sharded aggregate require it, so each −1/+1 pair lands on one shard.

  At commit, counter-only rows become blind increments that create the row and bump `_v`. Rows with gauges or sketches are read in one batch per table, merged, and written back under a guard, and a row whose counters and gauges reach zero is deleted. When only aggregate rows fail their guard, or the adapter reports a transient failure, the engine re-reads those rows and resends the write instead of rerunning `fn`. `retry.onRetry` reports each rerun and resend.

  The engine assembly moves to `createEngine`, which addresses tables by physical name; `createDatabaseEngine` adds the typed `database(module)` handle on top of it.

  `@hot-updater/test-utils` adds `runContentionHarness`, which starts transactions at a steady rate through a fixed pool and counts how they ended, and `withAdapterLatency`, which delays every adapter call.

- d3a5570: Add the read side of the built-in Insights plugin: `listEvents`, `findLatestEvents`, `countLatestEvents`, `countEvents`, `getReleaseActivity`, and `getAppUsage`. `createInsightsModel(api)` serves them through the `InsightsModel` contract the console and CLI read.

  How each read is served:
  - Event lists read one index range per day, going back at most 90 days.
  - A latest event is one point read.
  - Counts and activity read hour counters, gauges, and sketches, and windows over 48 hours read channel and usage day rollups.
  - Only the partial hours at the edge of a millisecond window fall back to raw rows.

  Engine changes:
  - Range bounds accept a prefix of the order tuple.
  - Aggregate rows are read in parallel at commit.
  - `retry.onRetry` receives the failed attempt's number.

  `@hot-updater/test-utils` adds `setupInsightsModelTestSuite`, which runs the Insights report contract against an `InsightsModel`.

- ff1e565: Add plugins to `createHotUpdater`. The new `@hot-updater/server/plugins` subpath exports `definePlugin`, `defineTable`, and `defineAggregate`. A plugin declares its tables and aggregates. Its `init` receives a typed database handle on the storage engine and a clock, and returns its API, its endpoints, and optionally `clientAuth`.

  `createHotUpdater({ database, plugins, storage, clientAccess })` runs each plugin's `init` once at startup and exposes each API as `hotUpdater.api.<id>`. Endpoints mount on `handlers.client`, behind the client-route policy, or on `handlers.admin`.

  Client routes have one policy source: exactly one plugin that provides `clientAuth`, or `clientAccess: "public"`. The types count clientAuth plugins in a tuple and name the fix. Startup throws `HotUpdaterConfigError` for any of these:
  - duplicate plugin ids
  - a `kind` key or other unknown keys
  - an async `init`
  - a `provides.clientAuth` that disagrees with the instance
  - colliding routes
  - a database that is not on the storage engine

  Cacheable client responses vary by the policy's headers, so public servers now send `Vary: Accept-Encoding` alone.

  `@hot-updater/test-utils` adds `createPluginTestHarness`, which runs one plugin on a memory adapter in verify mode, with `measureReads`.

- 152db48: Add the read-budget suite. `@hot-updater/server/db` exports `createMeasuredDatabase(adapter, plugins, options?)`: core and the plugins' APIs assembled as `createHotUpdater` assembles them, on an engine in verify mode over a storage adapter without the schema fence, with `measureReads`.

  `@hot-updater/test-utils` adds `setupReadBudgetTestSuite`, which seeds core and Insights on a backend with native pages capped at two rows and checks every API in the read-budget list at the adapter and at the engine, and `postgresRowsExamined` and `mysqlRowsExamined`, which explain each read a SQL core executor runs to count the rows the database examined.

- 228b6c7: Remove the legacy database contract. Every database runs on the storage engine, and core, its plugins, and the admin API are the only way to its data. Release candidate databases are recreated, not converted.
  - **Databases:** a provider returns an `EngineDatabase`, `{ name, adapter, dispose? }`, with `provider`, `createMigrator`, and `generateSchema` for `hot-updater db` where it has them. `createEngineDatabase({ name, adapter })` from `@hot-updater/server/database` puts the adapter behind the schema fence with the built-in settings; `builtInSchema`, `builtInSettings`, and `migrateBuiltInSchema` are the built-in tables, their settings rows, and their migration. `DatabasePlugin`, `createDatabasePlugin`, `createDatabaseClient`, the model and commit types, `commitReleaseCatalogMutation(s)`, and `BundleRepository` are gone.
  - **`createHotUpdater`:** takes `{ database, storage?, plugins?, clientAccess? }`; `plugins` defaults to none. `clientAccess` is `"public"`, or absent when a plugin provides clientAuth. A `clientAccess` object is a type error whose message names `apiKeys()`, and at startup a `HotUpdaterConfigError` that names it too. The instance is `{ handlers, core, api, adapterName }`: bundle, channel, release, Insights, and API key methods on it are gone; use `core` and the plugins' `api`. `registerApiKey`, `createApiKey`, `provisionApiKey`, and `createHandlers` are no longer exported; the `apiKeys()` plugin's API does the same work.
  - **Handlers:** client routes read catalogs and artifacts through core. The admin API speaks protocol 2 only: `v=2` is accepted and changes nothing, and `POST /database/commit`, `POST /bundles`, and `DELETE /bundles/:id` are gone (deploy with `POST /releases`, delete with `POST /bundles/delete`). `PATCH /bundles/:id` answers 204. The Insights routes come from `insights()`; without it they answer 204 with `x-hot-updater-insights: disabled`.
  - **Schema:** generated SQL, Drizzle, and Prisma schemas have no database foreign keys; the engine keeps references. CockroachDB and SQL Server are no longer supported, and `relationMode` is gone. The checked-in Postgres and Supabase SQL is regenerated.
  - **Providers:** `postgres`, `d1Database`, `supabaseDatabase`, `firebaseDatabase`, and `dynamoDB` return engine databases. `dynamoDB` invalidates the cached update-check routes after a write that changes a Release Catalog.
  - **`standaloneRepository`:** is `{ name, core, fetchAdmin }` over admin API protocol 2; its protocol 1 reads and custom bundle `routes` are gone.
  - **`@hot-updater/test-utils`:** `setupDatabaseTestSuite` runs core, bundles, the Release Catalog contract, and Insights through admin API protocol 2 over HTTP, and with `createInsightsModel` the Insights report contract. It replaces `setupDatabasePluginTestSuite` and `setupDatabaseClientTestSuite`. `setupBundleMethodsTestSuite` and `setupReleaseCatalogTestSuite` take `{ getClient }` on protocol 2.
  - **CLI and console:** they read and write through core only. `hot-updater api-key` manages keys through the config's `apiKeys()` plugin, and the console runs the config's `plugins`: without them, Insights and API keys are off.

- df31037: Add the storage adapter contract that every Hot Updater database runs on. An adapter implements batched `get`, index-range `query`, and atomic `write` of guarded ops with its backend's native features, and knows nothing about Hot Updater's domain. `@hot-updater/plugin-core/internal` ships the contract types, value conversion for backend types (int8 text, BigInt, Decimal, SQLite 0/1, JSON text), a `verifyAdapter` wrapper that checks every read and write at the adapter boundary and counts reads, and the reference memory adapter. `@hot-updater/server/database` re-exports them for adapter authors.

  `@hot-updater/test-utils` adds `setupDatabaseAdapterConformanceSuite`: value round-trips, point and range reads, UTF-8 byte ordering, cursor paging without gaps or repeats, multi-valued and unique indexes, full pages under capped native pages, atomic batches with a failure injected at every op, one winner among 32 concurrent writers, no lost increments, write-skew rejection, and over-limit writes rejected before sending.

### Patch Changes

- d482b13: Auto-patch bases match what `deploy` chose before the storage engine. `core.findBaseBundleIds` reads the new bundle's Release Catalog scope in one point read and keeps every enabled bundle release whose target app version range intersects the new target (the same fingerprint, in a fingerprint scope), newest release first, each bundle once and older than the new bundle, up to `patch.maxBaseBundles`. Targets such as `1.x`, `*`, or `>=1.2.0 <2` get bases again, a `*` or `1.x` release serves every version it covers, a release on another patch version of the same minor line no longer takes a slot, and a promoted or republished bundle counts from its newest release.

  `targetBaseCandidateKey` takes the channel name instead of its id, and its key names the catalog scope and the normalized range. The `base_candidates` aggregate and its gauge writes are gone, so each release change writes up to 16 fewer rows; the checked-in D1, Postgres, and Supabase schemas drop the table.

- d482b13: Insights event lists cover one time range, as other analytics products list raw events. The global and bundle lists take `[sinceMs, beforeReceivedAtMs)` of at most 90 × 24 hours; without `sinceMs` they list the 90 days before the cutoff, and a longer range answers 400. Pages run newest first and stop at the range start: only a full page returns a cursor, which carries the range and the page's last row. Each event also counts itself in a per-day row of `insights_outcomes` (platform `*`), so a list skips days without matching events: after an empty day, one outcome read (that row for the global list, the filter's own hourly rows for a bundle list) names the next day that holds one, and a gap of any length costs two reads. The Insights plugin's `listEvents` rejects a global or bundle range longer than 90 × 24 hours. The read-budget suite measures a dense day, a gap, and an empty range.
- d482b13: `countLatestEvents` counts an installation once when its latest event matches a `from` and a `to` bundle predicate of the same type, over whole hours as it already did over a partial hour. The Insights plugin sums one gauge per predicate, so a download from A to B counted by "from A" and "to B" was counted twice. Each installation's latest event now also keeps a gauge of its (from, to) pair, and the count subtracts the pairs its predicates share: one more gauge per latest event, read and written in the same batch as the others, and a count reads the pairs only when both fields are filtered. The published Insights model suite checks the case.
- f6ffb68: Add the write side of the built-in Insights plugin at `@hot-updater/server/plugins/insights`. `insights()` declares these models:
  - `bundle_events`, with a derived `day` and `movement_install_id` and a multi-valued `bundle_ref`
  - `bundle_event_heads`
  - five aggregates, all sharded by install id: overview counters, user sketches, the latest-installation distribution, latest events by bundle, and outcome counters

  `api.recordEvent(event)` records one validated event in one transaction. It reads the event and its installation's head in one batch, reads the gauge and sketch rows it changes in a second, then writes once.
  - A repeated id changes nothing.
  - A newer event moves the head and its gauges.
  - An older event still counts in its own hour.
  - Channel and usage rows also roll up by day.

  Also in this change:
  - The SQL core no longer creates an index whose columns repeat the primary key.
  - `@hot-updater/plugin-core/internal` exports `assertBundleEventRow` and `createValidatedInsightsModel`.
  - The plugin test harness returns the plugin's database handle.

- c68e9f3: Add the key-value helper, from `@hot-updater/server/database`, which the DynamoDB and Firestore databases run on. `createKvAdapter({ store, tablePrefix })` implements the storage adapter over a `KeyValueStore`, which provides strongly consistent point reads, one partition's sort-key range per page, and atomic writes whose conditions see the state before the write.
  - **Layout:** a row is one item at `pk = <table>`, `sk = enc(key)`, where `encodeKvKey` keeps tuple order as UTF-8 order. An index in key order reads the row items. Every other index adds an item per entry at `pk = <table>#<index>#enc(eq)`, `sk = enc(order)`. A unique entry is one item, written only where no row holds it.
  - **Index copies:** an index item holds a copy of the row without `_v` or counters (the columns with a default). An increment changes only those, so it never makes a copy stale. An increment on a table with index items may change only counters of an existing row. Reads fill counters from the rows, and a unique read outside a transaction takes one read.
  - **Pages and limits:** `query` reads native pages until the limit or the range's end. `fits()` counts items and bytes against the store's limits.

  The engine reads a row whole with `get` where a transaction guards it and the adapter returned an index copy, and reruns if the row changed since. Reads outside a transaction no longer return `_v` on any backend; their rows are typed `ReadRow`. The Release Catalog suite in `@hot-updater/test-utils` now commits at most three Releases, with their bundles, at a time. That fits DynamoDB's 100 items per transaction.

- 754a73e: Add the shared SQL core, from `@hot-updater/server/database`. `createSqlAdapter({ executor })` compiles adapter reads and writes to SQL for PostgreSQL, MySQL, and SQLite and runs them through a `SqlExecutor` (one per driver or ORM), with one transaction per write.

  Guards are `UPDATE … WHERE _v = ?`, checks are locking reads (`FOR UPDATE`, or SQLite's `BEGIN IMMEDIATE`), counters are upserts, and index reads compare order tuples with row values (expanded ORs on MySQL). Unique violations name the failed op. Serialization failures, deadlocks, lock timeouts, and `SQLITE_BUSY` ask the engine to retry.

  `createTableStatements` emits DDL with binary collation (`COLLATE "C"`, `utf8mb4_0900_bin`, SQLite's `BINARY`), `bigint` whole numbers, and an index table `<table>__<index>` for each index over a multi-valued field.

  The adapter conformance suite in `@hot-updater/test-utils` now also orders a key with a trailing space after the same key without it.

## 1.0.0-rc.15

### Minor Changes

- 39f60f9: Publish the shared Vitest conformance helpers for custom database providers. Register a database lifecycle and a thin HTTP server adapter to verify the database and Release Catalog HTTP contracts with the same scenarios used by official providers and example servers.

  Exercise OTA lifecycles with HTTP catalogs and the production client selector: built-in to successive OTAs, rollback to a previous OTA, and return to built-in. Verify selected artifacts, deleted Releases, the native minimum bundle, compatibility, cohort changes, and crash history while retaining device state between checks.

## 1.0.0-rc.14

### Minor Changes

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

- c8e24cd: Make Hot Updater v1 infrastructure a clean generation boundary. Managed init
  now rejects selected v0 compute resources before mutation. Supabase tables and
  RPCs plus Firebase collections and Functions use fixed v1 namespaces, allowing
  v0 and v1 to coexist in one project while doctor identifies missing generation
  markers and gives the parallel-cutover remediation.

  AWS fresh installs use v1 Lambda and DynamoDB names plus a Lambda-scoped v1
  signing-key path. S3 buckets can be shared across generations: init no longer
  treats a matching bucket origin as CloudFront ownership, creates a new
  distribution by default, and only updates the exact saved distribution after
  its generation check passes.

  Remove the v0 app-version and fingerprint HTTP routes, the legacy SDK-version
  header contract, CDN forwarding and cache paths for those routes, and managed
  provider Release Catalog backfills. Existing v0 native binaries must remain on
  their unchanged v0 endpoint; new v1 native builds use the unversioned catalog
  and artifact routes on fresh v1 infrastructure.

  Normalize managed provider base URLs to their public deployment roots. AWS,
  Cloudflare, and Firebase now serve `/version`, `/release-catalogs/*`,
  `/artifacts/*`, and `/events` directly; Supabase retains only its
  provider-owned Edge Function prefix. Client routes do not carry a library or
  protocol version prefix because incompatible generations use a fresh base URL.

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

- 3b367e7: Split the self-hosted HTTP runtime into mount-relative
  `handlers.client` and `handlers.admin` surfaces. Admin authentication now
  belongs entirely to framework middleware, mounting the admin handler is the
  explicit opt-in, and admin responses are marked private and non-cacheable.

  Move the canonical admin root from `/hot-updater/api` to
  `/hot-updater/admin`. `standaloneRepository.baseUrl` now points directly to
  that root and sends mount-relative Bundle, Release, Release Catalog, Channel,
  and database-commit requests. Managed runtimes mount only the client handler.

  Remove `features`, including `features.bundles`, `features.updateCheck`, and
  `features.clientAccessKeys`, plus Analytics `queryAccess`. The required
  top-level `clientAccess` policy now selects public or API-key authenticated
  client routes. The client handler always owns update routes and Analytics
  ingestion, while Analytics queries move to the admin surface. React Native
  clients independently opt into automatic transition reporting.
  `toNodeHandler` now accepts one handler function. React Native keeps the same
  client `baseURL` and resolves handler-relative storage paths against it,
  removing the server's `basePath` option. Client authentication uses `x-api-key`,
  not an admin bearer token.

  Resolve Expo fingerprint mode from the target app's dependencies so bare React
  Native fingerprints stay stable across monorepo and isolated installs.

### Patch Changes

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

## 0.36.0

## 0.35.12

## 0.35.11

## 0.35.10

## 0.35.9

## 0.35.8

## 0.35.7

## 0.35.6

## 0.35.5

## 0.35.4

## 0.35.3

## 0.35.2

## 0.35.1

## 0.35.0

## 0.34.0

## 0.33.2

## 0.33.1

## 0.33.0

## 0.32.0

## 0.31.4

## 0.31.3

## 0.31.2

## 0.31.1

## 0.31.0

## 0.30.12

### Patch Changes

- @hot-updater/core@0.30.12

## 0.30.11

### Patch Changes

- @hot-updater/core@0.30.11

## 0.30.10

### Patch Changes

- @hot-updater/core@0.30.10

## 0.30.9

### Patch Changes

- @hot-updater/core@0.30.9

## 0.30.8

### Patch Changes

- @hot-updater/core@0.30.8

## 0.30.7

### Patch Changes

- @hot-updater/core@0.30.7

## 0.30.6

### Patch Changes

- @hot-updater/core@0.30.6

## 0.30.5

### Patch Changes

- @hot-updater/core@0.30.5

## 0.30.4

### Patch Changes

- @hot-updater/core@0.30.4

## 0.30.3

### Patch Changes

- @hot-updater/core@0.30.3

## 0.30.2

### Patch Changes

- @hot-updater/core@0.30.2

## 0.30.1

### Patch Changes

- @hot-updater/core@0.30.1

## 0.30.0

### Minor Changes

- 83c01c8: fix: keep target cohorts additive to rollout

### Patch Changes

- Updated dependencies [83c01c8]
  - @hot-updater/core@0.30.0

## 0.29.8

### Patch Changes

- @hot-updater/core@0.29.8

## 0.29.7

### Patch Changes

- @hot-updater/core@0.29.7

## 0.29.6

### Patch Changes

- @hot-updater/core@0.29.6

## 0.29.5

### Patch Changes

- @hot-updater/core@0.29.5

## 0.29.4

### Patch Changes

- @hot-updater/core@0.29.4

## 0.29.3

### Patch Changes

- @hot-updater/core@0.29.3

## 0.29.2

### Patch Changes

- 2a1bc80: fix: node deps bundling
- Updated dependencies [2a1bc80]
  - @hot-updater/core@0.29.2

## 0.29.1

### Patch Changes

- @hot-updater/core@0.29.1

## 0.29.0

### Minor Changes

- a935992: feat: Rollout feature with control from 1% to 100%

### Patch Changes

- d0fe908: fix(console): rebuild copied bundles with fresh uuidv7 ids
- Updated dependencies [a935992]
- Updated dependencies [d0fe908]
  - @hot-updater/core@0.29.0

## 0.28.0

### Patch Changes

- @hot-updater/core@0.28.0

## 0.27.1

### Patch Changes

- @hot-updater/core@0.27.1

## 0.27.0

### Minor Changes

- 81f9437: feat(android): for safe reloading, Android reloads the process (#869)

### Patch Changes

- Updated dependencies [81f9437]
  - @hot-updater/core@0.27.0

## 0.26.2

### Patch Changes

- @hot-updater/core@0.26.2

## 0.26.1

### Patch Changes

- @hot-updater/core@0.26.1

## 0.26.0

### Patch Changes

- @hot-updater/core@0.26.0

## 0.25.14

### Patch Changes

- @hot-updater/core@0.25.14

## 0.25.13

### Patch Changes

- @hot-updater/core@0.25.13

## 0.25.12

### Patch Changes

- @hot-updater/core@0.25.12

## 0.25.11

### Patch Changes

- @hot-updater/core@0.25.11

## 0.25.10

### Patch Changes

- @hot-updater/core@0.25.10

## 0.25.9

### Patch Changes

- @hot-updater/core@0.25.9

## 0.25.8

### Patch Changes

- @hot-updater/core@0.25.8

## 0.25.7

### Patch Changes

- @hot-updater/core@0.25.7

## 0.25.6

### Patch Changes

- @hot-updater/core@0.25.6

## 0.25.5

### Patch Changes

- @hot-updater/core@0.25.5

## 0.25.4

### Patch Changes

- @hot-updater/core@0.25.4

## 0.25.3

### Patch Changes

- @hot-updater/core@0.25.3

## 0.25.2

### Patch Changes

- @hot-updater/core@0.25.2

## 0.25.1

### Patch Changes

- @hot-updater/core@0.25.1

## 0.25.0

### Patch Changes

- @hot-updater/core@0.25.0

## 0.24.7

### Patch Changes

- 294e324: fix: update babel plugin path in documentation and plugin files
- Updated dependencies [294e324]
  - @hot-updater/core@0.24.7

## 0.24.6

### Patch Changes

- @hot-updater/core@0.24.6

## 0.24.5

### Patch Changes

- @hot-updater/core@0.24.5

## 0.24.4

### Patch Changes

- @hot-updater/core@0.24.4

## 0.24.3

### Patch Changes

- @hot-updater/core@0.24.3

## 0.24.2

### Patch Changes

- @hot-updater/core@0.24.2

## 0.24.1

### Patch Changes

- @hot-updater/core@0.24.1

## 0.24.0

### Patch Changes

- @hot-updater/core@0.24.0

## 0.23.1

### Patch Changes

- @hot-updater/core@0.23.1

## 0.23.0

### Patch Changes

- Updated dependencies [e41fb6b]
  - @hot-updater/core@0.23.0

## 0.22.2

### Patch Changes

- @hot-updater/core@0.22.2

## 0.22.1

### Patch Changes

- @hot-updater/core@0.22.1

## 0.22.0

### Patch Changes

- @hot-updater/core@0.22.0

## 0.21.15

### Patch Changes

- a169f06: unique constraint violations
  - @hot-updater/core@0.21.15

## 0.21.14

### Patch Changes

- @hot-updater/core@0.21.14

## 0.21.13

### Patch Changes

- @hot-updater/core@0.21.13

## 0.21.12

### Patch Changes

- @hot-updater/core@0.21.12

## 0.21.11

### Patch Changes

- e2b67d7: fix(cli-tools): esm only package bundle
- 2905e47: feat(server): supports hot-updater database plugin style
- Updated dependencies [e2b67d7]
  - @hot-updater/core@0.21.11

## 0.21.10

### Patch Changes

- 5289b17: only include valid where clauses during building /bundles orm command
  - @hot-updater/core@0.21.10

## 0.21.9

### Patch Changes

- @hot-updater/core@0.21.9

## 0.21.8

### Patch Changes

- @hot-updater/core@0.21.8

## 0.21.7

### Patch Changes

- @hot-updater/core@0.21.7

## 0.21.6

### Patch Changes

- @hot-updater/core@0.21.6

## 0.21.5

### Patch Changes

- @hot-updater/core@0.21.5

## 0.21.4

### Patch Changes

- 5d3070a: fix(aws): semver bounded range matching bug (#632)
  - @hot-updater/core@0.21.4

## 0.21.3

### Patch Changes

- @hot-updater/core@0.21.3

## 0.21.2

### Patch Changes

- @hot-updater/core@0.21.2

## 0.21.1

### Patch Changes

- @hot-updater/core@0.21.1

## 0.22.0

### Minor Changes

- 036f8f0: feat: support `@hot-updater/server` for self-hosted (WIP)

### Patch Changes

- Updated dependencies [afb084b]
- Updated dependencies [036f8f0]
  - @hot-updater/core@0.22.0
