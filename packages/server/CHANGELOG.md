# @hot-updater/server

## 1.0.0-rc.24

### Patch Changes

- c9cfed7: Release the project-scoped Expo, fingerprint, React Native, and Hermes resolution fixes at 1.0.0-rc.24 so projects can install the same RC of every Hot Updater package.
- Updated dependencies [c9cfed7]
  - @hot-updater/plugin-api-keys@1.0.0-rc.24
  - @hot-updater/plugin-core@1.0.0-rc.24
  - @hot-updater/plugin-insights@1.0.0-rc.24
  - @hot-updater/protocol@1.0.0-rc.24

## 1.0.0-rc.23

### Patch Changes

- c9cfed7: Release with the Expo SDK 58 config fix at 1.0.0-rc.23 so projects can install the same RC of every Hot Updater package.
- Updated dependencies [c9cfed7]
  - @hot-updater/plugin-api-keys@1.0.0-rc.23
  - @hot-updater/plugin-core@1.0.0-rc.23
  - @hot-updater/plugin-insights@1.0.0-rc.23
  - @hot-updater/protocol@1.0.0-rc.23

## 1.0.0-rc.22

### Patch Changes

- c9cfed7: Released with every Hot Updater package at 1.0.0-rc.22, so a project can install the same RC of each one.
- Updated dependencies [c9cfed7]
  - @hot-updater/plugin-api-keys@1.0.0-rc.22
  - @hot-updater/plugin-core@1.0.0-rc.22
  - @hot-updater/plugin-insights@1.0.0-rc.22
  - @hot-updater/protocol@1.0.0-rc.22

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

- ab04e15: Plugins no longer add `hot-updater` commands. `PluginCli` keeps `clientCredential` and `clientPlugin`, the metadata that `hot-updater init`, `hot-updater doctor`, and the agent scaffold read, and its `commands` is removed, with no replacement:
  - These names are removed from every package: `PluginCommand`, `PluginCommandArgument`, `PluginCommandOption`, `PluginCommandContext`, `PluginCommandUi`, and `PluginTableColumn`, which rc.20 exported from `@hot-updater/server/plugins`, and `pluginCommandsOf` and `PluginCommandEntry`, which rc.20 exported from `@hot-updater/server/db`.
  - `createHotUpdater` refuses a plugin whose `cli` holds `commands`, or any key other than `clientCredential` and `clientPlugin`, with `HotUpdaterConfigError`.
  - The CLI no longer looks for plugin commands, and `hot-updater --help` no longer lists **Plugin commands**.

  `hot-updater api-key create|list|revoke` is a built-in command again: `create --name <name>`, `list` with `--json`, and `revoke <id>` with `-y`, each with an optional trailing `[serverPath]`. It manages keys through `apiKeys()` over the first of:
  - the server file `serverPath` names, such as `src/hotUpdater.ts` in a server project;
  - `database` and `plugins` in `hot-updater.config.ts`, when the config sets `database`;
  - `src/hotUpdater.*` or `src/db.*`.

  When those plugins lack `apiKeys()`, it says to add it. With `database: standaloneRepository(...)`, it says to run the command in the server project with the server file's path, since the admin API serves no API key routes. The `cli` of `apiKeys()` from `@hot-updater/plugin-api-keys` holds only its `clientCredential`.

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

- 0d8d03b: A server checks that its storage serves downloads (`get` and `getDownloadUrl`) where it first reads `hotUpdater.handlers`, so the CLI and the console can run `createHotUpdater` over the storage in their config, which only uploads.
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

### Patch Changes

- c9cfed7: Every package now shares one release candidate version: `hot-updater` and every `@hot-updater/*` package move to the same version, so an app, its server, and the console can pin one version.
- 73f809e: `@hot-updater/server` and `@hot-updater/console` are now licensed under the MIT License with a hosted service attribution condition. A service that offers either of them, or a service built on them, to other people for updating their own apps must show "Powered by hot-updater" with a link where its users can see it. Running them for your own apps, or for apps you build for clients, needs no notice. The Console's sidebar now shows "Powered by hot-updater", and keeping it satisfies the condition. Every other package stays under the MIT License, and versions released before this one keep their MIT License.
- f185d6d: Insights and API keys ship as their own packages: `@hot-updater/plugin-insights`, with `./server` and `./client`, and `@hot-updater/plugin-api-keys`, with `./server`. `@hot-updater/server` and `@hot-updater/react-native` depend on them: the server re-exports them from `@hot-updater/server/plugins/insights` and `@hot-updater/server/plugins/api-keys`, and the app SDK exports the Insights client from its root, so servers and apps install nothing more.
- f185d6d: The plugin authoring APIs move below the packages that run plugins, so a plugin package needs neither `@hot-updater/server` nor `@hot-updater/react-native` to build:
  - `@hot-updater/plugin-core` exports `definePlugin` and its types, the schema DSL, the typed database handle, the database errors, `isDatabaseBusyError`, `HotUpdaterConfigError`, and `CoreReads`, now an explicit interface of core's reads.
  - `@hot-updater/protocol` exports the client plugin contract: `defineClientPlugin` and its hook and context types. `@hot-updater/react-native` exports the same names as before.

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

- 9dc4baf: The plugin ids `insights` and `apiKeys` belong to Hot Updater's `insights()` and `apiKeys()`, even when a server doesn't run them. `createHotUpdater` refuses any other plugin that takes one of these ids with `HotUpdaterConfigError`, including a copy such as `{ ...insights() }`, so the tooling that reads a server's plugins (the client credential, client plugins, and `hot-updater api-key`) reads Hot Updater's own. The console serves a feature only through Hot Updater's own plugin.
- bb57f25: What fills one slot of a config is now an adapter: storage, build, database, and signing. What you list in `plugins` stays a plugin: server plugins, client plugins, and the Sentry, Datadog, and BugSnag integration plugins that wrap a build adapter.
  - `@hot-updater/plugin-core`: `StoragePlugin` is `StorageAdapter`, `createStoragePlugin` is `createStorageAdapter`, `StoragePluginWith` is `StorageAdapterWith`, `CreateStoragePluginOptions` is `CreateStorageAdapterOptions`, `BuildPlugin` is `BuildAdapter`, `BuildPluginConfig` is `BuildAdapterConfig`, `BasePluginArgs` is `BuildAdapterArgs`, `BundleSigningPlugin` is `BundleSigningAdapter`, and `DatabasePluginInputError` is `DatabaseAdapterInputError`. There are no aliases.
  - `@hot-updater/bare`, `@hot-updater/expo`, and `@hot-updater/rock`: their options types are `BareAdapterConfig`, `ExpoAdapterConfig`, and `RockAdapterConfig`.
  - The CLI, the server, and the console say "storage adapter", "build adapter", "database adapter", and "signing adapter" in their messages, such as `Storage adapter "<name>" does not implement <operation>.` and `No storage adapter for protocol: <protocol>`. `hot-updater init --build <adapter>` names its option accordingly.

  Package names and factory names do not change: `s3Storage()`, `r2Storage()`, `bare()`, `expo()`, `rock()`, `postgres()`, and the rest are configured as before.

- Updated dependencies [c9cfed7]
- Updated dependencies [5ec6796]
- Updated dependencies [ab04e15]
- Updated dependencies [f185d6d]
- Updated dependencies [f185d6d]
- Updated dependencies [ab04e15]
- Updated dependencies [4d15862]
- Updated dependencies [48cdd14]
- Updated dependencies [049fad1]
- Updated dependencies [61fcd51]
- Updated dependencies [bb57f25]
  - @hot-updater/protocol@1.0.0-rc.21
  - @hot-updater/plugin-core@1.0.0-rc.21
  - @hot-updater/plugin-insights@1.0.0-rc.21
  - @hot-updater/plugin-api-keys@1.0.0-rc.21

## 1.0.0-rc.18

### Minor Changes

- 9cd555b: The plugin that provides `clientAuth` describes the credential an app sends in `cli.clientCredential`: its label, header, environment variable, and how to generate and provision it. `@hot-updater/server/db` exports `clientAuthOf`, `generateClientCredential`, and `provisionClientCredential`, which read it from a plugin list.

  Managed init provisions the app's credential through the provider's plugins and prints `HotUpdater.init` with that credential's header, or with no `requestHeaders` when client routes are public; `@hot-updater/cli-tools` exports `renderAppSetup` and `printAppSetup` for it. AWS CloudFront cache and origin-request policies key on the client-route policy's `varyHeaders` instead of a fixed `x-api-key`.

  Agent and infrastructure scaffolds record the server's `clientAuth` in `manifest.json` and render their instructions from it. The helper is `app/provision-client-credential.mjs` with `app/database.config.ts`, and it saves `app/client-credential.local`. `hot-updater doctor` reads the credential's header and variable from the scaffold, and skips the 401 check when client routes are public.

- 9cd555b: A server plugin names the client plugin an app adds to `HotUpdater.init`'s `plugins` in `cli.clientPlugin`, as `{ module, name }`; `insights()` names `insights` from `@hot-updater/react-native/plugins/insights`. `createHotUpdater` checks them at startup: each names an export the app can import, not a reserved word, `App`, or `HotUpdater`, and no two plugins name one export from different modules. `@hot-updater/server/db` exports `clientPluginsOf`, which reads them from a plugin list. Managed init passes them to `printAppSetup`, which imports them and adds them to `plugins`, and agent scaffolds record them in `manifest.json` and render the app code in their instructions from them.
- 9cd555b: `setupDatabaseTestSuite` runs core's suites only; server plugins' suites run when a provider lists them in `plugins`. The Insights suites moved to the Insights plugin: pass `insightsTestSuite({ createModel })` from `@hot-updater/server/plugins/insights/testing`, which also exports `setupInsightsModelTestSuite` and `createBundleEventRowFixture`, and serve `insights()` from `createHttpClient`. `createInsightsModel` is no longer an option of `setupDatabaseTestSuite`, and `@hot-updater/test-utils` no longer exports the Insights suites.
- 9cd555b: Server plugins add their own `hot-updater` commands through a `cli` field on `definePlugin`. A command runs `run` with the plugin's API over a database the CLI opens itself; with a `standaloneRepository` config, it asks for the server config that exports `hotUpdater`. The CLI looks for plugin commands only when it has no core command of that name: in a server config the command line names, then `hotUpdater.plugins.ts` over the database in `hot-updater.config.ts`, then `hot-updater.config.ts`, `src/hotUpdater.ts`, or `src/db.ts`. `hot-updater --help` and the unknown-command error list them under **Plugin commands**, marked with their plugin's id.

  `hot-updater api-key create|list|revoke` now comes from `apiKeys()`, with the same arguments and options, and also runs in managed projects through `hotUpdater.plugins.ts`. `@hot-updater/server/db` exports `serverPluginsOf` and `pluginCommandsOf` for tooling.

### Patch Changes

- e696e69: Aggregates declared with `batched: true` in `defineAggregate` apply after the transaction that changed them commits, merged with other transactions' changes into one write per aggregate row, on a database that batches aggregates. Insights' counters, gauges, and sketches are batched; core's bundle counters are not.
  - In `aggregateBatching: { mode: "log" }`, the default, a transaction that changes a batched aggregate also writes one compressed log row in the same atomic write. A compaction applies a group of pending log rows in one write, together with a lease row that lists them as applied, then deletes them. Only one compaction runs at a time, under the lease. No crash loses a change or applies one twice. A commit starts a compaction once `windowMs`, 60 seconds by default, has passed since the last one. A read of a batched aggregate compacts first; when it cannot write, it serves the stored aggregates and logs one warning.
  - In `aggregateBatching: { mode: "memory" }`, meant for a long-lived server, changes stay in the process and are flushed every `windowMs`, 15 seconds by default. No log rows are written, but a crash loses up to one window. `hotUpdater.flush()` applies what is pending before the process exits.

  A batched gauge can be negative on one shard row, because each write puts a row's net change on a single shard; reads sum the shards. `createEngineDatabase` takes `aggregateBatching`. `@hot-updater/server/database` exports `aggregateBatchingModule`, the log and lease tables that an engine which batches needs in its schema. The key-value helper implements the adapter's optional `deleteConsumed` when its store does.

- 9574287: Cache a scope's missing Release Catalog like a catalog. The `404` for a scope with no catalog yet, such as a store version before its first OTA release, now uses the catalog's `public, max-age=0, s-maxage=5` and is marked `x-hot-updater-catalog: none`, so a shared cache absorbs those update checks instead of passing each one to the origin. Other `404`s stay `private, no-store` and unmarked. `hot-updater doctor` and the agent server check accept the marked `404` as an empty catalog and still reject an unmarked one.
- 1ddd5fc: Insights writes less for each report. An installation's `UNCHANGED` report that repeats its latest report on the same UTC day, with the same channel, platform, app version, bundle, Release, and user, records nothing, so launch counts count daily active installations. An `UNCHANGED` report still updates the installation's latest report and the launch metrics, but is not stored as an event: no event list holds it, `GET /events` answers `400` for `outcome=unchanged`, `GET /overview` no longer returns `bundle.unchangedReports`, and `InsightsBundleEventFilter` no longer takes `UNCHANGED`. The latest-installation gauges count each installation in the UTC day of its latest report: `countLatestEvents` takes the start of a UTC day as `sinceMs`, `GET /overview` counts from the start of the UTC day its window reaches into, and the App usage distribution covers every UTC day its window touches. Usage sketches are kept per platform and merged for every platform on read, and a channel's unique users come from its usage sketches. On DynamoDB a new installation's first launch writes 15 items (40 write units) instead of 27 (76), and a relaunch the same UTC day writes nothing instead of 12 or 26 items.
- 530cca5: Insights keeps its data for set periods: by default, downloads, applies, recoveries, and hourly totals for 90 days; daily totals, unique-installation sketches, and latest-report distributions for 400 days; and each installation's latest report for 400 days after it last reports. Lifetime counters per Release ID are kept. `insights({ retention: { rawDays, dailyDays } })` sets the periods, in whole days of at least 1 with `dailyDays` at least `rawDays`, and throws `HotUpdaterConfigError` otherwise. A changed period applies at the next pruning pass on SQL databases; on DynamoDB, Firestore, and MongoDB, rows already written keep the expiry they were stamped with. `api.insights.retention` and the admin route `GET /retention` report the periods. Daily and lifetime totals have their own tables, `insights_overview_daily`, `insights_sketches_daily`, and `insights_overview_lifetime`, under the plugin's schema `1.1.0`. `getAppUsage` and a channel's `getReleaseActivity` read daily totals for a window of whole UTC days that reaches past the raw period, and a read that reaches past what is kept reports partial coverage.
- b317d49: Insights records update failures. `POST /events` takes `UPDATE_FAILED`, whose `metadata.failure` says where (`stage`: `check`, `download`, or `install`) and why (`reason`) an update failed, with optional `resource`, `httpStatus`, `originCode`, `transport`, and `previousProcessExit`. `UPDATE_DOWNLOADED` takes `metadata.delivery` and `metadata.patchFallback`, and `RECOVERED` takes `metadata.previousProcessExit`; each is stored in snake_case. An unknown value of a set reads as `unknown`, a missing or malformed failure counts as an unknown stage and reason, and a malformed optional field is left out: only a report without its identity, bundles, or a valid event ID is refused. A failure is stored as an event, which event lists, installation history, and `outcome=failed` bundle lists show, but it moves no latest report and counts as no launch or activity. A failed check names no target, so it counts for its channel and appears in no bundle list.

  A breakdown counts failures by stage, reason, and what else the client knew, and recoveries by exit reason, by hour, kept for the raw period; a period's failure counts are summed from it. HyperLogLog sketches count failed installations per release, by hour and since the release's first failure, and per channel by hour and day, and installations with a failed check per channel; a release's lifetime counters count its failed updates. Download reports also count patch deliveries and patch fallbacks. `api.insights.getUpdateFailures({ platform, channel, releaseId?, timeRange? })` and the admin route `GET /failures` read them, over at most 30 days or since a release's first report, and `GET /overview` returns `bundle.failedReports`. Event rows carry `failure`, `delivery`, `patchFallback`, and `previousProcessExit`.

  `username` is no longer part of a report: the server ignores it like any field it does not know, and neither event rows nor installations return it. Latest reports always count in the UTC day of their report, and `bundle_event_heads` no longer has `current_release_id`. The plugin's schema is `1.2.0`, with `insights_sketches_lifetime` and `insights_failures`: a deployment from a 1.0.0 release candidate recreates its database and updates the server, app, and console together. On DynamoDB a failed download or install writes 14 items (36 write units) and a failed check 9 (22); a recovery with an exit reason writes one item more.

- 9a6715f: The root entry exports only core. `createInsightsProvider`, the Insights provider, domain, and model types, `BundleEventRow`, `API_KEY_HEADER_NAME`, and the API key management and row types come from `@hot-updater/server/plugins/insights` and `@hot-updater/server/plugins/api-keys`. `@hot-updater/server/plugins` exports `isDatabaseBusyError`, which tells a busy database (a transaction out of retries, or a throttled request) from a failure so a plugin's route can answer `503`, and `addDistinct`, `mergeDistinct`, and `countDistinct` for an aggregate's `distinct` metrics. A `clientAccess` object is rejected with a message that names no plugin: set `clientAccess: "public"`, or add a plugin that provides `clientAuth`.
- a084eda: Core's database holds only core's tables. The plugins a server runs bring theirs, `insights()` and `apiKeys()` included, and core serves no Insights route.
  - **Schema:** `@hot-updater/server/database` exports `coreSchema`, `coreSettings`, and `coreTarget`, core's tables, settings rows, and tooling target; `toolingTargetOf(plugins)`, the target of core with those plugins; and `migrateCoreSchema(adapter, name, plugins?)`, which creates core's tables and those of `plugins`, then writes their settings rows. `createEngineDatabase` checks core's settings rows, and a server also checks those of the plugins it runs.
  - **Tooling:** `hot-updater db migrate` and `db generate` create core's tables and those of the server's `plugins`. A server without `insights()` or `apiKeys()` has no Insights or API key tables.
  - **Plugin tables:** `definePlugin` takes `namespace: false`, which keeps the declared table names instead of prefixing them with the plugin's id. Such a plugin owns collisions, which startup checks against core's tables and those of the other plugins the server runs, and only such a plugin may take a camelCase id. `insights()` and `apiKeys()` set it, so their tables and settings rows keep their names. A plugin's id and tables need to be free only of core's and of the other plugins the server runs.
  - **Insights routes:** without `insights()`, `POST /events` and the admin Insights reads are not mounted and answer `404`. The React Native Insights plugin then pauses reporting.

- 530cca5: Tables and aggregates can expire their rows, with no scheduler. `defineTable` and `defineAggregate` take `retention: { field, days }`, where `field` is an integer field of epoch milliseconds and a row expires `days` after it; a model with retention takes part in no reference or rooted index. The days are a runtime value, so a plugin may take them as an option: the tables and indexes are the same for any period. DynamoDB and Firestore delete expired rows with their native TTL: the key-value helper stamps each row's items and index copies with their expiry, kept as `_ttl` and `expireAt`. MongoDB stamps `_expireAt`, a Date, under a TTL index. On PostgreSQL, MySQL, SQLite, D1, and Supabase, the adapter implements the optional `DatabaseAdapter.prune(table, before, limit)` over an index that leads with the field, which `hot-updater db generate` and `db migrate` create when the table has none, and the server prunes during writes: the write that takes the lease row in the settings table first deletes up to 500 expired rows a table, and other servers skip. The next pass is due in an hour, or in a minute while a pass still found a full batch. The adapter conformance suite takes `retention: "prune"` or `"ttl"` and checks either, and the read-budget suite expects recording an Insights event to read its 7 rows in 4 batch gets.
- b317d49: The Insights suites in `@hot-updater/server/plugins/insights/testing` check update failures. The model suite checks that an update failure is listed in event lists and installation history without moving the latest report, and that a failed check is in no bundle list. The HTTP routes suite records a failure and reads it through `GET /failures`, and `createBundleEventRowFixture` no longer carries `username`. The read-budget suite in `@hot-updater/test-utils` reads a release's and a channel's update failures, over a period and since the release's first report, and its local Insights types follow the new event row.
- Updated dependencies [e696e69]
- Updated dependencies [1ddd5fc]
- Updated dependencies [9a6715f]
- Updated dependencies [530cca5]
  - @hot-updater/plugin-core@1.0.0-rc.17

## 1.0.0-rc.17

### Minor Changes

- 038c804: Move `createBundleDiff` from `@hot-updater/server/db` to its own entry, `@hot-updater/server/diff`. The `db` entry no longer loads bsdiff's WebAssembly, so a console that uses it builds for Cloudflare Workers.

## 1.0.0-rc.16

### Minor Changes

- 152db48: `createEngineDatabase` takes `onCachedRoutesChange`, a CDN purge for the cacheable client routes that core calls after a committed write that changes a Release Catalog. Core decides which writes those are, so neither a provider adapter nor the storage engine names a table: `dynamoDB` passes its CloudFront invalidation there.
- 802374f: Add the built-in API keys plugin at `@hot-updater/server/plugins/api-keys`. `apiKeys({ headerName })` declares v1's `api_keys` columns, including `prefix` and `role`, with a unique `hash` and a `byCreated` index.
  - **clientAuth:** it provides `clientAuth` through the unchanged `authenticateApiKey`, so only active keys whose SHA-256 digest is stored pass. Client routes vary by the configured header, and a storage failure answers 503.
  - **Managing keys:** `hotUpdater.api.apiKeys` creates keys (plaintext returned once), lists and revokes them without hashes, and registers or provisions a saved key idempotently for managed init.

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

- 8d60f68: Move the console onto core's API: key cursors, indexed filter sets, counters, and a banner when Insights is off.
  - **Bundles:** the list pages by key, with Previous, Next, and Newest in place of page numbers. Each page reads only its own releases.
  - **Filters:** the filters are the sets the release indexes serve: a channel with its platform (and status), an artifact, or a target, which is one catalog scope. The platform filter works with a channel, and the target app version filter is replaced by "Show bundles for this target" in a bundle's diagnostics.
  - **Counters:** patch counts and a bundle's children come from its reference counter and the patches index, not from paging every bundle. Bundle totals come from one counter row.
  - **Core:** bundles, releases, catalogs, and channels go through core's API: in process on the database's storage engine, or over a self-hosted server's admin API protocol 2. Creating a channel takes its name. A database that is not on the storage engine is refused with a message to upgrade its provider.
  - **Insights off:** when the server runs without `insights()`, the Insights pages and bundle panels show that Insights is off instead of an error. A self-hosted server is asked through its admin API, which answers 204 with `x-hot-updater-insights: disabled`. The console reads a self-hosted server's events and installations there. Usage and bundle activity need the database config.
  - **Plugins in the console:** `defineConsoleConfig({ plugins })` and a project's `hotUpdater.plugins.ts`, which `hot-updater console` loads, give the console the plugins the server runs. It assembles them over the database with `createDatabasePluginApis` from `@hot-updater/server/db`, on the server's tables. Without them, Insights and API keys are off.
  - **API keys:** the console manages keys through the `apiKeys()` plugin's API. It does not manage a self-hosted server's keys.
  - **`standaloneRepository`:** it has `fetchAdmin(path)`, a GET on the server's admin handler with the repository's headers.
  - **`@hot-updater/cli-tools`:** it adds `loadHotUpdaterPlugins`.

- 294c53f: Move core's writes onto the storage engine: the CLI, the console, and the admin API change bundles, releases, catalogs, and channels only through them.
  - **Release changes rooted at the catalog:** `changeReleases` deploys, updates, or deletes a release and writes its scope's next catalog generation in one transaction. It reads only the catalog row, the scope's enabled releases, and the latest release id (`byScope` descending, limit 1). A concurrent change in the same scope bumps the catalog row, so the transaction reruns instead of publishing a stale catalog. New ids are assigned after the latest release.
  - **Catalog rebuilds:** `rebuildCatalog` recompiles a catalog from the enabled releases and rewrites it only when it changed.
  - **Channels:** channel insert returns the existing row on a name conflict, including under a race. Channel delete reports `not_found` or `not_empty`.
  - **Aggregates:** bundle totals are kept in the same transactions as the rows.
  - **Engine:** rows found through a rooted range can be updated or deleted in that transaction, guarded by their root.

- 94470aa: Add core's schema and reads on the storage engine; `hotUpdater.core` exposes the reads.
  - **Schema:** `bundles`, `bundle_patches`, `releases`, `release_catalogs`, and `channels`, with the PRD's indexes and references, plus the `bundle_totals` counter.
  - **Update check and artifacts:** the update check is one point read of its scope's catalog. Artifact resolution is one batch read of both bundles plus one unique read of their patch.
  - **Bundles:** a bundle's patches are read exactly as its reference counter says, and its child count is the counter on its row.
  - **Auto-patch bases:** a new bundle's bases come from one point read of its scope's catalog, which holds every enabled bundle release of the scope.
  - **Engine:** `findByKeys` reads rows by key in one batch.

- 7758a1e: Run Cloudflare D1 on the new storage engine. `d1Database(config)` over the REST API and `d1Database(env.DB)` inside a Worker keep their signatures.
  - **Batch writes:** D1 has no interactive transactions, so the shared SQL core gains a batch mode. An executor that provides `batch` writes each change as one atomic batch.
    - The batch first records each op's guard in the `_hu_write` guard row, against the rows before any change. Unique fields are checked there too, ignoring rows the same write deletes or patches.
    - Every change then applies only when no guard failed.
    - The last statements read the first failed op and remove the row.
  - **Parameter limit:** `createSqlAdapter` accepts `maxParams`, and splits a batch read to stay within it. D1 allows 100 parameters per statement.
  - **Op limit:** a D1 write sends at most 450 ops, within a Worker invocation's 1,000 queries on the paid plan.
  - **Schema:** `sql/bundles.sql` and the Worker's `0001_hot-updater_1.0.0.sql` migration are now the generated shared SQL schema, with the guard table and the settings rows. A test fails when either file differs from the generator.
  - **Schema fence:** the adapter fences its schema, so handlers answer 503 until the migration has run.
  - **REST:** values are still sent as JSON text and read back with `json_extract`.
  - **Exports:** `@hot-updater/server/database` exports `WRITE_GUARD_TABLE` and `isMultiIndex`.

- 7ba867c: Run the Drizzle adapter on the new storage engine. `drizzleAdapter({ db, provider })` keeps its signature.
  - **Engine:** reads and writes go through the shared SQL core over the Drizzle database's own driver. `db` may also be a function that returns the database on first use.
  - **Drivers:** the first use checks that the driver can run an interactive transaction. The supported drivers are node-postgres, postgres-js, PGlite, and Neon over WebSockets for PostgreSQL; mysql2 for MySQL; and libSQL, better-sqlite3, or bun:sqlite for SQLite. Other drivers are refused with `DrizzleTransactionUnsupportedError`. Sync SQLite drivers run one statement at a time and begin transactions with `BEGIN IMMEDIATE`.
  - **Schema:** `hot-updater db generate` writes the engine's tables as a Drizzle schema for `drizzle-kit push`. Every column is typed exactly as the SQL schema declares it.
  - **Migrations:** after `drizzle-kit push`, `hot-updater db migrate` now runs for Drizzle and writes only the settings rows. It asks for the tables when they are missing and refuses a pre-engine database.
  - **Schema fence:** the adapter fences its schema, so handlers answer 503 until `db migrate` has run.
  - **Unused options:** the `schema` option is accepted and ignored; it is for drizzle-kit. The `transaction` option is gone: every write runs in a transaction.

- b3576f2: Add aggregates to the storage engine's transactions. `tx.aggregate(model, identity, changes, { shardBy })` records counter and gauge deltas and HLL sketches for one shard row. `shardBy` picks the shard with a stable FNV-1a hash, and gauges of a sharded aggregate require it, so each −1/+1 pair lands on one shard.

  At commit, counter-only rows become blind increments that create the row and bump `_v`. Rows with gauges or sketches are read in one batch per table, merged, and written back under a guard, and a row whose counters and gauges reach zero is deleted. When only aggregate rows fail their guard, or the adapter reports a transient failure, the engine re-reads those rows and resends the write instead of rerunning `fn`. `retry.onRetry` reports each rerun and resend.

  The engine assembly moves to `createEngine`, which addresses tables by physical name; `createDatabaseEngine` adds the typed `database(module)` handle on top of it.

  `@hot-updater/test-utils` adds `runContentionHarness`, which starts transactions at a steady rate through a fixed pool and counts how they ended, and `withAdapterLatency`, which delays every adapter call.

- af15ef3: Add the storage engine's reads, from `@hot-updater/server/database`. A module's typed `HotUpdaterDatabase` handle has `findOne` (by key or a unique field), `findMany` (one page of a declared index: every eq field bound, an optional range on the first order field, order, a limit up to `maxPageSize`), and `findAggregates` (logical rows with shards merged). There is no count, offset, or free-form filter. A page returns `next` only when it is full, and the cursor is bound to the model, index, eq values, order, and range, so it cannot resume another read. An aggregate row cut off by the limit is completed by reading only its remaining shards.

  `createDatabaseEngine({ verify: true })` checks every adapter call and `measureReads` reports what one call read from the adapter and returned to the caller. Misused reads fail to type-check with messages that name the right read.

- 0f670c5: Add the storage engine's transactions, from `@hot-updater/server/database`. `db.transaction(fn)` hands `fn` a handle whose `findOne` records every row it reads, null reads by key included, and whose `findMany` reads only rooted indexes, guarding the range through its parent row. `create`, `update` (a patch of a row read in the same transaction), and `delete` coalesce into one op per key, guarded by the version each read saw.

  A failed guard on a row the transaction read reruns `fn` with jittered backoff until the retry budget runs out (`DatabaseConflictError`). `DatabaseConstraintError` reports `exists`, `unique`, `not_found`, `referenced`, and `too_large` only when the current state confirms them, and a write whose outcome is unknown is reported as `DatabaseAmbiguousCommitError` and never rerun. References keep per-relation counters on the parent: `restrict` refuses the delete, and `cascade` deletes the children too. A write sends its inserts first and its deletes last, children before parents. Calling `db.*` inside `fn`, or using the handle after it returns, throws `DatabaseTransactionError`.

- ad00722: Provision API keys through the `apiKeys()` plugin, and let core republish a stored bundle.
  - **`core.deploy`:** a deployment may name a bundle the database already holds, as `{ bundleId, release }`. It publishes a new release for that bundle in the release's scope and writes no bundle. A missing bundle refuses with `DatabaseBundleNotFoundError`. `Deployment` is now `BundleDeployment | StoredBundleDeployment`, and admin API protocol 2's `POST /releases` accepts both.
  - **`createDatabasePluginApis`:** it is typed by its plugin list, so `createDatabasePluginApis(database, plugins).apiKeys.provision(...)` needs no cast.
  - **API key provisioning:** `hot-updater init` for AWS, Cloudflare, Firebase, and Supabase registers the app's client key through the provider's `plugins` (the `apiKeys()` plugin its managed server runs) instead of the database plugin's `models.apiKeys`. The agent scaffold's `provision-api-key.mjs` uses the scaffold's `hotUpdater.plugins.ts` the same way.

- d3a5570: Keep the Insights rollout gate robust under load.
  - **Shards:** the plugin's gauges and sketches, which are read, merged, and written back, get 16 shards. Its blind counters keep 8.
  - **Unchanged merges:** the engine skips an aggregate write that leaves the stored row unchanged, such as a sketch that already counts the installation.

  In the rollout gate, on PostgreSQL in Docker at 100 moves per second over 16 pooled connections with 5 ms added per call, 1.3% of transactions are now retried, against 2.4% before; a loaded run at 8 shards went past 5%. These are test figures, not production limits.

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

- e542054: Run the Kysely adapter and the `postgres` plugin on the new storage engine. Their factory signatures are unchanged.
  - **Kysely:** `kyselyAdapter` runs PostgreSQL, MySQL, and SQLite through the shared SQL core with `kyselyExecutor`.
    - Its migrator applies the generated SQL schema: tables, indexes, and the settings rows, written last.
    - The migrator refuses a v0 or pre-engine database instead of converting it.
  - **Schema fence:** both adapters fence their schema. A database without the `schema.engine` row is refused before its first read, and handlers answer 503.
  - **`postgres` plugin:** `sql/bundles.sql` is now the generated SQL schema, and a test fails when the two differ.
  - **Removed:** the plugin-specific Insights helpers `getKyselyAppUsage`, `getKyselyReleaseActivity`, `readKyselyInsightsHead`, and `recordKyselyInsightsOverview` are no longer exported from `@hot-updater/server`.
  - **Upgrade note:** the 1.0.0 infrastructure upgrade note now says that RC databases created before the adapter redesign must be recreated.

- 73b8920: Run the MongoDB adapter on the new storage engine. `mongoAdapter({ client })` keeps its client option; the `transactions` option is gone, since every write runs in a transaction.
  - **Storage:** each table is a collection with its key as `_id`, and each index is created as declared. Multi-valued fields use multikey indexes, and unique indexes skip missing values, as SQL's skip nulls.
  - **Writes:** every write runs in one transaction, so MongoDB must run as a replica set or a sharded cluster; a standalone server's first write fails with `MongoTransactionUnsupportedError`.
    - Guarded patches and deletes are conditional on the row's version.
    - A `check` is a conditional `$inc`: a real write, so a concurrent transaction on the same document conflicts.
    - Increments create a missing row from its initial values in one upsert.
    - Write conflicts and racing upserts are retried by the engine.
  - **Migrations:** `hot-updater db migrate` creates the collections and indexes, then writes the settings rows. It refuses a v0 database and a database from before the engine.
  - **Schema fence:** the adapter fences its schema, so handlers answer 503 until `db migrate` has run.

- 065c457: Fit the storage engine's schema to MySQL's index limit.
  - **ASCII strings:** a string field can be declared `ascii`, and MySQL stores it in a single-byte `ascii_bin` column. Catalog scope keys, channel keys, and auto-patch candidate keys use it. Candidate keys escape any non-ASCII character in a channel id.
  - **Key size check:** DDL refuses a MySQL key or index over 3,072 bytes before any statement runs.

- 8a03eb2: Narrow the database provider query contract to the operators Hot Updater uses. `DatabaseWhere` accepts only `eq`, `gt`, `gte`, `lt`, `lte`, and `in`, and conditions are always joined with AND. The `ne`, `not_in`, `contains`, `starts_with`, and `ends_with` operators, the `connector` (`OR`) and `mode` (`insensitive`) fields, and `findMany`'s `distinctOn` are removed from the types, the input validation, and every official provider.

  Custom providers built on `@hot-updater/plugin-core/internal` can delete their implementations of the removed operators. Validation rejects a where condition with any key other than `field`, `operator`, and `value`, and rejects `distinctOn`, instead of ignoring them.

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

- d482b13: Create third-party plugins' tables with `hot-updater db`.
  - **Tooling:** `hot-updater db migrate` and `db generate` read the server's `plugins`. Besides the built-in tables, they create each third-party plugin's tables under its id and write its `schema.<id>` settings row last. Kysely's SQL, Drizzle's schema, Prisma's models, MongoDB's collections, and the Supabase and D1 migrations include them; DynamoDB and Firestore need only the settings row.
  - **Fence:** a server on a fenced database also checks each third-party plugin's `schema.<id>` row before its first read, and answers 503 until `db migrate` writes it.
  - **Any engine database:** `createEngineDatabase` gives an adapter with `migrations` the migrator `hot-updater db migrate` runs. The command now works for the `postgres` provider, DynamoDB, Firestore, D1's REST database, and custom adapters, besides the Kysely, Drizzle, Prisma, and MongoDB adapters.
  - **Supabase:** `supabaseDatabase` from `@hot-updater/supabase` generates a migration in `supabase/migrations` with the plugin tables, their row-level security, and an apply RPC that may reach them. Its adapter no longer offers to create tables, since the RPC runs no DDL, so `db migrate` points to `db generate`.
  - **D1:** the REST `d1Database` generates a Wrangler migration in `migrations`, and `db migrate` applies the same schema through the Cloudflare API.
  - **Names:** a third-party plugin may not take a built-in plugin's id, or a table name that resolves to a built-in table, such as an `api` plugin's `keys` table.
  - **SQL core:** `migrations.apply` also creates the write guard table for an executor with `batch`.
  - **Types:** `SchemaGenerator` and `DatabaseTooling.createMigrator` take a `ToolingTarget` (`{ schema, settings }`, exported from `@hot-updater/server/db`); `builtInTarget` from `@hot-updater/server/database` is the target without third-party plugins.
  - **CLI:** `db generate` skips a migration identical to one already in its directory.

- aee193e: Run the Prisma adapter on the new storage engine. `prismaAdapter({ prisma, provider })` keeps its signature; SQL Server is refused.
  - **Engine:** reads and writes go through the shared SQL core, with Prisma's raw queries and interactive transactions. Prisma's P2010 and P2034 errors carry the database's code, so constraints and write conflicts are classified as with other drivers. A SQLite transaction takes the write lock with its first statement, as `BEGIN IMMEDIATE` would.
  - **Schema:** `hot-updater db generate` merges the engine's tables into `prisma/schema.prisma` as models with keys and named indexes, and no relations; the engine keeps references itself. Fields that start with an underscore are mapped, such as `hu_v` to `_v`. On MySQL, ASCII keys are `VarBinary`, which keeps them within InnoDB's key limit.
  - **Migrations:** after `prisma db push` or `prisma migrate`, `hot-updater db migrate` now runs for Prisma. It sets the collations Prisma cannot declare (`COLLATE "C"` on PostgreSQL and binary UTF-8 on MySQL), then writes the settings rows.
  - **Schema fence:** the adapter fences its schema, so handlers answer 503 until `db migrate` has run.
  - **JSON parameters:** PostgreSQL JSON parameters are cast to `jsonb`, since Prisma binds strings as text.
  - **Booleans:** a stored `0n` or `1n` reads as a boolean, as Prisma returns SQLite `BIGINT` values.

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

- eef9466: Add the schema DSL that core and plugins declare their tables with, exported from `@hot-updater/server/plugins` and `@hot-updater/server/database`. `defineTable` declares fields (with `required`, `unique`, `maxLength`, and `references` that `restrict`, `cascade`, or do nothing on delete), derived fields computed on write (single or up to 16 values), and indexes by `eq` and `sort` fields, optionally unique or rooted at a parent table. `defineAggregate` declares identity fields with counters, gauges, or distinct sketches and a fixed shard count. Index declarations that name an undeclared field fail to type-check with a message naming the field.

  `resolveSchema` turns module schemas into physical tables with engine columns (`_v`, per-relation `_refs_<table>_<column>` counters, `_shard`), unique-field indexes, reference metadata, and roots, namespacing third-party modules. `validateSchema` rejects every invalid declaration at once, including nullable or json key fields, a misordered aggregate key, sketches mixed with counters, unknown roots or reference targets, cascades without an index, and multi-valued sort fields.

- 065c457: Add the schema fence for the new storage engine. Migrations write settings rows last, after every table exists: `schema.engine` (`"1"`) and one row per module, such as `schema.core`, `schema.insights`, and `schema.apiKeys`.
  - **Fence:** every provider's database checks those rows with one batch read before its process's first read. A missing or different row throws `HotUpdaterSchemaMigrationRequiredError`, and handlers answer 503. The error now names the setting, the expected value, and the value it found. A missing settings table counts as a missing row; any other read failure, such as a refused connection, is thrown as is.
  - **Old databases:** migrations refuse a database that has `schema.core` but no `schema.engine`, because it predates the engine and must be recreated.
  - **Helpers:** `migrateSchema`, `writeSchemaSettings`, `checkSchemaFence`, `withSchemaFence`, and `isMissingSchemaError` are exported from `@hot-updater/server/database`, and `HotUpdaterSchemaMigrationRequiredError` from `@hot-updater/server/db`.

- 3f30a23: Serve Insights and API keys through plugins.
  - **Insights routes:** `POST /events` and the admin Insights reads come from the `insights()` plugin. Without it, each answers 204 with `x-hot-updater-insights: disabled`.
  - **API keys:** the `apiKeys()` plugin protects client routes with the same header the `clientAccess: { type: "api-key" }` option used, so a server that moves to plugins never falls back to public.
  - **Core reads:** `hotUpdater.core` reads bundles, Releases, Catalogs, and channels. Plugins get the same reads as `ctx.core`, on the same engine. A plugin cannot take the id `core`.
  - **Plugin APIs:** `hotUpdater.api.insights` and `hotUpdater.api.apiKeys` replace `hotUpdater.insights` and `hotUpdater.apiKeys`.
  - **Providers:** `@hot-updater/aws`, `cloudflare`, `firebase`, and `supabase` export `plugins`, their managed server's plugin list (`insights()` and `apiKeys()`). The Lambda, Worker, Cloud Function, and Edge Function templates use it, with the same `x-api-key` header.
  - **CLI:** `generate-standalone-sql` and the missing-export help text use the new options.

- 065c457: Generate the shared SQL schema from the resolved schema. `generateEngineSql(dialect, schema, settings)`, from `@hot-updater/server/db`, emits two things in order:
  - **Tables and indexes:** the engine's version and reference-counter columns default to 0. There are no database foreign keys; the engine keeps references with those counters.
  - **Settings rows:** written last, so the fence passes only once everything exists.

  Providers generate their migrations from it. ORM providers that apply the tables with their own tooling get two more pieces:
  - **Table shapes:** `sqlTableShapes` describes each table as the DDL creates it, so their schema generators match the DDL.
  - **Settings-only migrations:** a migrator writes only the settings rows. It asks for the tables first when they are missing. Table DDL moves out of the SQL adapter's runtime into its own module, and migrations refuse a pre-engine database before changing any table.

- 754a73e: Add the shared SQL core, from `@hot-updater/server/database`. `createSqlAdapter({ executor })` compiles adapter reads and writes to SQL for PostgreSQL, MySQL, and SQLite and runs them through a `SqlExecutor` (one per driver or ORM), with one transaction per write.

  Guards are `UPDATE … WHERE _v = ?`, checks are locking reads (`FOR UPDATE`, or SQLite's `BEGIN IMMEDIATE`), counters are upserts, and index reads compare order tuples with row values (expanded ORs on MySQL). Unique violations name the failed op. Serialization failures, deadlocks, lock timeouts, and `SQLITE_BUSY` ask the engine to retry.

  `createTableStatements` emits DDL with binary collation (`COLLATE "C"`, `utf8mb4_0900_bin`, SQLite's `BINARY`), `bigint` whole numbers, and an index table `<table>__<index>` for each index over a multi-valued field.

  The adapter conformance suite in `@hot-updater/test-utils` now also orders a key with a trailing space after the same key without it.

- df31037: Add the storage adapter contract that every Hot Updater database runs on. An adapter implements batched `get`, index-range `query`, and atomic `write` of guarded ops with its backend's native features, and knows nothing about Hot Updater's domain. `@hot-updater/plugin-core/internal` ships the contract types, value conversion for backend types (int8 text, BigInt, Decimal, SQLite 0/1, JSON text), a `verifyAdapter` wrapper that checks every read and write at the adapter boundary and counts reads, and the reference memory adapter. `@hot-updater/server/database` re-exports them for adapter authors.

  `@hot-updater/test-utils` adds `setupDatabaseAdapterConformanceSuite`: value round-trips, point and range reads, UTF-8 byte ordering, cursor paging without gaps or repeats, multi-valued and unique indexes, full pages under capped native pages, atomic batches with a failure injected at every op, one winner among 32 concurrent writers, no lost increments, write-skew rejection, and over-limit writes rejected before sending.

### Patch Changes

- 23a972d: The admin `GET /version` also lists the plugins the server runs, as `plugins`: their ids, sorted, such as `["apiKeys", "insights"]`. A console reads it to show only the features those plugins serve. The client `/version` is unchanged, so apps never learn which plugins a server runs, and a server without `insights()` still answers the Insights routes with 204 and `x-hot-updater-insights: disabled`.
- d482b13: Auto-patch bases match what `deploy` chose before the storage engine. `core.findBaseBundleIds` reads the new bundle's Release Catalog scope in one point read and keeps every enabled bundle release whose target app version range intersects the new target (the same fingerprint, in a fingerprint scope), newest release first, each bundle once and older than the new bundle, up to `patch.maxBaseBundles`. Targets such as `1.x`, `*`, or `>=1.2.0 <2` get bases again, a `*` or `1.x` release serves every version it covers, a release on another patch version of the same minor line no longer takes a slot, and a promoted or republished bundle counts from its newest release.

  `targetBaseCandidateKey` takes the channel name instead of its id, and its key names the catalog scope and the normalized range. The `base_candidates` aggregate and its gauge writes are gone, so each release change writes up to 16 fewer rows; the checked-in D1, Postgres, and Supabase schemas drop the table.

- d482b13: Bundle child counts come from each base bundle's reference counter alone. `HotUpdaterCoreApi` gains `countBundleChildren(ids)`, which reads the bundle rows in one batch and no patches, and admin API protocol 2 gains `GET /bundles/child-counts?ids=...` (1 to 100 IDs) for a standalone server. The console's patch counts use it instead of reading each bundle with its own patches.
- d482b13: Core purges a CDN's copies of the update-check routes itself. After a committed transaction that writes a Release Catalog, it calls the database's `onCachedRoutesChange`, which `EngineDatabase` now carries. The storage engine's database wrapper no longer inspects table names, and `createEngineDatabase({ onCachedRoutesChange })` only hands the purge to core, so the CLI, the console, and the server purge after the same writes. A preview, a rerun attempt, or a write that changes no catalog purges nothing.

  The built-in database (`createEngineDatabase`, `builtInSchema`, `builtInSettings`, `migrateBuiltInSchema`) moves from the storage engine's directory to the `db` tooling next to it, since it binds core's and the built-in plugins' schemas; `@hot-updater/server/database` exports the same names.

- 94b56f3: Run DynamoDB on the new storage engine. `dynamoDB(config)` keeps its signature, and still invalidates the update-check routes' CloudFront copies after a write that changes what they answer.
  - **One table, no secondary index:** the plugin is the key-value helper over one table keyed by string `pk` and `sk`. Each row is an item. Each index a row belongs to adds an item holding a copy of it, written in the same transaction. Reads are strongly consistent, and a write is one `TransactWriteItems` with a client request token. Commits over 100 items, 4 MB, or 400 KB in one item are refused before anything is written.
  - **Schema settings:** the plugin checks the schema settings before its first read and answers 503 until they exist. `migrateDynamoDB(config)` writes them, and creates the table when it is missing. `hot-updater init` runs it after creating the table, the agent scaffold ships the same items as `dynamodb/schema-settings.json`, and the DynamoDB example runs it before registering its API key.
  - **Infrastructure:** `hot-updater init` creates the table without `hot-updater-update-index` and refuses a table that still has it, which a 1.0 release candidate created. The IAM policy allows the key-value store's reads and writes on each table's partitions, `<table>` and `<table>#*`.
  - **Insights shards:** gauge aggregates (`insights_distribution`, `insights_latest_by_bundle`) now spread over 32 shards, on every backend. DynamoDB's contention gate, on DynamoDB Local with 16 writers at 100 moves per second, retried 2–24% of rollout moves at 16 and 1–5% at 32; these are test figures, not production limits. Sketches stay at 16, since every read merges their 2 KB registers, and counters stay at 8. Rows already written on shards 0–15 keep counting.
  - **Removed:** the DynamoDB implementation (about 4,200 lines) and `DYNAMODB_UPDATE_INDEX_NAME`.

- d482b13: DynamoDB no longer reads the item at a range's exclusive upper bound. The key-value helper now gives each range an inclusive form of its upper bound that admits exactly the keys below it, and the DynamoDB store uses it for `BETWEEN`, so a two-sided range reads only rows it returns.
- aee193e: Rerun a transaction whose gauge would go below zero instead of failing it. Another writer can move a gauge after a transaction reads the row that decides its deltas. That transaction's guard on the row fails anyway, so the engine now reads both again. The error is thrown only when a gauge stays negative through every attempt.
- d7df92c: Run Firestore on the new storage engine. `firebaseDatabase(config)` keeps its signature and gains an optional `collection`.
  - **One collection:** every item is a `{ pk, sk, row }` document in `hot_updater_v1`, with a hashed document id. Each index a row belongs to adds a document holding a copy of it, written in the same transaction. Reads use two composite indexes, `pk` with `sk` ascending and descending, and `row` is exempt from single-field indexing. `firestore.indexes.json` is generated from the schema and holds just those.
  - **Transactions:** a write is one `runTransaction` that reads only the documents its ops guard. Counters increment without a read, so they hold no read lock: `update` needs the document, so a write whose counter row is missing reruns, reads it, and creates it from `init`. Maps and arrays are stored as JSON text, since Firestore has no nested arrays and does not keep map key order.
  - **Schema settings:** the plugin checks the schema settings before its first read and answers 503 until they exist. `migrateFirebaseDatabase(config)` writes them. `hot-updater init` runs it after deploying the indexes, and the agent scaffold's key script runs it through `api-key.config.ts`'s new `migrate` export. Init refuses a project whose `hot_updater_v1_*` collections hold data from a 1.0 release candidate.
  - **Init:** merging the project's index overrides with ours now replaces an override for the same field instead of merging the lists by position.
  - **Key lengths:** the key-value helper refuses a write whose partition or sort key is longer than the store indexes whole (DynamoDB 2,048 and 1,024 bytes, Firestore 1,500), as `too_large`, instead of failing in the store or truncating the index.
  - **Removed:** the Firestore implementation (about 2,100 lines), the adapter version marker, and the channel-id registry documents.

- d482b13: `POST /events` follows analytics ingestion practice.
  - **Unknown fields:** a report's fields the server does not know are ignored instead of refused with `400`, so a newer SDK's report still records on an older server. Known fields are checked as before, and a body over 16 KB still answers `413`.
  - **Idempotency key:** a report may carry `eventId`, a lowercase UUIDv7 the client creates once and repeats on every retry. The server stores the report under it, so a retry counts once, and a report under an ID already stored changes nothing, as analytics ingestion drops duplicates; any other `eventId` answers `400`, and a report without one gets a server-created ID as before.
  - **Back-pressure:** when a transaction runs out of retries (`DatabaseConflictError`) or the database throttles a read, the Insights routes answer `503` with `Retry-After: 5` instead of `500`. Other failures still answer `500`.

- d482b13: Insights event lists cover one time range, as other analytics products list raw events. The global and bundle lists take `[sinceMs, beforeReceivedAtMs)` of at most 90 × 24 hours; without `sinceMs` they list the 90 days before the cutoff, and a longer range answers 400. Pages run newest first and stop at the range start: only a full page returns a cursor, which carries the range and the page's last row. Each event also counts itself in a per-day row of `insights_outcomes` (platform `*`), so a list skips days without matching events: after an empty day, one outcome read (that row for the global list, the filter's own hourly rows for a bundle list) names the next day that holds one, and a gap of any length costs two reads. The Insights plugin's `listEvents` rejects a global or bundle range longer than 90 × 24 hours. The read-budget suite measures a dense day, a gap, and an empty range.
- d482b13: `countLatestEvents` counts an installation once when its latest event matches a `from` and a `to` bundle predicate of the same type, over whole hours as it already did over a partial hour. The Insights plugin sums one gauge per predicate, so a download from A to B counted by "from A" and "to B" was counted twice. Each installation's latest event now also keeps a gauge of its (from, to) pair, and the count subtracts the pairs its predicates share: one more gauge per latest event, read and written in the same batch as the others, and a count reads the pairs only when both fields are filtered. The published Insights model suite checks the case.
- d482b13: Say when a server drops Insights events.
  - **First dropped event:** a server without `insights()` still answers `POST /events` with 204 and `x-hot-updater-insights: disabled`, so apps need no change. It now logs one warning, on the first event it drops, naming `insights()` for the server and `insights: false` for apps that should stop reporting.
  - **Upgrade error:** the `HotUpdaterConfigError` for a release candidate's `clientAccess` object also names `insights()`, which the release candidates ran by default.

- d482b13: The Insights HTTP reads no longer read more than they return. Event and installation pages read `limit` rows and return a cursor only for a full page, so the last call may return an empty page. The overview counts whole hours that end with the current one, so it reads only the maintained hour and day rows and never raw events.
- d482b13: An Insights event writes one fewer index entry on every backend. `bundle_events.bundle_ref` now holds only the ref a bundle filter reads: `from:<bundle>` for `RECOVERED`, and `to:<bundle>` for the other types, so a movement event writes one `byBundle` entry instead of two. Events recorded before keep both refs, and no filter reads the extra one.
- d482b13: A standalone server's bundle count reads only the counter row. Admin API protocol 2 gains `GET /bundles/count` (`platform` optional), and `standaloneRepository` counts through it instead of listing one bundle, with its patches, to read `total`.
- a6c00ec: Run Supabase on the new storage engine. `supabaseDatabase({ supabaseUrl, supabaseServiceRoleKey })` keeps its signature.
  - **One RPC:** every read and write goes through `hot_updater_v1_apply(p_statements jsonb)`. It runs the SQL core's statements in the caller's transaction, so a write, sent as one batch, commits atomically. The engine's batch writes lock the rows their guards read on PostgreSQL, so no writer moves them before the batch commits.
  - **Security:** the function runs `SECURITY INVOKER` with a fixed `search_path`. `EXECUTE` is revoked from `PUBLIC`, `anon`, and `authenticated`, and granted to `service_role` only. It allows only the SQL core's statement shapes on Hot Updater's tables: one `SELECT`, `INSERT`, `UPDATE`, or `DELETE` each, with no literal, comment, semicolon, function call, or other word. Values never enter the SQL: each is read from one jsonb parameter, typed, as `($1->>k)::bigint`.
  - **Schema:** the single `20260818000000_hot-updater_1.0.0.sql` migration is now the generated shared SQL schema under the `hot_updater_v1_` prefix. It adds the write guard, row-level security on every table, the RPC, and the settings rows, last. The old commit, channel-deletion, and event RPCs and their follow-up migration are removed.
  - **Schema fence:** the adapter fences its schema. A project without the migration answers 503, including when PostgREST cannot find the RPC. `hot-updater init` reports an RC database from before the engine as incompatible.

- Updated dependencies [d482b13]
- Updated dependencies [d482b13]
- Updated dependencies [fe03f59]
- Updated dependencies [d482b13]
- Updated dependencies [2431c0a]
- Updated dependencies [ad00722]
- Updated dependencies [d482b13]
- Updated dependencies [d482b13]
- Updated dependencies [f6ffb68]
- Updated dependencies [c68e9f3]
- Updated dependencies [065c457]
- Updated dependencies [8a03eb2]
- Updated dependencies [aee193e]
- Updated dependencies [228b6c7]
- Updated dependencies [065c457]
- Updated dependencies [df31037]
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

- 39f60f9: Serialize Kysely database commits and retry native serialization conflicts so concurrent Release revision and Catalog generation expectations cannot both succeed with the same version.

  Replace Firebase row fields atomically instead of recursively merging JSON metadata, while preserving unrelated document extension fields.

  Apply Supabase migration `20260922000000_idempotent_channel_commit.sql` to existing generation 1 projects. It makes generic deletion of a missing Channel an atomic no-op, preserving table layouts, schema version, existing data, and RPC permissions.

- Updated dependencies [f5fffea]
- Updated dependencies [79c3eea]
  - @hot-updater/plugin-core@1.0.0-rc.15
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
  - @hot-updater/bsdiff@1.0.0-rc.14
  - @hot-updater/core@1.0.0-rc.14

## 1.0.0-rc.3

### Patch Changes

- 663d8e9: Finalize the unreleased v1 Insights contract with three event types: UPDATE_APPLIED, UNCHANGED, and RECOVERED. Same-file release selection reports UNCHANGED with null source bundle and update strategy while retaining release IDs. Remove RELEASE_ADOPTED from SDK payloads, server ingestion, database validators, and initial v1 schemas. No compatibility alias is accepted.

  Replace adopted outcomes and counters with unchanged in the Insights query API. Refresh all v1 SDK and infrastructure packages together; existing prerelease development databases require their obsolete event rows and constraints to be updated before using this contract.

- Updated dependencies [663d8e9]
  - @hot-updater/plugin-core@1.0.0-rc.3

## 1.0.0-rc.2

### Minor Changes

- e6d9ae7: Add Overview / Events navigation in Insights to browse event history without
  an installation search or bundle filter. Include all event types in newest-first
  order with cursor pagination, refresh, and links to installation history that
  preserve the source page and scroll position. Use readable local timestamps,
  copyable short identifiers, semantic event labels, and responsive mobile cards.
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

- a837c71: Upgrade verkit to 0.4.0 while preserving canonical app-version strings and
  Doctor's package-version compatibility checks with the new parsed SemVer
  return values. Upgrade the workspace build tool tsdown to 0.22.14.
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

- 467e5f6: Show when a Release cannot currently be selected first by any catalog segment
  or cohort, and surface batched 30-day Bundle movement in the Release list.
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

- ebe1f64: Add Analytics as a built-in `createHotUpdater` domain backed directly by the
  official `database.models.analytics` port. Event ingestion, bounded aggregation,
  installation search, HTTP routes, and Console views now live with the server;
  there is no Analytics plugin, provider override, universal component schema, or
  separate `@hot-updater/analytics` package.

  Runtime Analytics ingestion and query routes are always available. The former
  server-side `analytics` and `routes` options are removed.

  Database providers own the physical `bundle_events` table through the shared
  database contract and schema version.
  Event ingestion lives on `handlers.client`; queries live on
  `handlers.admin` and rely on the framework middleware protecting that mount.

  React Native clients can enable automatic OTA transition and Release adoption
  reporting by setting `analytics: true` in either `HotUpdater.init` or
  `HotUpdater.wrap`. Omitting the option or setting it to `false` sends no events.
  App-ready transitions retain stable installation and optional user identity
  across launches, and analytics delivery failures remain warning-only so they
  never block application startup.

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

- 3b367e7: Make `baseURL` the only React Native network source. Remove the `resolver` and
  client-side `authorityId` options, `HotUpdaterResolver`, its public
  parameter/result helper types, and `createDefaultResolver`. Custom GraphQL,
  RPC, and other backends must expose the v1 HTTP protocol through an adapter or
  proxy and pass that endpoint as `baseURL`.

  Report a one-time `console.error` when an app configures both `HotUpdater.init`
  and `HotUpdater.wrap`. Use `init + checkForUpdate` for custom or manual update
  flows, or use `wrap` for the automatic HOC flow; do not combine them.

  Remove authority from the public Release Catalog client paths. Catalog
  identity is managed automatically in persistence, while the
  client fetches `/release-catalogs/app-version/:platform/:channelKey/:appVersion`
  or `/release-catalogs/fingerprint/:platform/:channelKey/:fingerprintHash`.

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

- a9ffb2a: Remove leftover v0 aliases that are not field compatibility. `HotUpdater.wrap({ updateMode: "manual" })` throws, findMany accepts only `orderBy`, and Supabase plugins require `supabaseServiceRoleKey`. Managed init still detects leftover `supabaseAnonKey` so skipped v0 configs fail closed.
- a9ffb2a: Create schema 1.0.0 from empty databases only. `db migrate` and `db generate` no longer accept or upgrade v0 schema markers, and managed SQL templates are a single 1.0.0 CREATE.

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
  - @hot-updater/bsdiff@1.0.0-rc.0

## 0.36.0

### Patch Changes

- 9759e8a: Reduce S3 management query work by skipping legacy UUIDv7 artifact traversal, deriving channels from canonical manifest keys, and batching multi-bundle deletion scans and commits. Store new bundle artifacts below `bundles/<bundle-id>` while preserving legacy reads, and add exact target app version filters to the CLI and Console. Add an exclusive-maintenance `hot-updater storage prune` command for orphaned bundle objects and unreferenced shared assets, with an explicit `--dry-run` candidate table, a recent-object protection window, and fail-closed reference validation safeguards.
- Updated dependencies [9759e8a]
  - @hot-updater/plugin-core@0.36.0
  - @hot-updater/bsdiff@0.36.0
  - @hot-updater/core@0.36.0
  - @hot-updater/js@0.36.0

## 0.35.12

### Patch Changes

- 6e8b32e: Replace the semver dependency with verkit.
- Updated dependencies [6e8b32e]
  - @hot-updater/js@0.35.12
  - @hot-updater/plugin-core@0.35.12
  - @hot-updater/bsdiff@0.35.12
  - @hot-updater/core@0.35.12

## 0.35.11

### Patch Changes

- Updated dependencies [1a3a621]
  - @hot-updater/plugin-core@0.35.11
  - @hot-updater/bsdiff@0.35.11
  - @hot-updater/core@0.35.11
  - @hot-updater/js@0.35.11

## 0.35.10

### Patch Changes

- Updated dependencies [ce8d254]
  - @hot-updater/plugin-core@0.35.10
  - @hot-updater/bsdiff@0.35.10
  - @hot-updater/core@0.35.10
  - @hot-updater/js@0.35.10

## 0.35.9

### Patch Changes

- @hot-updater/bsdiff@0.35.9
- @hot-updater/core@0.35.9
- @hot-updater/js@0.35.9
- @hot-updater/plugin-core@0.35.9

## 0.35.8

### Patch Changes

- @hot-updater/bsdiff@0.35.8
- @hot-updater/core@0.35.8
- @hot-updater/js@0.35.8
- @hot-updater/plugin-core@0.35.8

## 0.35.7

### Patch Changes

- @hot-updater/bsdiff@0.35.7
- @hot-updater/core@0.35.7
- @hot-updater/js@0.35.7
- @hot-updater/plugin-core@0.35.7

## 0.35.6

### Patch Changes

- @hot-updater/bsdiff@0.35.6
- @hot-updater/core@0.35.6
- @hot-updater/js@0.35.6
- @hot-updater/plugin-core@0.35.6

## 0.35.5

### Patch Changes

- @hot-updater/bsdiff@0.35.5
- @hot-updater/core@0.35.5
- @hot-updater/js@0.35.5
- @hot-updater/plugin-core@0.35.5

## 0.35.4

### Patch Changes

- @hot-updater/bsdiff@0.35.4
- @hot-updater/core@0.35.4
- @hot-updater/js@0.35.4
- @hot-updater/plugin-core@0.35.4

## 0.35.3

### Patch Changes

- @hot-updater/bsdiff@0.35.3
- @hot-updater/core@0.35.3
- @hot-updater/js@0.35.3
- @hot-updater/plugin-core@0.35.3

## 0.35.2

### Patch Changes

- @hot-updater/bsdiff@0.35.2
- @hot-updater/core@0.35.2
- @hot-updater/js@0.35.2
- @hot-updater/plugin-core@0.35.2

## 0.35.1

### Patch Changes

- @hot-updater/bsdiff@0.35.1
- @hot-updater/core@0.35.1
- @hot-updater/js@0.35.1
- @hot-updater/plugin-core@0.35.1

## 0.35.0

### Minor Changes

- 4e1b86d: Make the `@hot-updater/server` root export runtime-safe, remove the ambiguous `@hot-updater/server/runtime` subpath, keep `@hot-updater/server/node` focused on `toNodeHandler`, and move database generation, migration, and bundle diff APIs to `@hot-updater/server/db`.

### Patch Changes

- @hot-updater/bsdiff@0.35.0
- @hot-updater/core@0.35.0
- @hot-updater/js@0.35.0
- @hot-updater/plugin-core@0.35.0

## 0.34.0

### Patch Changes

- 088f6c1: refactor(server): remove fumadb adapter split
- 7244b65: Fix standalone database generation for provider SQL output and generated schema regeneration, and centralize the generated DB schema artifact contract.
- Updated dependencies [088f6c1]
- Updated dependencies [7244b65]
  - @hot-updater/plugin-core@0.34.0
  - @hot-updater/core@0.34.0
  - @hot-updater/js@0.34.0
  - @hot-updater/bsdiff@0.34.0

## 0.33.2

### Patch Changes

- @hot-updater/bsdiff@0.33.2
- @hot-updater/core@0.33.2
- @hot-updater/js@0.33.2
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
  - @hot-updater/bsdiff@0.33.1
  - @hot-updater/core@0.33.1
  - @hot-updater/js@0.33.1

## 0.33.0

### Patch Changes

- e914f56: Avoid redundant provider bundle reads during update checks and teach doctor to flag server runtime redeploy requirements.
- Updated dependencies [e914f56]
  - @hot-updater/plugin-core@0.33.0
  - @hot-updater/bsdiff@0.33.0
  - @hot-updater/core@0.33.0
  - @hot-updater/js@0.33.0

## 0.32.0

### Minor Changes

- 499e139: Harden self-hosted bundle management and native bundle extraction.

  Bundle management routes are now disabled by default and require an
  explicit `routes.bundles: true` opt-in when enabled. Protect those routes with
  framework middleware or an equivalent reverse-proxy/auth layer. Bundle list
  requests also validate `limit` against a bounded range.

  Android and iOS bundle extraction now reject unsafe archive entries and
  manifest asset paths before writing or reusing files.

### Patch Changes

- 4e6d2ec: Use deterministic content-addressed storage keys for manifest assets, require storage plugins to implement object existence checks, skip uploads when the object already exists, limit deploy upload concurrency, stream hashing/compression work to reduce memory pressure, and report upload progress through 100%.
- Updated dependencies [4e6d2ec]
  - @hot-updater/plugin-core@0.32.0
  - @hot-updater/bsdiff@0.32.0
  - @hot-updater/core@0.32.0
  - @hot-updater/js@0.32.0

## 0.31.4

### Patch Changes

- @hot-updater/bsdiff@0.31.4
- @hot-updater/core@0.31.4
- @hot-updater/js@0.31.4
- @hot-updater/plugin-core@0.31.4

## 0.31.3

### Patch Changes

- @hot-updater/bsdiff@0.31.3
- @hot-updater/core@0.31.3
- @hot-updater/js@0.31.3
- @hot-updater/plugin-core@0.31.3

## 0.31.2

### Patch Changes

- @hot-updater/bsdiff@0.31.2
- @hot-updater/core@0.31.2
- @hot-updater/js@0.31.2
- @hot-updater/plugin-core@0.31.2

## 0.31.1

### Patch Changes

- @hot-updater/bsdiff@0.31.1
- @hot-updater/core@0.31.1
- @hot-updater/js@0.31.1
- @hot-updater/plugin-core@0.31.1

## 0.31.0

### Minor Changes

- 5b0a0f5: Add signed manifest-based diff update support across deploy, server, provider storage, console tooling, and React Native runtime.
- 5b0a0f5: Add Hermes bundle patch metadata and runtime BSDIFF patch application support.

### Patch Changes

- Updated dependencies [5b0a0f5]
- Updated dependencies [5b0a0f5]
  - @hot-updater/core@0.31.0
  - @hot-updater/js@0.31.0
  - @hot-updater/plugin-core@0.31.0
  - @hot-updater/bsdiff@0.31.0

## 0.30.12

### Patch Changes

- @hot-updater/core@0.30.12
- @hot-updater/js@0.30.12
- @hot-updater/plugin-core@0.30.12

## 0.30.11

### Patch Changes

- @hot-updater/core@0.30.11
- @hot-updater/js@0.30.11
- @hot-updater/plugin-core@0.30.11

## 0.30.10

### Patch Changes

- @hot-updater/core@0.30.10
- @hot-updater/js@0.30.10
- @hot-updater/plugin-core@0.30.10

## 0.30.9

### Patch Changes

- @hot-updater/core@0.30.9
- @hot-updater/js@0.30.9
- @hot-updater/plugin-core@0.30.9

## 0.30.8

### Patch Changes

- Updated dependencies [6019156]
  - @hot-updater/plugin-core@0.30.8
  - @hot-updater/core@0.30.8
  - @hot-updater/js@0.30.8

## 0.30.7

### Patch Changes

- @hot-updater/core@0.30.7
- @hot-updater/js@0.30.7
- @hot-updater/plugin-core@0.30.7

## 0.30.6

### Patch Changes

- @hot-updater/core@0.30.6
- @hot-updater/js@0.30.6
- @hot-updater/plugin-core@0.30.6

## 0.30.5

### Patch Changes

- @hot-updater/core@0.30.5
- @hot-updater/js@0.30.5
- @hot-updater/plugin-core@0.30.5

## 0.30.4

### Patch Changes

- @hot-updater/core@0.30.4
- @hot-updater/js@0.30.4
- @hot-updater/plugin-core@0.30.4

## 0.30.3

### Patch Changes

- @hot-updater/core@0.30.3
- @hot-updater/js@0.30.3
- @hot-updater/plugin-core@0.30.3

## 0.30.2

### Patch Changes

- @hot-updater/core@0.30.2
- @hot-updater/js@0.30.2
- @hot-updater/plugin-core@0.30.2

## 0.30.1

### Patch Changes

- @hot-updater/core@0.30.1
- @hot-updater/js@0.30.1
- @hot-updater/plugin-core@0.30.1

## 0.30.0

### Minor Changes

- 83c01c8: fix: keep target cohorts additive to rollout

### Patch Changes

- Updated dependencies [83c01c8]
  - @hot-updater/core@0.30.0
  - @hot-updater/js@0.30.0
  - @hot-updater/plugin-core@0.30.0

## 0.29.8

### Patch Changes

- @hot-updater/core@0.29.8
- @hot-updater/js@0.29.8
- @hot-updater/plugin-core@0.29.8

## 0.29.7

### Patch Changes

- @hot-updater/core@0.29.7
- @hot-updater/js@0.29.7
- @hot-updater/plugin-core@0.29.7

## 0.29.6

### Patch Changes

- @hot-updater/core@0.29.6
- @hot-updater/js@0.29.6
- @hot-updater/plugin-core@0.29.6

## 0.29.5

### Patch Changes

- 52208f4: perf: Fast-path lambda update checks through plugin-core
- Updated dependencies [52208f4]
  - @hot-updater/plugin-core@0.29.5
  - @hot-updater/core@0.29.5
  - @hot-updater/js@0.29.5

## 0.29.4

### Patch Changes

- @hot-updater/core@0.29.4
- @hot-updater/js@0.29.4
- @hot-updater/plugin-core@0.29.4

## 0.29.3

### Patch Changes

- d1ffb83: Stale data due to module-level singleton configPromise and shared changedMap across requests
- Updated dependencies [d1ffb83]
  - @hot-updater/plugin-core@0.29.3
  - @hot-updater/core@0.29.3
  - @hot-updater/js@0.29.3

## 0.29.2

### Patch Changes

- Updated dependencies [2a1bc80]
  - @hot-updater/core@0.29.2
  - @hot-updater/js@0.29.2
  - @hot-updater/plugin-core@0.29.2

## 0.29.1

### Patch Changes

- @hot-updater/core@0.29.1
- @hot-updater/js@0.29.1
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
  - @hot-updater/plugin-core@0.29.0
  - @hot-updater/core@0.29.0
  - @hot-updater/js@0.29.0

## 0.28.0

### Patch Changes

- @hot-updater/core@0.28.0
- @hot-updater/js@0.28.0
- @hot-updater/plugin-core@0.28.0

## 0.27.1

### Patch Changes

- @hot-updater/core@0.27.1
- @hot-updater/js@0.27.1
- @hot-updater/plugin-core@0.27.1

## 0.27.0

### Minor Changes

- 81f9437: feat(android): for safe reloading, Android reloads the process (#869)

### Patch Changes

- Updated dependencies [81f9437]
  - @hot-updater/core@0.27.0
  - @hot-updater/js@0.27.0
  - @hot-updater/plugin-core@0.27.0

## 0.26.2

### Patch Changes

- @hot-updater/core@0.26.2
- @hot-updater/js@0.26.2
- @hot-updater/plugin-core@0.26.2

## 0.26.1

### Patch Changes

- @hot-updater/core@0.26.1
- @hot-updater/js@0.26.1
- @hot-updater/plugin-core@0.26.1

## 0.26.0

### Patch Changes

- @hot-updater/core@0.26.0
- @hot-updater/js@0.26.0
- @hot-updater/plugin-core@0.26.0

## 0.25.14

### Patch Changes

- @hot-updater/core@0.25.14
- @hot-updater/js@0.25.14
- @hot-updater/plugin-core@0.25.14

## 0.25.13

### Patch Changes

- @hot-updater/core@0.25.13
- @hot-updater/js@0.25.13
- @hot-updater/plugin-core@0.25.13

## 0.25.12

### Patch Changes

- @hot-updater/core@0.25.12
- @hot-updater/js@0.25.12
- @hot-updater/plugin-core@0.25.12

## 0.25.11

### Patch Changes

- @hot-updater/core@0.25.11
- @hot-updater/js@0.25.11
- @hot-updater/plugin-core@0.25.11

## 0.25.10

### Patch Changes

- Updated dependencies [03c5adc]
  - @hot-updater/plugin-core@0.25.10
  - @hot-updater/core@0.25.10
  - @hot-updater/js@0.25.10

## 0.25.9

### Patch Changes

- Updated dependencies [6b22072]
  - @hot-updater/plugin-core@0.25.9
  - @hot-updater/core@0.25.9
  - @hot-updater/js@0.25.9

## 0.25.8

### Patch Changes

- @hot-updater/core@0.25.8
- @hot-updater/js@0.25.8
- @hot-updater/plugin-core@0.25.8

## 0.25.7

### Patch Changes

- @hot-updater/core@0.25.7
- @hot-updater/js@0.25.7
- @hot-updater/plugin-core@0.25.7

## 0.25.6

### Patch Changes

- @hot-updater/core@0.25.6
- @hot-updater/js@0.25.6
- @hot-updater/plugin-core@0.25.6

## 0.25.5

### Patch Changes

- @hot-updater/core@0.25.5
- @hot-updater/js@0.25.5
- @hot-updater/plugin-core@0.25.5

## 0.25.4

### Patch Changes

- @hot-updater/core@0.25.4
- @hot-updater/js@0.25.4
- @hot-updater/plugin-core@0.25.4

## 0.25.3

### Patch Changes

- @hot-updater/core@0.25.3
- @hot-updater/js@0.25.3
- @hot-updater/plugin-core@0.25.3

## 0.25.2

### Patch Changes

- @hot-updater/core@0.25.2
- @hot-updater/js@0.25.2
- @hot-updater/plugin-core@0.25.2

## 0.25.1

### Patch Changes

- @hot-updater/core@0.25.1
- @hot-updater/js@0.25.1
- @hot-updater/plugin-core@0.25.1

## 0.25.0

### Patch Changes

- @hot-updater/core@0.25.0
- @hot-updater/js@0.25.0
- @hot-updater/plugin-core@0.25.0

## 0.24.7

### Patch Changes

- 294e324: fix: update babel plugin path in documentation and plugin files
- Updated dependencies [294e324]
  - @hot-updater/core@0.24.7
  - @hot-updater/js@0.24.7
  - @hot-updater/plugin-core@0.24.7

## 0.24.6

### Patch Changes

- @hot-updater/core@0.24.6
- @hot-updater/js@0.24.6
- @hot-updater/plugin-core@0.24.6

## 0.24.5

### Patch Changes

- @hot-updater/core@0.24.5
- @hot-updater/js@0.24.5
- @hot-updater/plugin-core@0.24.5

## 0.24.4

### Patch Changes

- Updated dependencies [7ed539f]
  - @hot-updater/plugin-core@0.24.4
  - @hot-updater/core@0.24.4
  - @hot-updater/js@0.24.4

## 0.24.3

### Patch Changes

- @hot-updater/core@0.24.3
- @hot-updater/js@0.24.3
- @hot-updater/plugin-core@0.24.3

## 0.24.2

### Patch Changes

- @hot-updater/core@0.24.2
- @hot-updater/js@0.24.2
- @hot-updater/plugin-core@0.24.2

## 0.24.1

### Patch Changes

- @hot-updater/core@0.24.1
- @hot-updater/js@0.24.1
- @hot-updater/plugin-core@0.24.1

## 0.24.0

### Patch Changes

- @hot-updater/core@0.24.0
- @hot-updater/js@0.24.0
- @hot-updater/plugin-core@0.24.0

## 0.23.1

### Patch Changes

- @hot-updater/core@0.23.1
- @hot-updater/js@0.23.1
- @hot-updater/plugin-core@0.23.1

## 0.23.0

### Patch Changes

- Updated dependencies [e41fb6b]
  - @hot-updater/core@0.23.0
  - @hot-updater/js@0.23.0
  - @hot-updater/plugin-core@0.23.0

## 0.22.2

### Patch Changes

- @hot-updater/core@0.22.2
- @hot-updater/js@0.22.2
- @hot-updater/plugin-core@0.22.2

## 0.22.1

### Patch Changes

- @hot-updater/core@0.22.1
- @hot-updater/js@0.22.1
- @hot-updater/plugin-core@0.22.1

## 0.22.0

### Minor Changes

- 32ad614: feat(server): integrate endpoint `/bundles/*` => `/api/bundles/*`

### Patch Changes

- @hot-updater/core@0.22.0
- @hot-updater/js@0.22.0
- @hot-updater/plugin-core@0.22.0

## 0.21.15

### Patch Changes

- a169f06: unique constraint violations
  - @hot-updater/js@0.21.15
  - @hot-updater/plugin-core@0.21.15
  - @hot-updater/core@0.21.15

## 0.21.14

### Patch Changes

- @hot-updater/core@0.21.14
- @hot-updater/js@0.21.14
- @hot-updater/plugin-core@0.21.14

## 0.21.13

### Patch Changes

- @hot-updater/core@0.21.13
- @hot-updater/js@0.21.13
- @hot-updater/plugin-core@0.21.13

## 0.21.12

### Patch Changes

- 56e849b: chore(server): storagePlugins to storages
- Updated dependencies [5c4b98e]
  - @hot-updater/plugin-core@0.21.12
  - @hot-updater/core@0.21.12
  - @hot-updater/js@0.21.12

## 0.21.11

### Patch Changes

- 7ee2830: fix(prisma): remove redundant isNotNull checks causing Prisma validat…
- e2b67d7: fix(cli-tools): esm only package bundle
- 2905e47: feat(server): supports hot-updater database plugin style
- Updated dependencies [e2b67d7]
  - @hot-updater/core@0.21.11
  - @hot-updater/js@0.21.11
  - @hot-updater/plugin-core@0.21.11

## 0.21.10

### Patch Changes

- 5289b17: only include valid where clauses during building /bundles orm command
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

- 2b408f2: docs: revamp hot-updater.dev
- Updated dependencies [2b408f2]
  - @hot-updater/plugin-core@0.21.7
  - @hot-updater/core@0.21.7

## 0.21.6

### Patch Changes

- b12394d: feat(cli): create migration sql hot-updater generate-db
- d4c23bc: fix(server): id column uuid
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

- 036f8f0: feat: support `@hot-updater/server` for self-hosted (WIP)

### Patch Changes

- Updated dependencies [610b2dd]
- Updated dependencies [afb084b]
- Updated dependencies [036f8f0]
  - @hot-updater/plugin-core@0.22.0
  - @hot-updater/core@0.22.0
