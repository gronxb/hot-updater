# @hot-updater/aws

## 1.0.0-rc.21

### Minor Changes

- b92970f: Each managed provider package has one `./init` entry, which is the provider's whole init:
  - `initProvider`: the inputs init asks for and checks;
  - `runInit`.

  `./iac` is removed. `./init` no longer exports these input helpers:
  - `@hot-updater/aws`: `AWS_AUTH_MODES`, `AwsAuthMode`, `isAwsAuthMode`, `AWS_REGION_VALUES`, `AwsRegionValue`, `isAwsRegionValue`;
  - `@hot-updater/firebase`: `isFirebaseRegion`, `isFirebaseProjectId`;
  - `@hot-updater/supabase`: `SUPABASE_DATABASE_PASSWORD_PROJECT_ID_ENV_KEY`, `SUPABASE_REGION_VALUES`, `SupabaseRegion`, `isSupabaseRegion`, `isSupabaseFunctionName`.

  Update `hot-updater` together with the provider packages:
  - A `hot-updater` CLI at rc.20 or older imports `./iac`, which these provider packages no longer export, so it fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
  - `hot-updater`'s optional peer dependencies on the provider packages now follow its own version, so package managers warn about a mismatch.
  - `hot-updater init` names the version to install and stops:
    - before it edits any file, when the provider package the project has is one whose `./init` has no `runInit` (provider packages up to rc.20);
    - before it creates or changes any resource, when the provider package still fails to load once init has installed its packages.

  `hot-updater init` bundles no provider code. It installs the chosen provider package, imports that package's `./init`, checks the provider's inputs, and then runs `runInit`:
  - **`--from-env-file`** reports problems in two stages:
    - a missing build adapter or provider, before init installs packages;
    - every missing provider input, once init has installed the provider package and before it creates or changes any resource.
  - **`hot-updater init --help` and `hot-updater infra scaffold`** don't need any provider package installed. They read each provider's inputs from the infrastructure templates, which the CLI's build records.

### Patch Changes

- c9cfed7: Every package now shares one release candidate version: `hot-updater` and every `@hot-updater/*` package move to the same version, so an app, its server, and the console can pin one version.
- f185d6d: The managed AWS Lambda and Firebase Functions bundles include the Insights and API keys plugin packages, which `@hot-updater/server` now imports.
- eebe617: The "Next step" link that `hot-updater init` prints after it sets up AWS, Cloudflare, Firebase, or Supabase opens the provider guide at "Step 3: Add HotUpdater to your project". The old links named headings that the guides do not have, so they opened at the top of the page.
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

- ab464e7: `s3Storage().listObjects()` returns each object's `storageUri` as `put` returns it, with every key segment encoded. It returned the raw key, so for a key with `#`, `%`, `@`, or `+` the URI did not match the one a Bundle stores, and `hot-updater storage prune` could treat a referenced object as unreferenced. Keys that no `put` writes, such as folder markers that end in `/`, are no longer listed.
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

- bb57f25: What fills one slot of a config is now an adapter: storage, build, database, and signing. What you list in `plugins` stays a plugin: server plugins, client plugins, and the Sentry, Datadog, and BugSnag integration plugins that wrap a build adapter.
  - `@hot-updater/plugin-core`: `StoragePlugin` is `StorageAdapter`, `createStoragePlugin` is `createStorageAdapter`, `StoragePluginWith` is `StorageAdapterWith`, `CreateStoragePluginOptions` is `CreateStorageAdapterOptions`, `BuildPlugin` is `BuildAdapter`, `BuildPluginConfig` is `BuildAdapterConfig`, `BasePluginArgs` is `BuildAdapterArgs`, `BundleSigningPlugin` is `BundleSigningAdapter`, and `DatabasePluginInputError` is `DatabaseAdapterInputError`. There are no aliases.
  - `@hot-updater/bare`, `@hot-updater/expo`, and `@hot-updater/rock`: their options types are `BareAdapterConfig`, `ExpoAdapterConfig`, and `RockAdapterConfig`.
  - The CLI, the server, and the console say "storage adapter", "build adapter", "database adapter", and "signing adapter" in their messages, such as `Storage adapter "<name>" does not implement <operation>.` and `No storage adapter for protocol: <protocol>`. `hot-updater init --build <adapter>` names its option accordingly.

  Package names and factory names do not change: `s3Storage()`, `r2Storage()`, `bare()`, `expo()`, `rock()`, `postgres()`, and the rest are configured as before.

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
  - @hot-updater/cli-tools@1.0.0-rc.21
  - @hot-updater/plugin-core@1.0.0-rc.21
  - @hot-updater/server@1.0.0-rc.21

## 1.0.0-rc.18

### Minor Changes

- 9cd555b: The plugin that provides `clientAuth` describes the credential an app sends in `cli.clientCredential`: its label, header, environment variable, and how to generate and provision it. `@hot-updater/server/db` exports `clientAuthOf`, `generateClientCredential`, and `provisionClientCredential`, which read it from a plugin list.

  Managed init provisions the app's credential through the provider's plugins and prints `HotUpdater.init` with that credential's header, or with no `requestHeaders` when client routes are public; `@hot-updater/cli-tools` exports `renderAppSetup` and `printAppSetup` for it. AWS CloudFront cache and origin-request policies key on the client-route policy's `varyHeaders` instead of a fixed `x-api-key`.

  Agent and infrastructure scaffolds record the server's `clientAuth` in `manifest.json` and render their instructions from it. The helper is `app/provision-client-credential.mjs` with `app/database.config.ts`, and it saves `app/client-credential.local`. `hot-updater doctor` reads the credential's header and variable from the scaffold, and skips the 401 check when client routes are public.

- 9cd555b: A server plugin names the client plugin an app adds to `HotUpdater.init`'s `plugins` in `cli.clientPlugin`, as `{ module, name }`; `insights()` names `insights` from `@hot-updater/react-native/plugins/insights`. `createHotUpdater` checks them at startup: each names an export the app can import, not a reserved word, `App`, or `HotUpdater`, and no two plugins name one export from different modules. `@hot-updater/server/db` exports `clientPluginsOf`, which reads them from a plugin list. Managed init passes them to `printAppSetup`, which imports them and adds them to `plugins`, and agent scaffolds record them in `manifest.json` and render the app code in their instructions from them.

### Patch Changes

- e696e69: `dynamoDB()` batches Insights' totals by default. An event writes its own items plus one compressed log item, under the partitions `aggregate_log_0` to `aggregate_log_7`, instead of every total it changes. A compaction merges pending log items into the totals every minute and deletes them with `BatchWriteItem`, under the lock item `aggregate_lease`. Set `aggregateBatching: { mode: "memory" }` on a long-lived server, or `false` to write totals in each event's transaction. The IAM policy changed to allow `BatchWriteItem` and the new partitions: rerun `hot-updater init`, and recreate release candidate data if needed. Without `BatchWriteItem`, log items are deleted through `TransactWriteItems` instead.
- e696e69: The 1.0.0 infrastructure upgrade notes that `hot-updater infra scaffold` writes, and the AWS agent setup, list the DynamoDB policy's batched Insights log partitions, `aggregate_log_0` to `aggregate_log_7` and `aggregate_lease`, and its `BatchWriteItem` permission. The IAM policy changed: rerun `hot-updater init`, and recreate release candidate data if needed. The notes' Insights check reads overview summaries through the Console or the admin API on DynamoDB and Firestore, since a read applies pending batches first.
- d7f1688: The `HotUpdater.init` snippet that managed `init` prints now adds the Insights client plugin, `plugins: [insights()]` from `@hot-updater/react-native/plugins/insights`, since an app reports to Insights only with it. The CLI's agent setup instructions add the same plugin.
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
  - @hot-updater/cli-tools@1.0.0-rc.17

## 1.0.0-rc.17

### Patch Changes

- Updated dependencies [038c804]
  - @hot-updater/server@1.0.0-rc.17

## 1.0.0-rc.16

### Minor Changes

- 94b56f3: Run DynamoDB on the new storage engine. `dynamoDB(config)` keeps its signature, and still invalidates the update-check routes' CloudFront copies after a write that changes what they answer.
  - **One table, no secondary index:** the plugin is the key-value helper over one table keyed by string `pk` and `sk`. Each row is an item. Each index a row belongs to adds an item holding a copy of it, written in the same transaction. Reads are strongly consistent, and a write is one `TransactWriteItems` with a client request token. Commits over 100 items, 4 MB, or 400 KB in one item are refused before anything is written.
  - **Schema settings:** the plugin checks the schema settings before its first read and answers 503 until they exist. `migrateDynamoDB(config)` writes them, and creates the table when it is missing. `hot-updater init` runs it after creating the table, the agent scaffold ships the same items as `dynamodb/schema-settings.json`, and the DynamoDB example runs it before registering its API key.
  - **Infrastructure:** `hot-updater init` creates the table without `hot-updater-update-index` and refuses a table that still has it, which a 1.0 release candidate created. The IAM policy allows the key-value store's reads and writes on each table's partitions, `<table>` and `<table>#*`.
  - **Insights shards:** gauge aggregates (`insights_distribution`, `insights_latest_by_bundle`) now spread over 32 shards, on every backend. DynamoDB's contention gate, on DynamoDB Local with 16 writers at 100 moves per second, retried 2–24% of rollout moves at 16 and 1–5% at 32; these are test figures, not production limits. Sketches stay at 16, since every read merges their 2 KB registers, and counters stay at 8. Rows already written on shards 0–15 keep counting.
  - **Removed:** the DynamoDB implementation (about 4,200 lines) and `DYNAMODB_UPDATE_INDEX_NAME`.

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

- 3f30a23: Serve Insights and API keys through plugins.
  - **Insights routes:** `POST /events` and the admin Insights reads come from the `insights()` plugin. Without it, each answers 204 with `x-hot-updater-insights: disabled`.
  - **API keys:** the `apiKeys()` plugin protects client routes with the same header the `clientAccess: { type: "api-key" }` option used, so a server that moves to plugins never falls back to public.
  - **Core reads:** `hotUpdater.core` reads bundles, Releases, Catalogs, and channels. Plugins get the same reads as `ctx.core`, on the same engine. A plugin cannot take the id `core`.
  - **Plugin APIs:** `hotUpdater.api.insights` and `hotUpdater.api.apiKeys` replace `hotUpdater.insights` and `hotUpdater.apiKeys`.
  - **Providers:** `@hot-updater/aws`, `cloudflare`, `firebase`, and `supabase` export `plugins`, their managed server's plugin list (`insights()` and `apiKeys()`). The Lambda, Worker, Cloud Function, and Edge Function templates use it, with the same `x-api-key` header.
  - **CLI:** `generate-standalone-sql` and the missing-export help text use the new options.

### Patch Changes

- 152db48: `createEngineDatabase` takes `onCachedRoutesChange`, a CDN purge for the cacheable client routes that core calls after a committed write that changes a Release Catalog. Core decides which writes those are, so neither a provider adapter nor the storage engine names a table: `dynamoDB` passes its CloudFront invalidation there.
- d482b13: The agent setup checklists that `hot-updater agent infra` writes describe a 1.0 release candidate's resources the way the upgrade notes do. The Supabase checklist no longer points to a removed commit RPC migration: release candidate tables and functions are dropped and their migrations marked reverted before the push. The Cloudflare checklist treats a D1 database that recorded `0001_hot-updater_1.0.0.sql` without `schema.engine` as incompatible, and the AWS checklist's DynamoDB leading keys match the policy the scaffold writes.
- fe03f59: Move the CLI onto core's API, add admin API protocol 2 for self-hosted servers, and generate `hotUpdater.plugins.ts` on init.
  - **CLI on core:** `deploy`, `patch`, `promote`, `catalog`, `storage prune`, artifact deletion, and the bundle commands read and write through core's API. Reads are keyset pages through declared indexes, and writes are typed operations. The CLI opens core in process on the database's storage engine, or through `standaloneRepository` for a self-hosted server.
  - **Deploy:** before anything is built or uploaded, `deploy` checks the database: the schema fence, or a self-hosted server's admin protocol. Each bundle, its patches, its release, and the next catalog of each scope are written in one core call.
  - **Auto-patch bases:** bases come from one point read of the new bundle's Release Catalog scope. A base is an older bundle whose enabled release, in the same channel and platform, has the same fingerprint or an app version range intersecting the target's, newest release first, up to `maxBaseBundles`.
  - **Release lists:** they read the narrowest index the filters allow (bundle, channel and platform, or all) and filter the other fields in the CLI.
  - **`hotUpdater.core`:** it now has core's typed operations next to its reads: deploy, release policy changes and their preflight, promotion, release deletion, catalog rebuilds, channels, and bundle updates and deletes. On the storage engine, the admin handler writes through them.
  - **Admin API protocol 2:** `/version` reports `adminProtocol: 2` and is also served by the admin handler. The list routes page by key (`cursor`, `limit`, `order`) and take the indexed filter sets; `v=2` is accepted and changes nothing. New routes: `POST /releases`, `POST /releases/:id/promote`, `POST /release-catalogs/:scopeKey/preflight`, `POST /bundles/delete`, `GET /bundles/:id/children`, and `GET /base-candidates/:candidateKey`.
  - **`standaloneRepository`:** its `core` is core's API over protocol 2. The first call checks `/version`, so an older server fails with a message to upgrade `@hot-updater/server`. A 503 from the server's schema fence names `hot-updater db migrate`.
  - **`hot-updater init`:** for AWS, Cloudflare, Firebase, and Supabase, init writes `hotUpdater.plugins.ts` next to `hot-updater.config.ts`. It re-exports the provider's `plugins`, the list the managed server runs. An edited file is kept. The agent scaffolds include the file.
  - **`hot-updater api-key`:** it manages keys through the config's `apiKeys()` plugin, and refuses a config without it.

- d482b13: Core purges a CDN's copies of the update-check routes itself. After a committed transaction that writes a Release Catalog, it calls the database's `onCachedRoutesChange`, which `EngineDatabase` now carries. The storage engine's database wrapper no longer inspects table names, and `createEngineDatabase({ onCachedRoutesChange })` only hands the purge to core, so the CLI, the console, and the server purge after the same writes. A preview, a rerun attempt, or a write that changes no catalog purges nothing.

  The built-in database (`createEngineDatabase`, `builtInSchema`, `builtInSettings`, `migrateBuiltInSchema`) moves from the storage engine's directory to the `db` tooling next to it, since it binds core's and the built-in plugins' schemas; `@hot-updater/server/database` exports the same names.

- d482b13: DynamoDB no longer reads the item at a range's exclusive upper bound. The key-value helper now gives each range an inclusive form of its upper bound that admits exactly the keys below it, and the DynamoDB store uses it for `BETWEEN`, so a two-sided range reads only rows it returns.
- ad00722: Provision API keys through the `apiKeys()` plugin, and let core republish a stored bundle.
  - **`core.deploy`:** a deployment may name a bundle the database already holds, as `{ bundleId, release }`. It publishes a new release for that bundle in the release's scope and writes no bundle. A missing bundle refuses with `DatabaseBundleNotFoundError`. `Deployment` is now `BundleDeployment | StoredBundleDeployment`, and admin API protocol 2's `POST /releases` accepts both.
  - **`createDatabasePluginApis`:** it is typed by its plugin list, so `createDatabasePluginApis(database, plugins).apiKeys.provision(...)` needs no cast.
  - **API key provisioning:** `hot-updater init` for AWS, Cloudflare, Firebase, and Supabase registers the app's client key through the provider's `plugins` (the `apiKeys()` plugin its managed server runs) instead of the database plugin's `models.apiKeys`. The agent scaffold's `provision-api-key.mjs` uses the scaffold's `hotUpdater.plugins.ts` the same way.

- d7df92c: Run Firestore on the new storage engine. `firebaseDatabase(config)` keeps its signature and gains an optional `collection`.
  - **One collection:** every item is a `{ pk, sk, row }` document in `hot_updater_v1`, with a hashed document id. Each index a row belongs to adds a document holding a copy of it, written in the same transaction. Reads use two composite indexes, `pk` with `sk` ascending and descending, and `row` is exempt from single-field indexing. `firestore.indexes.json` is generated from the schema and holds just those.
  - **Transactions:** a write is one `runTransaction` that reads only the documents its ops guard. Counters increment without a read, so they hold no read lock: `update` needs the document, so a write whose counter row is missing reruns, reads it, and creates it from `init`. Maps and arrays are stored as JSON text, since Firestore has no nested arrays and does not keep map key order.
  - **Schema settings:** the plugin checks the schema settings before its first read and answers 503 until they exist. `migrateFirebaseDatabase(config)` writes them. `hot-updater init` runs it after deploying the indexes, and the agent scaffold's key script runs it through `api-key.config.ts`'s new `migrate` export. Init refuses a project whose `hot_updater_v1_*` collections hold data from a 1.0 release candidate.
  - **Init:** merging the project's index overrides with ours now replaces an override for the same field instead of merging the lists by position.
  - **Key lengths:** the key-value helper refuses a write whose partition or sort key is longer than the store indexes whole (DynamoDB 2,048 and 1,024 bytes, Firestore 1,500), as `too_large`, instead of failing in the store or truncating the index.
  - **Removed:** the Firestore implementation (about 2,100 lines), the adapter version marker, and the channel-id registry documents.

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
  - @hot-updater/cli-tools@1.0.0-rc.16

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

- 79c3eea: Allow the Lambda execution role to read and write Insights overview partitions so event reports can commit their aggregates.
- Updated dependencies [f5fffea]
- Updated dependencies [79c3eea]
- Updated dependencies [d99530b]
- Updated dependencies [39f60f9]
  - @hot-updater/plugin-core@1.0.0-rc.15
  - @hot-updater/server@1.0.0-rc.15
  - @hot-updater/cli-tools@1.0.0-rc.15

## 1.0.0-rc.14

### Minor Changes

- 479c1e5: Report completed bundle downloads separately from applied updates. Persist the running bundle and pending selection, show Downloaded as waiting to apply, and keep Active, Downloaded, and Recovered totals visible above the activity chart tabs. Defer automatic No change reports until the update check finishes. Keep the unreleased 1.0.0 schema in its existing single initialization migration.
- b23db5e: Replace shared Insights installation storage with canonical events and provider-private indexes for current installation queries. SQL and MongoDB keep nine access fields and fetch full event payloads only for selected results; DynamoDB counts compact scope entries. Custom providers implement `recordEvent({ event })`, `findLatestEvents`, and explicit `countLatestEvents` predicates without lifecycle helpers. Move ancillary event fields into typed `metadata`, reusing Bundle JSON conventions, while preserving SDK requests and Console responses.

  This changes the unreleased 1.0.0 initialization and custom database contract from the previous installation-row design. The read-cost fix preserves the canonical-event contract and keeps current-state queries independent of retained event history. Append and index updates are atomic; measured read/write costs are documented.

### Patch Changes

- Align all Hot Updater packages on 1.0.0-rc.14 for a coordinated release candidate. Future releases continue to use independent package versions.
- b23db5e: Align Firebase Functions and its CLI with the Admin SDK used by generated servers. Firebase emulator checks now require Java 21.

  Forward the original JSON request body through the Firebase Functions entrypoint so Insights events retain their payload and can be recorded.

  Allow the managed AWS runtime to access release catalogs and release lookup records required by the current storage implementation.

- b0387d8: Remove unused `aws-lambda` dependency
- Updated dependencies [479c1e5]
- Updated dependencies
- Updated dependencies [b23db5e]
  - @hot-updater/server@1.0.0-rc.14
  - @hot-updater/plugin-core@1.0.0-rc.14
  - @hot-updater/cli-tools@1.0.0-rc.14

## 1.0.0-rc.4

### Patch Changes

- 2cb3cf0: Make agent infrastructure onboarding resumable through provider checklists with explicit prerequisites, verification evidence and pending-operation records. Package a read-only server verification helper, align database/key/deployment ordering with init, and export AWS DynamoDB/IAM request templates from the same builders used by interactive setup.

## 1.0.0-rc.3

### Patch Changes

- 663d8e9: Finalize the unreleased v1 Insights contract with three event types: UPDATE_APPLIED, UNCHANGED, and RECOVERED. Same-file release selection reports UNCHANGED with null source bundle and update strategy while retaining release IDs. Remove RELEASE_ADOPTED from SDK payloads, server ingestion, database validators, and initial v1 schemas. No compatibility alias is accepted.

  Replace adopted outcomes and counters with unchanged in the Insights query API. Refresh all v1 SDK and infrastructure packages together; existing prerelease development databases require their obsolete event rows and constraints to be updated before using this contract.

- Updated dependencies [663d8e9]
  - @hot-updater/server@1.0.0-rc.3
  - @hot-updater/plugin-core@1.0.0-rc.3
  - @hot-updater/cli-tools@1.0.0-rc.3

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

- Updated dependencies [e6d9ae7]
- Updated dependencies [51300d4]
- Updated dependencies [590ca70]
- Updated dependencies [a837c71]
  - @hot-updater/server@1.0.0-rc.2
  - @hot-updater/plugin-core@1.0.0-rc.2
  - @hot-updater/cli-tools@1.0.0-rc.2

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
  - @hot-updater/server@1.0.0-rc.1
  - @hot-updater/cli-tools@1.0.0-rc.1

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

- 9650748: Remove `createBlobDatabasePlugin` and the AWS `s3Database` metadata provider.
  AWS init and Lambda@Edge now use DynamoDB as the only metadata database while
  continuing to store bundle artifacts in S3.
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

- 25af6ef: Replace runtime-profiled storage plugins with the flat, runtime-independent
  `createStoragePlugin({ name, protocol, put, get, getDownloadUrl, exists, delete
})` contract. Every operation uses an object input and object result. `put`
  accepts a complete object key and a one-shot Web stream, `get` returns a Web
  `Response`,
  `getDownloadUrl` returns the URL sent to update clients, and `delete` always
  targets exactly one object and resolves to the idempotent `{ deleted: true }`
  postcondition. Remove file paths, factory thunks, runtime contexts, prefix
  deletion, and lifecycle hooks from the core storage boundary.

  Standardize persisted locations as hierarchical
  `protocol://bucket/encoded/slash/key` URIs. `createStorageUri` encodes each key
  segment without flattening slash hierarchy, while `parseStorageUri` performs
  the matching validation and decoding. Empty and dot segments, query strings,
  and fragments are rejected.

  Pass server storage implementations directly through
  `createHotUpdater({ storage: [...] })`. URL policy belongs to each storage
  implementation: AWS S3 can use its CloudFront resolver or a server-signed URL,
  Firebase and Supabase generate provider URLs, and private Cloudflare R2 returns
  a signed handler-relative URL. Remove `storageDelivery`, public base-URL and
  top-level signing-key configuration, and the separate provider delivery
  helpers. Cloudflare Worker storage uses the same `r2Storage` export name from
  the `/worker` subpath and captures its native R2 binding at construction.

  Resolve persisted URIs by registered scheme ownership first, including `http`
  and `https`. Only an HTTP(S) URI without an owner uses direct fetch or redirect;
  other unowned schemes are unsupported. Runtime composition accepts at most one
  storage plugin for each scheme.

  Update every built-in storage provider, CLI and Console consumer, managed
  runtime, package entrypoint, and custom-hosting guide to the new contract.
  Remove the storage-only JWT URL helpers and obsolete runtime-specific storage
  creators. Route-group flags are removed; Analytics is always available and the
  required `clientAccess` policy controls client authentication.

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

- 1af8cba: Add the `dynamoDB` database provider with the flat official contract:
  `bundles`, `bundlePatches`, `analytics`, `apiKeys`, and atomic
  `commit({ mutations })`. The provider stores all official domains directly in
  one DynamoDB table; it has no universal component adapter, feature schema
  migration, server kernel, or managed preset dependency.

  Use DynamoDB by default for new AWS `hot-updater init` installations,
  including table provisioning, Lambda@Edge reads, resource-scoped IAM access,
  generated config, and CloudFront invalidation. The packaged DynamoDB runtime
  uses the always-available server Analytics domain and requires API keys for OTA
  reads and Analytics ingestion. API keys are created through init,
  the CLI, or Console and stored by the official API key model. Init writes the
  plaintext only to the local environment file. DynamoDB is the only
  AWS metadata database; S3 remains available for bundle artifact storage.

  Store any number of Bundle, patch, Analytics event, and API key rows while
  retaining the 8 KiB per-item guard for metadata. Plan every bundle mutation
  envelope as one DynamoDB transaction, including counters, patch relations, and
  cascade deletions, so a later invalid mutation cannot leave earlier mutations
  applied. Reject envelopes that exceed DynamoDB's 100-action transaction limit.

  Use targeted cursor, key, and index reads for update checks and official-domain
  queries. Hydrate owner-index candidates and exact bundle references with
  strongly consistent base-table reads, maintain unfiltered totals
  transactionally, and retry unprocessed batch keys with bounded exponential
  backoff. Validate table compatibility before enabling billed point-in-time
  recovery.

  Harden AWS provisioning by isolating Lambda execution roles per installation,
  scoping S3, SSM, and DynamoDB permissions, preserving unrelated CloudFront and
  bucket-policy configuration, reconciling Lambda configuration before
  publishing, and narrowing cache invalidations to update APIs. Successful
  bundle commits perform CloudFront invalidation inside the provider; `dispose`
  owns SDK client cleanup.

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

- 3b367e7: Prevent managed init from overwriting existing v0 Workers and Functions when
  the selected compute resource name is already in use. Retry initial AWS Lambda
  creation while a newly created execution role propagates. Show the issued API
  key separately after the React Native setup example so it can be stored safely.
  Enable the Cloud Functions API before checking an existing Firebase function
  and report function discovery failures without an unhandled command stack.
  Bundle Firebase Functions' internal plugin dependency and deploy only the
  managed v1 Function target so an existing v0 Function is preserved.
  Wait for a newly provisioned Supabase Storage tenant before creating the
  selected bucket, and preserve the access level of a reused operator-owned
  bucket. Wait for PostgREST to expose newly migrated Supabase tables before
  registering the init API key, and keep Supabase CLI metadata inside the
  temporary scaffold workdir.
- e494531: Use patched Hono versions and pin the Supabase Edge Function runtime import.
- Updated dependencies [3b367e7]
- Updated dependencies [467e5f6]
- Updated dependencies [b424d47]
- Updated dependencies [3b367e7]
- Updated dependencies [9650748]
- Updated dependencies [a9ffb2a]
- Updated dependencies [a9ffb2a]
- Updated dependencies [5a2e1cd]
- Updated dependencies [adb0e40]
- Updated dependencies [e2455c5]
- Updated dependencies [ebe1f64]
- Updated dependencies [c8e24cd]
- Updated dependencies [25af6ef]
- Updated dependencies [c355c26]
- Updated dependencies [3b367e7]
- Updated dependencies [7ec1a46]
- Updated dependencies [3b367e7]
- Updated dependencies [a9ffb2a]
- Updated dependencies [a9ffb2a]
  - @hot-updater/plugin-core@1.0.0-rc.0
  - @hot-updater/server@1.0.0-rc.0
  - @hot-updater/cli-tools@1.0.0-rc.0

## 0.36.0

### Patch Changes

- da7de2d: Preserve UUIDv7 S3 channels while avoiding per-prefix legacy traversal, respect
  standalone server pagination limits during storage pruning and batch deletion,
  and document the safe storage cleanup workflow.
- 9759e8a: Reduce S3 management query work by skipping legacy UUIDv7 artifact traversal, deriving channels from canonical manifest keys, and batching multi-bundle deletion scans and commits. Store new bundle artifacts below `bundles/<bundle-id>` while preserving legacy reads, and add exact target app version filters to the CLI and Console. Add an exclusive-maintenance `hot-updater storage prune` command for orphaned bundle objects and unreferenced shared assets, with an explicit `--dry-run` candidate table, a recent-object protection window, and fail-closed reference validation safeguards.
- Updated dependencies [9759e8a]
  - @hot-updater/cli-tools@0.36.0
  - @hot-updater/plugin-core@0.36.0
  - @hot-updater/server@0.36.0

## 0.35.12

### Patch Changes

- Updated dependencies [fd30452]
- Updated dependencies [6e8b32e]
  - @hot-updater/cli-tools@0.35.12
  - @hot-updater/plugin-core@0.35.12
  - @hot-updater/server@0.35.12

## 0.35.11

### Patch Changes

- Updated dependencies [1a3a621]
  - @hot-updater/plugin-core@0.35.11
  - @hot-updater/cli-tools@0.35.11
  - @hot-updater/server@0.35.11

## 0.35.10

### Patch Changes

- Updated dependencies [ce8d254]
  - @hot-updater/plugin-core@0.35.10
  - @hot-updater/cli-tools@0.35.10
  - @hot-updater/server@0.35.10

## 0.35.9

### Patch Changes

- f9bb26d: Declare init inputs in each provider package through a shared contract, ask
  once before saving credential inputs, and support prompt-free infrastructure
  reconciliation with `init --env-file .env.hotupdater`.
- Updated dependencies [8688b1a]
- Updated dependencies [f9bb26d]
  - @hot-updater/cli-tools@0.35.9
  - @hot-updater/server@0.35.9
  - @hot-updater/plugin-core@0.35.9

## 0.35.8

### Patch Changes

- Updated dependencies [4f9fab2]
  - @hot-updater/cli-tools@0.35.8
  - @hot-updater/server@0.35.8
  - @hot-updater/plugin-core@0.35.8

## 0.35.7

### Patch Changes

- @hot-updater/cli-tools@0.35.7
- @hot-updater/server@0.35.7
- @hot-updater/plugin-core@0.35.7

## 0.35.6

### Patch Changes

- @hot-updater/cli-tools@0.35.6
- @hot-updater/server@0.35.6
- @hot-updater/plugin-core@0.35.6

## 0.35.5

### Patch Changes

- @hot-updater/cli-tools@0.35.5
- @hot-updater/server@0.35.5
- @hot-updater/plugin-core@0.35.5

## 0.35.4

### Patch Changes

- @hot-updater/cli-tools@0.35.4
- @hot-updater/server@0.35.4
- @hot-updater/plugin-core@0.35.4

## 0.35.3

### Patch Changes

- @hot-updater/cli-tools@0.35.3
- @hot-updater/server@0.35.3
- @hot-updater/plugin-core@0.35.3

## 0.35.2

### Patch Changes

- @hot-updater/cli-tools@0.35.2
- @hot-updater/server@0.35.2
- @hot-updater/plugin-core@0.35.2

## 0.35.1

### Patch Changes

- @hot-updater/cli-tools@0.35.1
- @hot-updater/server@0.35.1
- @hot-updater/plugin-core@0.35.1

## 0.35.0

### Patch Changes

- Updated dependencies [4e1b86d]
  - @hot-updater/server@0.35.0
  - @hot-updater/cli-tools@0.35.0
  - @hot-updater/plugin-core@0.35.0

## 0.34.0

### Patch Changes

- Updated dependencies [088f6c1]
- Updated dependencies [7244b65]
  - @hot-updater/server@0.34.0
  - @hot-updater/plugin-core@0.34.0
  - @hot-updater/cli-tools@0.34.0

## 0.33.2

### Patch Changes

- @hot-updater/cli-tools@0.33.2
- @hot-updater/server@0.33.2
- @hot-updater/plugin-core@0.33.2

## 0.33.1

### Patch Changes

- a5c4467: Remove blob database management index artifacts. Console reads now use canonical
  update manifests, and AWS deployments no longer write `_index` metadata.
  Target app version manifests are updated from commit changes without listing S3.
  AWS database metadata now uses single PutObject writes instead of multipart upload.
  AWS canonical manifest scans now use S3 delimiters to avoid reading asset object
  lists during console-style bundle lookups.
  AWS recursive manifest listing now uses bounded concurrency to avoid S3 SlowDown
  when E2E shards query bundle metadata in parallel.
  Blob database instances now remember locally committed deletions so immediate
  delete verification does not reload canonical manifests.
  Plugin-core now owns a request-scoped bundle unit-of-work / identity map. Within
  one request, repeated bundle reads reuse the same value, pending updates and
  deletes are reflected in `getBundleById` and query-aware `getBundles` results,
  and commit clears the pending state.
  Provider implementations continue to implement only reads and writes; they do
  not need to manage identity-map caching themselves. No-context reads no longer
  persist stale identity entries across logical requests, while no-context mutation
  staging remains available until commit for existing CLI-style flows.
  Server update-info artifact resolution reuses the request identity map instead
  of adding duplicate bundle reads for manifest artifact lookup.
  Canonical blob reloads now clear provider-local pending state so another plugin
  instance's committed manifest update is visible through the canonical path.
  Console bundle deletion now closes the detail panel immediately after cached
  state is updated, while broader bundle, child, and channel invalidations continue
  in the background.
- Updated dependencies [a5c4467]
  - @hot-updater/plugin-core@0.33.1
  - @hot-updater/server@0.33.1
  - @hot-updater/cli-tools@0.33.1

## 0.33.0

### Patch Changes

- Updated dependencies [070a86f]
- Updated dependencies [e914f56]
  - @hot-updater/cli-tools@0.33.0
  - @hot-updater/server@0.33.0
  - @hot-updater/plugin-core@0.33.0

## 0.32.0

### Patch Changes

- 4e6d2ec: Use deterministic content-addressed storage keys for manifest assets, require storage plugins to implement object existence checks, skip uploads when the object already exists, limit deploy upload concurrency, stream hashing/compression work to reduce memory pressure, and report upload progress through 100%.
- Updated dependencies [4e6d2ec]
- Updated dependencies [499e139]
  - @hot-updater/cli-tools@0.32.0
  - @hot-updater/plugin-core@0.32.0
  - @hot-updater/server@0.32.0

## 0.31.4

### Patch Changes

- @hot-updater/cli-tools@0.31.4
- @hot-updater/server@0.31.4
- @hot-updater/plugin-core@0.31.4

## 0.31.3

### Patch Changes

- @hot-updater/cli-tools@0.31.3
- @hot-updater/server@0.31.3
- @hot-updater/plugin-core@0.31.3

## 0.31.2

### Patch Changes

- @hot-updater/cli-tools@0.31.2
- @hot-updater/server@0.31.2
- @hot-updater/plugin-core@0.31.2

## 0.31.1

### Patch Changes

- @hot-updater/cli-tools@0.31.1
- @hot-updater/server@0.31.1
- @hot-updater/plugin-core@0.31.1

## 0.31.0

### Patch Changes

- Updated dependencies [5b0a0f5]
- Updated dependencies [5b0a0f5]
  - @hot-updater/server@0.31.0
  - @hot-updater/cli-tools@0.31.0
  - @hot-updater/plugin-core@0.31.0

## 0.30.12

### Patch Changes

- @hot-updater/cli-tools@0.30.12
- @hot-updater/server@0.30.12
- @hot-updater/plugin-core@0.30.12

## 0.30.11

### Patch Changes

- @hot-updater/cli-tools@0.30.11
- @hot-updater/server@0.30.11
- @hot-updater/plugin-core@0.30.11

## 0.30.10

### Patch Changes

- @hot-updater/cli-tools@0.30.10
- @hot-updater/server@0.30.10
- @hot-updater/plugin-core@0.30.10

## 0.30.9

### Patch Changes

- @hot-updater/cli-tools@0.30.9
- @hot-updater/server@0.30.9
- @hot-updater/plugin-core@0.30.9

## 0.30.8

### Patch Changes

- Updated dependencies [6019156]
  - @hot-updater/cli-tools@0.30.8
  - @hot-updater/plugin-core@0.30.8
  - @hot-updater/server@0.30.8

## 0.30.7

### Patch Changes

- Updated dependencies [03fd179]
  - @hot-updater/cli-tools@0.30.7
  - @hot-updater/server@0.30.7
  - @hot-updater/plugin-core@0.30.7

## 0.30.6

### Patch Changes

- @hot-updater/cli-tools@0.30.6
- @hot-updater/server@0.30.6
- @hot-updater/plugin-core@0.30.6

## 0.30.5

### Patch Changes

- @hot-updater/cli-tools@0.30.5
- @hot-updater/server@0.30.5
- @hot-updater/plugin-core@0.30.5

## 0.30.4

### Patch Changes

- @hot-updater/cli-tools@0.30.4
- @hot-updater/server@0.30.4
- @hot-updater/plugin-core@0.30.4

## 0.30.3

### Patch Changes

- @hot-updater/cli-tools@0.30.3
- @hot-updater/server@0.30.3
- @hot-updater/plugin-core@0.30.3

## 0.30.2

### Patch Changes

- @hot-updater/cli-tools@0.30.2
- @hot-updater/server@0.30.2
- @hot-updater/plugin-core@0.30.2

## 0.30.1

### Patch Changes

- @hot-updater/cli-tools@0.30.1
- @hot-updater/server@0.30.1
- @hot-updater/plugin-core@0.30.1

## 0.30.0

### Minor Changes

- 83c01c8: fix: keep target cohorts additive to rollout

### Patch Changes

- Updated dependencies [83c01c8]
  - @hot-updater/server@0.30.0
  - @hot-updater/cli-tools@0.30.0
  - @hot-updater/plugin-core@0.30.0

## 0.29.8

### Patch Changes

- @hot-updater/cli-tools@0.29.8
- @hot-updater/server@0.29.8
- @hot-updater/plugin-core@0.29.8

## 0.29.7

### Patch Changes

- @hot-updater/cli-tools@0.29.7
- @hot-updater/server@0.29.7
- @hot-updater/plugin-core@0.29.7

## 0.29.6

### Patch Changes

- 80cce61: feat(cli): merge init config on re-run
- Updated dependencies [80cce61]
  - @hot-updater/cli-tools@0.29.6
  - @hot-updater/server@0.29.6
  - @hot-updater/plugin-core@0.29.6

## 0.29.5

### Patch Changes

- 52208f4: perf: Fast-path lambda update checks through plugin-core
- Updated dependencies [52208f4]
  - @hot-updater/server@0.29.5
  - @hot-updater/plugin-core@0.29.5
  - @hot-updater/cli-tools@0.29.5

## 0.29.4

### Patch Changes

- @hot-updater/cli-tools@0.29.4
- @hot-updater/server@0.29.4
- @hot-updater/plugin-core@0.29.4

## 0.29.3

### Patch Changes

- 92724f3: fix(aws): normalize S3 bucket regions during init
- Updated dependencies [d1ffb83]
  - @hot-updater/plugin-core@0.29.3
  - @hot-updater/server@0.29.3
  - @hot-updater/cli-tools@0.29.3

## 0.29.2

### Patch Changes

- Updated dependencies [2a1bc80]
  - @hot-updater/cli-tools@0.29.2
  - @hot-updater/server@0.29.2
  - @hot-updater/plugin-core@0.29.2

## 0.29.1

### Patch Changes

- @hot-updater/cli-tools@0.29.1
- @hot-updater/server@0.29.1
- @hot-updater/plugin-core@0.29.1

## 0.29.0

### Minor Changes

- a935992: feat: Rollout feature with control from 1% to 100%
- a935992: Add provider-specific serverless plugins for `createHotUpdater()` and refactor
  the managed runtimes to use `hotUpdater.handler` directly with a legacy exact-path
  rewrite route.

### Patch Changes

- d0fe908: fix(console): rebuild copied bundles with fresh uuidv7 ids
- Updated dependencies [a935992]
- Updated dependencies [d0fe908]
- Updated dependencies [a935992]
  - @hot-updater/plugin-core@0.29.0
  - @hot-updater/cli-tools@0.29.0
  - @hot-updater/server@0.29.0

## 0.28.0

### Patch Changes

- @hot-updater/cli-tools@0.28.0
- @hot-updater/plugin-core@0.28.0

## 0.27.1

### Patch Changes

- @hot-updater/cli-tools@0.27.1
- @hot-updater/plugin-core@0.27.1

## 0.27.0

### Minor Changes

- 81f9437: feat(android): for safe reloading, Android reloads the process (#869)

### Patch Changes

- Updated dependencies [81f9437]
  - @hot-updater/cli-tools@0.27.0
  - @hot-updater/plugin-core@0.27.0

## 0.26.2

### Patch Changes

- 648cd1b: chore(aws): bump packages
  - @hot-updater/cli-tools@0.26.2
  - @hot-updater/plugin-core@0.26.2

## 0.26.1

### Patch Changes

- @hot-updater/cli-tools@0.26.1
- @hot-updater/plugin-core@0.26.1

## 0.26.0

### Patch Changes

- @hot-updater/cli-tools@0.26.0
- @hot-updater/plugin-core@0.26.0

## 0.25.14

### Patch Changes

- cc8d308: fix(aws): use cache policies compatible with CloudFront plan billing mode
  - @hot-updater/cli-tools@0.25.14
  - @hot-updater/plugin-core@0.25.14

## 0.25.13

### Patch Changes

- @hot-updater/cli-tools@0.25.13
- @hot-updater/plugin-core@0.25.13

## 0.25.12

### Patch Changes

- @hot-updater/cli-tools@0.25.12
- @hot-updater/plugin-core@0.25.12

## 0.25.11

### Patch Changes

- @hot-updater/cli-tools@0.25.11
- @hot-updater/plugin-core@0.25.11

## 0.25.10

### Patch Changes

- Updated dependencies [90f9610]
- Updated dependencies [03c5adc]
  - @hot-updater/cli-tools@0.25.10
  - @hot-updater/plugin-core@0.25.10

## 0.25.9

### Patch Changes

- Updated dependencies [6b22072]
  - @hot-updater/plugin-core@0.25.9
  - @hot-updater/cli-tools@0.25.9

## 0.25.8

### Patch Changes

- @hot-updater/cli-tools@0.25.8
- @hot-updater/plugin-core@0.25.8

## 0.25.7

### Patch Changes

- @hot-updater/cli-tools@0.25.7
- @hot-updater/plugin-core@0.25.7

## 0.25.6

### Patch Changes

- @hot-updater/cli-tools@0.25.6
- @hot-updater/plugin-core@0.25.6

## 0.25.5

### Patch Changes

- @hot-updater/cli-tools@0.25.5
- @hot-updater/plugin-core@0.25.5

## 0.25.4

### Patch Changes

- Updated dependencies [8c83ff2]
  - @hot-updater/cli-tools@0.25.4
  - @hot-updater/plugin-core@0.25.4

## 0.25.3

### Patch Changes

- @hot-updater/cli-tools@0.25.3
- @hot-updater/plugin-core@0.25.3

## 0.25.2

### Patch Changes

- @hot-updater/cli-tools@0.25.2
- @hot-updater/plugin-core@0.25.2

## 0.25.1

### Patch Changes

- @hot-updater/cli-tools@0.25.1
- @hot-updater/plugin-core@0.25.1

## 0.25.0

### Patch Changes

- @hot-updater/cli-tools@0.25.0
- @hot-updater/plugin-core@0.25.0

## 0.24.7

### Patch Changes

- 294e324: fix: update babel plugin path in documentation and plugin files
- Updated dependencies [294e324]
  - @hot-updater/cli-tools@0.24.7
  - @hot-updater/plugin-core@0.24.7

## 0.24.6

### Patch Changes

- 9d7b6af: feat(aws): sso template with fromSSO
- Updated dependencies [9d7b6af]
  - @hot-updater/cli-tools@0.24.6
  - @hot-updater/plugin-core@0.24.6

## 0.24.5

### Patch Changes

- @hot-updater/cli-tools@0.24.5
- @hot-updater/plugin-core@0.24.5

## 0.24.4

### Patch Changes

- Updated dependencies [7ed539f]
  - @hot-updater/plugin-core@0.24.4
  - @hot-updater/cli-tools@0.24.4

## 0.24.3

### Patch Changes

- @hot-updater/cli-tools@0.24.3
- @hot-updater/plugin-core@0.24.3

## 0.24.2

### Patch Changes

- @hot-updater/cli-tools@0.24.2
- @hot-updater/plugin-core@0.24.2

## 0.24.1

### Patch Changes

- @hot-updater/cli-tools@0.24.1
- @hot-updater/plugin-core@0.24.1

## 0.24.0

### Patch Changes

- @hot-updater/cli-tools@0.24.0
- @hot-updater/plugin-core@0.24.0

## 0.23.1

### Patch Changes

- @hot-updater/cli-tools@0.23.1
- @hot-updater/plugin-core@0.23.1

## 0.23.0

### Patch Changes

- @hot-updater/plugin-core@0.23.0
- @hot-updater/cli-tools@0.23.0

## 0.22.2

### Patch Changes

- @hot-updater/cli-tools@0.22.2
- @hot-updater/plugin-core@0.22.2

## 0.22.1

### Patch Changes

- @hot-updater/cli-tools@0.22.1
- @hot-updater/plugin-core@0.22.1

## 0.22.0

### Patch Changes

- @hot-updater/cli-tools@0.22.0
- @hot-updater/plugin-core@0.22.0

## 0.21.15

### Patch Changes

- @hot-updater/cli-tools@0.21.15
- @hot-updater/plugin-core@0.21.15

## 0.21.14

### Patch Changes

- @hot-updater/cli-tools@0.21.14
- @hot-updater/plugin-core@0.21.14

## 0.21.13

### Patch Changes

- @hot-updater/cli-tools@0.21.13
- @hot-updater/plugin-core@0.21.13

## 0.21.12

### Patch Changes

- 5c4b98e: feat(storage): createStoragePlugin
- Updated dependencies [5c4b98e]
  - @hot-updater/plugin-core@0.21.12
  - @hot-updater/cli-tools@0.21.12

## 0.21.11

### Patch Changes

- e2b67d7: fix(cli-tools): esm only package bundle
- 2905e47: feat(server): supports hot-updater database plugin style
- Updated dependencies [d6c3a65]
- Updated dependencies [e2b67d7]
  - @hot-updater/cli-tools@0.21.11
  - @hot-updater/plugin-core@0.21.11

## 0.21.10

### Patch Changes

- @hot-updater/cli-tools@0.21.10
- @hot-updater/plugin-core@0.21.10

## 0.21.9

### Patch Changes

- Updated dependencies [aa399a6]
  - @hot-updater/plugin-core@0.21.9
  - @hot-updater/cli-tools@0.21.9

## 0.21.8

### Patch Changes

- 3fe8c81: feat(plugin-core): reduced deps for edge-runtime
- Updated dependencies [3fe8c81]
  - @hot-updater/plugin-core@0.21.8
  - @hot-updater/cli-tools@0.21.8

## 0.21.7

### Patch Changes

- 2b408f2: docs: revamp hot-updater.dev
- Updated dependencies [2b408f2]
  - @hot-updater/plugin-core@0.21.7

## 0.21.6

### Patch Changes

- @hot-updater/plugin-core@0.21.6

## 0.21.5

### Patch Changes

- @hot-updater/plugin-core@0.21.5

## 0.21.4

### Patch Changes

- Updated dependencies [5d3070a]
  - @hot-updater/plugin-core@0.21.4

## 0.21.3

### Patch Changes

- @hot-updater/plugin-core@0.21.3

## 0.21.2

### Patch Changes

- @hot-updater/plugin-core@0.21.2

## 0.21.1

### Patch Changes

- Updated dependencies [7b7bc48]
  - @hot-updater/plugin-core@0.21.1

## 0.22.0

### Minor Changes

- 610b2dd: feat: supports `compressStrategy` => `tar.br` (brotli) / `tar.gz` (gzip)
- 036f8f0: feat: support `@hot-updater/server` for self-hosted (WIP)

### Patch Changes

- Updated dependencies [610b2dd]
- Updated dependencies [afb084b]
- Updated dependencies [036f8f0]
  - @hot-updater/plugin-core@0.22.0

## 0.20.15

### Patch Changes

- Updated dependencies [526a5ba]
- Updated dependencies [ddf6f2c]
  - @hot-updater/plugin-core@0.20.15

## 0.20.14

### Patch Changes

- a61fa0e: fix(aws): lambda using cloudfront private key from parameter store
- Updated dependencies [a61fa0e]
  - @hot-updater/plugin-core@0.20.14

## 0.20.13

### Patch Changes

- @hot-updater/plugin-core@0.20.13

## 0.20.12

### Patch Changes

- @hot-updater/plugin-core@0.20.12

## 0.20.11

### Patch Changes

- Updated dependencies [cb9c05b]
  - @hot-updater/plugin-core@0.20.11

## 0.20.10

### Patch Changes

- @hot-updater/plugin-core@0.20.10

## 0.20.9

### Patch Changes

- @hot-updater/plugin-core@0.20.9

## 0.20.8

### Patch Changes

- Updated dependencies [ad7c999]
  - @hot-updater/plugin-core@0.20.8

## 0.20.7

### Patch Changes

- a92992c: chore(tsdown): failOnWarn true
- Updated dependencies [a92992c]
  - @hot-updater/plugin-core@0.20.7

## 0.20.6

### Patch Changes

- Updated dependencies [6a905d8]
  - @hot-updater/plugin-core@0.20.6

## 0.20.5

### Patch Changes

- @hot-updater/plugin-core@0.20.5

## 0.20.4

### Patch Changes

- 711392b: feat: default updateStrategy is 'appVersion'
- Updated dependencies [5314b31]
- Updated dependencies [711392b]
  - @hot-updater/plugin-core@0.20.4

## 0.20.3

### Patch Changes

- Updated dependencies [e63056a]
  - @hot-updater/plugin-core@0.20.3

## 0.20.2

### Patch Changes

- Updated dependencies [0e78fb0]
  - @hot-updater/plugin-core@0.20.2

## 0.20.1

### Patch Changes

- Updated dependencies [a3a4a28]
  - @hot-updater/plugin-core@0.20.1

## 0.20.0

### Patch Changes

- Updated dependencies [bc8e23d]
  - @hot-updater/plugin-core@0.20.0

## 0.19.10

### Patch Changes

- 4be92bd: link
- 2bc52e8: feat(storage): add support for target storage location and return storageUri (v0.18.0+)
- Updated dependencies [2bc52e8]
  - @hot-updater/plugin-core@0.19.10

## 0.19.9

### Patch Changes

- bcf6798: Extend signedUrl expiration for cacheable endpoints
  - @hot-updater/plugin-core@0.19.9

## 0.19.8

### Patch Changes

- @hot-updater/plugin-core@0.19.8

## 0.19.7

### Patch Changes

- @hot-updater/plugin-core@0.19.7

## 0.19.6

### Patch Changes

- 657a10e: Android Native Build - Gradle Build
- Updated dependencies [657a10e]
  - @hot-updater/plugin-core@0.19.6

## 0.19.5

### Patch Changes

- 40d28c2: bump rnef
- Updated dependencies [40d28c2]
  - @hot-updater/plugin-core@0.19.5

## 0.19.4

### Patch Changes

- Updated dependencies [0ddc955]
  - @hot-updater/plugin-core@0.19.4

## 0.19.3

### Patch Changes

- Updated dependencies [0c0ab1d]
  - @hot-updater/plugin-core@0.19.3

## 0.19.2

### Patch Changes

- @hot-updater/plugin-core@0.19.2

## 0.19.1

### Patch Changes

- @hot-updater/plugin-core@0.19.1

## 0.19.0

### Patch Changes

- Updated dependencies [886809d]
  - @hot-updater/plugin-core@0.19.0

## 0.18.5

### Patch Changes

- Updated dependencies [494ce31]
  - @hot-updater/plugin-core@0.18.5

## 0.18.4

### Patch Changes

- @hot-updater/plugin-core@0.18.4

## 0.18.3

### Patch Changes

- d56a2b3: hot-updater doctor
  - @hot-updater/plugin-core@0.18.3

## 0.18.2

### Patch Changes

- 437c98e: fix: pagination doesn't work (edit database spec)
- Updated dependencies [437c98e]
  - @hot-updater/plugin-core@0.18.2

## 0.18.1

### Patch Changes

- @hot-updater/plugin-core@0.18.1

## 0.18.0

### Minor Changes

- 73ec434: fingerprint-based update stratgy

### Patch Changes

- Updated dependencies [73ec434]
  - @hot-updater/plugin-core@0.18.0
