# @hot-updater/console

## 1.0.0-rc.21

### Minor Changes

- ab04e15: `defineConsoleConfig({ database, storage, plugins, console: { gitUrl } })` keeps rc.20's shape, except that `console` takes only `gitUrl`. `console.port` is gone from `console.config.ts`: the console never read it, and its host sets the port. `hot-updater console` still reads `console.port` in `hot-updater.config.ts`. List the server plugins your server runs in `plugins`, such as the `plugins` a managed provider package exports or `[insights(), apiKeys()]`: the console shows only the built-in features of the plugins listed.
  - The console runs `createHotUpdater` over `database`, `storage`, and `plugins`, as the server does, and writes through its core: a listed plugin whose migration has not run stops a request with an error that names the fix, and writes on SQL databases delete the plugins' expired rows.
  - With `database: standaloneRepository(...)`, the console takes the features it shows from `plugins` instead of the server's admin `/version`, and reads Insights through the admin API.
  - The hosted console's Vite plugin reads `console.config.ts` by default, in place of `hot-updater.config.ts`. `hot-updater console` reads the database, storage, and plugins in `hot-updater.config.ts`.

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

### Patch Changes

- c9cfed7: Every package now shares one release candidate version: `hot-updater` and every `@hot-updater/*` package move to the same version, so an app, its server, and the console can pin one version.
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

- d500c97: The Console builds on TanStack Start 1.168.60, with TanStack Router, Router SSR Query, and TanStack Query updated to match. Vercel refuses to deploy TanStack Start 1.168.25 as vulnerable to XSS. The scroll-restoration helper reads the matched route from the router's tuple result.
- 73f809e: `@hot-updater/server` and `@hot-updater/console` are now licensed under the MIT License with a hosted service attribution condition. A service that offers either of them, or a service built on them, to other people for updating their own apps must show "Powered by hot-updater" with a link where its users can see it. Running them for your own apps, or for apps you build for clients, needs no notice. The Console's sidebar now shows "Powered by hot-updater", and keeping it satisfies the condition. Every other package stays under the MIT License, and versions released before this one keep their MIT License.
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
  - @hot-updater/bsdiff@1.0.0-rc.21
  - @hot-updater/cli-tools@1.0.0-rc.21
  - @hot-updater/protocol@1.0.0-rc.21
  - @hot-updater/plugin-core@1.0.0-rc.21
  - @hot-updater/server@1.0.0-rc.21

## 1.0.0-rc.20

### Patch Changes

- 1ddd5fc: Insights counts launches as daily active installations. Release health shows **Active installations** and **Active days** and charts daily active installations, and each bundle's summary shows **Active days** instead of known launches. The App usage distribution names the UTC day it starts on, since latest reports are counted by UTC day, and **All events** says that launches without an update are not listed.
- 9a6715f: Each console feature registers what serves it and what it shows: its server API, over the plugin's API or a self-hosted server's admin API, its navigation item, and the columns and sections it adds to the Bundles page and the release editor. Release activity is one of these, shown only where the console reads it, as before. The page for a feature that a self-hosted server's admin API does not serve says so without naming Insights.
- a084eda: When a self-hosted server answers an Insights read with `404`, `/retention` included, the console shows that the server runs without `insights()`. An installation the server has no reports from still shows as not found.
- 530cca5: App usage adds a **12m** period, **YAU**, that counts 52 weeks of whole UTC days from the daily totals. The console reads how long the server keeps Insights data, from a self-hosted server's admin API too, with the defaults for a server that does not report it: event lists offer ranges within the raw period, **12m** shows where daily totals cover it, and event lists, installation history, and App usage say how long data is kept.
- 959ba94: Validate server function input with `validator()` instead of the deprecated `inputValidator()`, so building the console no longer prints a deprecation warning for each function. `@tanstack/react-start` now needs 1.168.25 or later, the first release with `validator()`.
- b317d49: Insights adds **Update failures** under Release health, for its channel, platform, Release ID, and period: failed updates and the failure rate of update attempts, failed installations, the patch fallback rate, a channel's failed checks and their rate against its active installations, failures by stage and reason with their HTTP statuses, origin codes, transports, and resources, and recoveries by exit reason. The bundle detail shows **Download failures** since the release's first report, with their rate, including through `standaloneRepository`. Event lists and installation history show update failures with their stage and reason, how a download arrived, and why a crashed process exited. Installations show their user ID only.
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

## 1.0.0-rc.19

### Patch Changes

- 038c804: Check console access before a server function reads its input, so a signed-out request gets 401 instead of a validation error. One request asks the auth adapter once.
- 038c804: A signed-out visit to Insights, Distribution, Installations, or API keys renders the sign-in page instead of failing the server render. The feature guard no longer keeps its refused read in the query cache, whose 401 Response the render could not serialize.
- Updated dependencies [038c804]
  - @hot-updater/server@1.0.0-rc.17

## 1.0.0-rc.18

### Minor Changes

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

### Patch Changes

- d482b13: Bundle child counts come from each base bundle's reference counter alone. `HotUpdaterCoreApi` gains `countBundleChildren(ids)`, which reads the bundle rows in one batch and no patches, and admin API protocol 2 gains `GET /bundles/child-counts?ids=...` (1 to 100 IDs) for a standalone server. The console's patch counts use it instead of reading each bundle with its own patches.
- d482b13: The All events list reads one time range, newest first: the last 24 hours, 7 days (the default), 30 days, or 90 days, ending when the list loads or the range changes. Changing the range returns to the first page, and the URL keeps it. Pages stop at the range start: a range without events, and its last page, say so and offer the next longer range. An empty page after a full one says there are no older events, in All events and in installation history.
- d482b13: Insights shows unique counts as estimates and reads one period end. DAU, WAU, MAU, the active users per interval, and a release's unique users come from HyperLogLog sketches, so they show as "≈ 1,234" with an Estimated label for hover and screen readers; zero stays exact. App usage and release health now end with the current UTC hour, as the reporting overview does, so a report counts as soon as the server records it instead of after the hour ends.
- d482b13: The console's Insights on/off check for a self-hosted server asks for one event of the last hour, so it reads at most two days instead of walking up to 90 empty ones.
- 23a972d: The console shows only the features whose plugins the server runs.
  - **Navigation:** Insights appears when the server runs `insights()`, and API keys when it runs `apiKeys()`. A feature's page opened without its plugin names the plugin to add and links to the console deployment guide.
  - **Bundles:** the list's Insights column and the bundle detail's Insights card appear only where the console reads release activity, instead of a "—" or a note.
  - **`standaloneRepository`:** the console reads the server's plugins once, from its admin `/version`, instead of asking the Insights events route. When the server runs `insights()`, Insights opens on All events with its events and installations; usage, bundle activity, and API keys need the database config. A server on an older `@hot-updater/server` lists no plugins on `/version`, so its console shows neither Insights nor API keys until the server is upgraded.
  - **Server functions:** every Insights and API key server function checks its feature first, and refuses one the console does not serve with the same not-found error.

- 228b6c7: Remove the legacy database contract. Every database runs on the storage engine, and core, its plugins, and the admin API are the only way to its data. Release candidate databases are recreated, not converted.
  - **Databases:** a provider returns an `EngineDatabase`, `{ name, adapter, dispose? }`, with `provider`, `createMigrator`, and `generateSchema` for `hot-updater db` where it has them. `createEngineDatabase({ name, adapter })` from `@hot-updater/server/database` puts the adapter behind the schema fence with the built-in settings; `builtInSchema`, `builtInSettings`, and `migrateBuiltInSchema` are the built-in tables, their settings rows, and their migration. `DatabasePlugin`, `createDatabasePlugin`, `createDatabaseClient`, the model and commit types, `commitReleaseCatalogMutation(s)`, and `BundleRepository` are gone.
  - **`createHotUpdater`:** takes `{ database, storage?, plugins?, clientAccess? }`; `plugins` defaults to none. `clientAccess` is `"public"`, or absent when a plugin provides clientAuth. A `clientAccess` object is a type error whose message names `apiKeys()`, and at startup a `HotUpdaterConfigError` that names it too. The instance is `{ handlers, core, api, adapterName }`: bundle, channel, release, Insights, and API key methods on it are gone; use `core` and the plugins' `api`. `registerApiKey`, `createApiKey`, `provisionApiKey`, and `createHandlers` are no longer exported; the `apiKeys()` plugin's API does the same work.
  - **Handlers:** client routes read catalogs and artifacts through core. The admin API speaks protocol 2 only: `v=2` is accepted and changes nothing, and `POST /database/commit`, `POST /bundles`, and `DELETE /bundles/:id` are gone (deploy with `POST /releases`, delete with `POST /bundles/delete`). `PATCH /bundles/:id` answers 204. The Insights routes come from `insights()`; without it they answer 204 with `x-hot-updater-insights: disabled`.
  - **Schema:** generated SQL, Drizzle, and Prisma schemas have no database foreign keys; the engine keeps references. CockroachDB and SQL Server are no longer supported, and `relationMode` is gone. The checked-in Postgres and Supabase SQL is regenerated.
  - **Providers:** `postgres`, `d1Database`, `supabaseDatabase`, `firebaseDatabase`, and `dynamoDB` return engine databases. `dynamoDB` invalidates the cached update-check routes after a write that changes a Release Catalog.
  - **`standaloneRepository`:** is `{ name, core, fetchAdmin }` over admin API protocol 2; its protocol 1 reads and custom bundle `routes` are gone.
  - **`@hot-updater/test-utils`:** `setupDatabaseTestSuite` runs core, bundles, the Release Catalog contract, and Insights through admin API protocol 2 over HTTP, and with `createInsightsModel` the Insights report contract. It replaces `setupDatabasePluginTestSuite` and `setupDatabaseClientTestSuite`. `setupBundleMethodsTestSuite` and `setupReleaseCatalogTestSuite` take `{ getClient }` on protocol 2.
  - **CLI and console:** they read and write through core only. `hot-updater api-key` manages keys through the config's `apiKeys()` plugin, and the console runs the config's `plugins`: without them, Insights and API keys are off.

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

## 1.0.0-rc.17

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
- Updated dependencies [d99530b]
- Updated dependencies [39f60f9]
  - @hot-updater/plugin-core@1.0.0-rc.15
  - @hot-updater/server@1.0.0-rc.15
  - @hot-updater/cli-tools@1.0.0-rc.15
  - @hot-updater/core@1.0.0-rc.15

## 1.0.0-rc.16

### Patch Changes

- 3fa24fc: Remove the Bundle Signing page and its inspection API from local and hosted
  Consoles. Console configuration no longer includes signing settings; signing
  and key management remain in the Hot Updater CLI and signing providers.

## 1.0.0-rc.15

### Patch Changes

- 7f3ba17: Distinguish downloaded update events from no-change events with the primary badge style.

## 1.0.0-rc.14

### Minor Changes

- 479c1e5: Report completed bundle downloads separately from applied updates. Persist the running bundle and pending selection, show Downloaded as waiting to apply, and keep Active, Downloaded, and Recovered totals visible above the activity chart tabs. Defer automatic No change reports until the update check finishes. Keep the unreleased 1.0.0 schema in its existing single initialization migration.

### Patch Changes

- Align all Hot Updater packages on 1.0.0-rc.14 for a coordinated release candidate. Future releases continue to use independent package versions.
- b23db5e: Replace shared Insights installation storage with canonical events and provider-private indexes for current installation queries. SQL and MongoDB keep nine access fields and fetch full event payloads only for selected results; DynamoDB counts compact scope entries. Custom providers implement `recordEvent({ event })`, `findLatestEvents`, and explicit `countLatestEvents` predicates without lifecycle helpers. Move ancillary event fields into typed `metadata`, reusing Bundle JSON conventions, while preserving SDK requests and Console responses.

  This changes the unreleased 1.0.0 initialization and custom database contract from the previous installation-row design. The read-cost fix preserves the canonical-event contract and keeps current-state queries independent of retained event history. Append and index updates are atomic; measured read/write costs are documented.

- Updated dependencies [479c1e5]
- Updated dependencies
- Updated dependencies [b23db5e]
  - @hot-updater/server@1.0.0-rc.14
  - @hot-updater/plugin-core@1.0.0-rc.14
  - @hot-updater/bsdiff@1.0.0-rc.14
  - @hot-updater/cli-tools@1.0.0-rc.14
  - @hot-updater/core@1.0.0-rc.14

## 1.0.0-rc.11

### Patch Changes

- 1e42b0b: Preserve Insights pagination history across browser reloads so page numbers and Previous buttons stay correct for events, installation searches, and installation history.

## 1.0.0-rc.10

### Patch Changes

- 21520c7: Fix mobile Safari sidebar rendering by using the shared shadcn Sheet, with accessible dismissal and automatic closing when a navigation link is selected.

## 1.0.0-rc.9

### Patch Changes

- 3385448: Send JSON sign-out requests so hosted authentication handlers accept logout from the sidebar and access-denied screen.

## 1.0.0-rc.8

### Patch Changes

- 6108b6d: Align the App usage and Distribution card heights in the Insights desktop layout and keep the distribution action at the bottom.
- f9686ed: Expose sign out in the sidebar for authenticated hosted consoles.

## 1.0.0-rc.7

### Patch Changes

- 24653fd: Add app usage trends and app-version/platform distributions to Insights. Share platform, channel, and app-version filters across usage and bundle activity, with independent reporting periods and a single DAU, WAU, or MAU metric for the App usage period. Add distribution drill-downs with per-version bundle usage, 20-row pagination, and preserved filter context. Reuse the existing reporting events and database plugin contract.
- 8a331bf: Label the Insights 30-day reporting installation count as MAU, with its installation-based definition available from an info tooltip on hover, keyboard focus, or tap. Replace the channel text field with a searchable shadcn combobox. Keep the existing platform/channel scope and rolling 30-day calculation.

## 1.0.0-rc.6

### Patch Changes

- 663d8e9: Refine Insights with a compact platform and channel toolbar, standard shadcn period tabs, and underlined Active/Rollback tabs. Give the activity chart more space and move All events into its footer. Correct card header alignment and remove the custom high-contrast button styles.

  Show three event outcomes with visible descriptions: Update applied, No change, and Rolled back. Treat release adoption that reuses the same files as No change, and show its current files once instead of an unchanged From/To pair.

  Use a 24-hour, hourly activity chart in Bundle Detail while preserving the 30-day activity summaries in the Bundles list.

- Updated dependencies [663d8e9]
  - @hot-updater/server@1.0.0-rc.3
  - @hot-updater/plugin-core@1.0.0-rc.3
  - @hot-updater/cli-tools@1.0.0-rc.3

## 1.0.0-rc.5

### Patch Changes

- 5c8972c: Display observed Active points in the compact bundle chart even when reports exist in only one time interval.
- c3f7896: Default Insights to hourly activity over 24 hours and make selected platform, reporting period, and activity filters clear in both themes. Make All events navigation visible and show 20 reports per page. Keep Bundles summaries and Bundle Detail on 30 days.

  Show a 30-day reporting device count above the graph using the existing installation count query.

## 1.0.0-rc.4

### Patch Changes

- 8afd7a8: Restore compact bundle activity summaries and compare all observed bundle IDs over 30 days with Active and Rollback trends.

## 1.0.0-rc.3

### Patch Changes

- 1067058: Show deployment adoption crossovers and recovery-rate spikes in Insights, with shared ID and interval selection, rollout markers, and links to delivery settings.

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

- 483483e: Close the bundle editor after saving changes and refreshing the release table,
  while preserving the open editor and draft when saving fails.
- a837c71: Upgrade verkit to 0.4.0 while preserving canonical app-version strings and
  Doctor's package-version compatibility checks with the new parsed SemVer
  return values. Upgrade the workspace build tool tsdown to 0.22.14.
- f48521a: Align the console ID, `HotUpdater.getBundleId()`, update-check results, completion callbacks, and `bundle list/show` with the selected update identity so promotions sharing an artifact remain distinguishable. The getter can reflect a staged update before reload. Remove the prerelease `getReleaseId()` getter, keep artifact and crash identities unchanged, and move Artifact IDs into Advanced diagnostics. `bundle list --json` returns the internal rows, and `bundle show` accepts the console ID. Use `HotUpdater.getManifest().bundleId` for BugSnag sourcemap matching.
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

- 8145d48: Separate bundle signer identity from the native trust anchor. Signing providers
  now expose public identity only through `getPublicKey()`, while Expo reads its
  public trust-anchor file exclusively from the app config plugin and includes it
  in native fingerprints. Add public-key materialization for Expo and validate
  Expo CNG trust anchors during deploy and doctor without loading signing
  credentials during prebuild.
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

- 353e1ca: Package the full Console application behind root and `/vite` exports so a thin
  Vite and Nitro host can deploy it with injected runtime configuration and
  authentication. Keep the CLI console unauthenticated but force it to bind to
  the loopback interface.
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

### Patch Changes

- 467e5f6: Show when a Release cannot currently be selected first by any catalog segment
  or cohort, and surface batched 30-day Bundle movement in the Release list.
- c355c26: Extend Bundle Signing with plugins for a generic remote signing endpoint, AWS
  KMS, and Google Cloud KMS while preserving v0 local `enabled`/`privateKeyPath`
  configuration. Local `publicKeyPath` is optional; signing plugins require it.
  Support public-key-only native/Expo builds and sanitized read-only Console
  inspection. Local PEM is the standard baseline, while AWS KMS and Google Cloud
  KMS provide hardened, non-exportable key custody through optional SDK peers.

  Require RSA keys of at least 2048 bits, validate explicit public-key pins and
  native key matches before deployment, and verify signatures before upload.
  Prevent key generation from overwriting existing files and default to
  cancelling replacement of a different or invalid embedded public key. Existing
  v0 CLI-generated keys meet the key requirements; signing-key changes still
  require a native-first rollout.

- 86f610b: Restore the compact main Console layout and patch-lineage expansion for the
  Bundles table. Keep the Bundle detail form familiar while preserving Release
  analytics and an always-available cohort preview.
- Updated dependencies [3b367e7]
- Updated dependencies [467e5f6]
- Updated dependencies [b424d47]
- Updated dependencies [3b367e7]
- Updated dependencies [9650748]
- Updated dependencies [88c163a]
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
  - @hot-updater/core@1.0.0-rc.0
  - @hot-updater/bsdiff@1.0.0-rc.0

## Unreleased

### Minor Changes

- Add a bundle analytics summary, runtime-backed installation search/history,
  and a dedicated Console installations route for last-known bundle evidence.

## 0.36.0

### Patch Changes

- 9759e8a: Reduce S3 management query work by skipping legacy UUIDv7 artifact traversal, deriving channels from canonical manifest keys, and batching multi-bundle deletion scans and commits. Store new bundle artifacts below `bundles/<bundle-id>` while preserving legacy reads, and add exact target app version filters to the CLI and Console. Add an exclusive-maintenance `hot-updater storage prune` command for orphaned bundle objects and unreferenced shared assets, with an explicit `--dry-run` candidate table, a recent-object protection window, and fail-closed reference validation safeguards.
- Updated dependencies [9759e8a]
  - @hot-updater/server@0.36.0
  - @hot-updater/bsdiff@0.36.0

## 0.35.12

### Patch Changes

- 6e8b32e: Replace the semver dependency with verkit.
- Updated dependencies [6e8b32e]
  - @hot-updater/server@0.35.12
  - @hot-updater/bsdiff@0.35.12

## 0.35.11

### Patch Changes

- @hot-updater/server@0.35.11
- @hot-updater/bsdiff@0.35.11

## 0.35.10

### Patch Changes

- @hot-updater/server@0.35.10
- @hot-updater/bsdiff@0.35.10

## 0.35.9

### Patch Changes

- @hot-updater/bsdiff@0.35.9
- @hot-updater/server@0.35.9

## 0.35.8

### Patch Changes

- @hot-updater/bsdiff@0.35.8
- @hot-updater/server@0.35.8

## 0.35.7

### Patch Changes

- @hot-updater/bsdiff@0.35.7
- @hot-updater/server@0.35.7

## 0.35.6

### Patch Changes

- @hot-updater/bsdiff@0.35.6
- @hot-updater/server@0.35.6

## 0.35.5

### Patch Changes

- @hot-updater/bsdiff@0.35.5
- @hot-updater/server@0.35.5

## 0.35.4

### Patch Changes

- @hot-updater/bsdiff@0.35.4
- @hot-updater/server@0.35.4

## 0.35.3

### Patch Changes

- @hot-updater/bsdiff@0.35.3
- @hot-updater/server@0.35.3

## 0.35.2

### Patch Changes

- @hot-updater/bsdiff@0.35.2
- @hot-updater/server@0.35.2

## 0.35.1

### Patch Changes

- @hot-updater/bsdiff@0.35.1
- @hot-updater/server@0.35.1

## 0.35.0

### Patch Changes

- Updated dependencies [4e1b86d]
  - @hot-updater/server@0.35.0
  - @hot-updater/bsdiff@0.35.0

## 0.34.0

### Patch Changes

- Updated dependencies [088f6c1]
- Updated dependencies [7244b65]
  - @hot-updater/server@0.34.0
  - @hot-updater/bsdiff@0.34.0

## 0.33.2

### Patch Changes

- @hot-updater/bsdiff@0.33.2
- @hot-updater/server@0.33.2

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
  - @hot-updater/server@0.33.1
  - @hot-updater/bsdiff@0.33.1

## 0.33.0

### Patch Changes

- 2b9944a: Add batch bundle deletion to the console bundle table and keep table scrolling within the table area.
- Updated dependencies [e914f56]
  - @hot-updater/server@0.33.0
  - @hot-updater/bsdiff@0.33.0

## 0.32.0

### Patch Changes

- 4e6d2ec: Use deterministic content-addressed storage keys for manifest assets, require storage plugins to implement object existence checks, skip uploads when the object already exists, limit deploy upload concurrency, stream hashing/compression work to reduce memory pressure, and report upload progress through 100%.
- Updated dependencies [4e6d2ec]
- Updated dependencies [499e139]
  - @hot-updater/server@0.32.0
  - @hot-updater/bsdiff@0.32.0

## 0.31.4

### Patch Changes

- @hot-updater/bsdiff@0.31.4
- @hot-updater/server@0.31.4

## 0.31.3

### Patch Changes

- @hot-updater/bsdiff@0.31.3
- @hot-updater/server@0.31.3

## 0.31.2

### Patch Changes

- @hot-updater/bsdiff@0.31.2
- @hot-updater/server@0.31.2

## 0.31.1

### Patch Changes

- @hot-updater/bsdiff@0.31.1
- @hot-updater/server@0.31.1

## 0.31.0

### Minor Changes

- 5b0a0f5: Add signed manifest-based diff update support across deploy, server, provider storage, console tooling, and React Native runtime.

### Patch Changes

- Updated dependencies [5b0a0f5]
- Updated dependencies [5b0a0f5]
  - @hot-updater/server@0.31.0
  - @hot-updater/bsdiff@0.31.0

## 0.30.12

### Patch Changes

- @hot-updater/cli-tools@0.30.12

## 0.30.11

### Patch Changes

- @hot-updater/cli-tools@0.30.11

## 0.30.10

### Patch Changes

- @hot-updater/cli-tools@0.30.10

## 0.30.9

### Patch Changes

- @hot-updater/cli-tools@0.30.9

## 0.30.8

### Patch Changes

- 6019156: refactor(cli-tools): extract `promoteBundle` from `@hot-updater/console` so it can be reused by the CLI

  `promoteBundle` and `createCopiedBundleArchive` move from `@hot-updater/console`'s server-only `lib/server/promoteBundle.ts` into `@hot-updater/cli-tools`. The console's RPC handler now imports from `@hot-updater/cli-tools`. UUIDv7 helpers (`createUUIDv7`, `extractTimestampFromUUIDv7`, `createUUIDv7WithSameTimestamp`) move to `@hot-updater/plugin-core` since they are generic primitives, not console-specific.

  Pure refactor — no behavior change. Existing test coverage moves with the function. This unblocks an upcoming `hot-updater promote` CLI command that calls the same implementation as the console UI.

- Updated dependencies [6019156]
  - @hot-updater/cli-tools@0.30.8

## 0.30.7

### Patch Changes

- Updated dependencies [03fd179]
  - @hot-updater/cli-tools@0.30.7

## 0.30.6

### Patch Changes

- @hot-updater/cli-tools@0.30.6

## 0.30.5

### Patch Changes

- @hot-updater/cli-tools@0.30.5

## 0.30.4

### Patch Changes

- @hot-updater/cli-tools@0.30.4

## 0.30.3

### Patch Changes

- @hot-updater/cli-tools@0.30.3

## 0.30.2

### Patch Changes

- @hot-updater/cli-tools@0.30.2

## 0.30.1

### Patch Changes

- 35b8720: feat(console): slider with keyboard input
  - @hot-updater/cli-tools@0.30.1

## 0.30.0

### Minor Changes

- 83c01c8: fix: keep target cohorts additive to rollout

### Patch Changes

- Updated dependencies [83c01c8]
  - @hot-updater/cli-tools@0.30.0

## 0.29.8

### Patch Changes

- 28e14aa: guard pending bundle dialogs in console
  - @hot-updater/cli-tools@0.29.8

## 0.29.7

### Patch Changes

- @hot-updater/cli-tools@0.29.7

## 0.29.6

### Patch Changes

- Updated dependencies [80cce61]
  - @hot-updater/cli-tools@0.29.6

## 0.29.5

### Patch Changes

- @hot-updater/cli-tools@0.29.5

## 0.29.4

### Patch Changes

- @hot-updater/cli-tools@0.29.4

## 0.29.3

### Patch Changes

- d1ffb83: Stale data due to module-level singleton configPromise and shared changedMap across requests
  - @hot-updater/cli-tools@0.29.3

## 0.29.2

### Patch Changes

- Updated dependencies [2a1bc80]
  - @hot-updater/cli-tools@0.29.2

## 0.29.1

### Patch Changes

- @hot-updater/cli-tools@0.29.1

## 0.29.0

### Minor Changes

- a935992: feat: Rollout feature with control from 1% to 100%

### Patch Changes

- d0fe908: fix(console): rebuild copied bundles with fresh uuidv7 ids
- Updated dependencies [a935992]
- Updated dependencies [d0fe908]
  - @hot-updater/cli-tools@0.29.0

## 0.28.0

### Patch Changes

- @hot-updater/cli-tools@0.28.0
- @hot-updater/core@0.28.0
- @hot-updater/plugin-core@0.28.0

## 0.27.1

### Patch Changes

- @hot-updater/cli-tools@0.27.1
- @hot-updater/core@0.27.1
- @hot-updater/plugin-core@0.27.1

## 0.27.0

### Minor Changes

- 81f9437: feat(android): for safe reloading, Android reloads the process (#869)

### Patch Changes

- Updated dependencies [81f9437]
  - @hot-updater/cli-tools@0.27.0
  - @hot-updater/core@0.27.0
  - @hot-updater/plugin-core@0.27.0

## 0.26.2

### Patch Changes

- @hot-updater/cli-tools@0.26.2
- @hot-updater/core@0.26.2
- @hot-updater/plugin-core@0.26.2

## 0.26.1

### Patch Changes

- @hot-updater/cli-tools@0.26.1
- @hot-updater/core@0.26.1
- @hot-updater/plugin-core@0.26.1

## 0.26.0

### Patch Changes

- @hot-updater/cli-tools@0.26.0
- @hot-updater/core@0.26.0
- @hot-updater/plugin-core@0.26.0

## 0.25.14

### Patch Changes

- @hot-updater/cli-tools@0.25.14
- @hot-updater/core@0.25.14
- @hot-updater/plugin-core@0.25.14

## 0.25.13

### Patch Changes

- @hot-updater/cli-tools@0.25.13
- @hot-updater/core@0.25.13
- @hot-updater/plugin-core@0.25.13

## 0.25.12

### Patch Changes

- @hot-updater/cli-tools@0.25.12
- @hot-updater/core@0.25.12
- @hot-updater/plugin-core@0.25.12

## 0.25.11

### Patch Changes

- @hot-updater/cli-tools@0.25.11
- @hot-updater/core@0.25.11
- @hot-updater/plugin-core@0.25.11

## 0.25.10

### Patch Changes

- Updated dependencies [90f9610]
- Updated dependencies [03c5adc]
  - @hot-updater/cli-tools@0.25.10
  - @hot-updater/plugin-core@0.25.10
  - @hot-updater/core@0.25.10

## 0.25.9

### Patch Changes

- Updated dependencies [6b22072]
  - @hot-updater/plugin-core@0.25.9
  - @hot-updater/cli-tools@0.25.9
  - @hot-updater/core@0.25.9

## 0.25.8

### Patch Changes

- @hot-updater/cli-tools@0.25.8
- @hot-updater/core@0.25.8
- @hot-updater/plugin-core@0.25.8

## 0.25.7

### Patch Changes

- @hot-updater/cli-tools@0.25.7
- @hot-updater/core@0.25.7
- @hot-updater/plugin-core@0.25.7

## 0.25.6

### Patch Changes

- @hot-updater/cli-tools@0.25.6
- @hot-updater/core@0.25.6
- @hot-updater/plugin-core@0.25.6

## 0.25.5

### Patch Changes

- @hot-updater/cli-tools@0.25.5
- @hot-updater/core@0.25.5
- @hot-updater/plugin-core@0.25.5

## 0.25.4

### Patch Changes

- Updated dependencies [8c83ff2]
  - @hot-updater/cli-tools@0.25.4
  - @hot-updater/core@0.25.4
  - @hot-updater/plugin-core@0.25.4

## 0.25.3

### Patch Changes

- @hot-updater/cli-tools@0.25.3
- @hot-updater/core@0.25.3
- @hot-updater/plugin-core@0.25.3

## 0.25.2

### Patch Changes

- @hot-updater/cli-tools@0.25.2
- @hot-updater/core@0.25.2
- @hot-updater/plugin-core@0.25.2

## 0.25.1

### Patch Changes

- @hot-updater/cli-tools@0.25.1
- @hot-updater/core@0.25.1
- @hot-updater/plugin-core@0.25.1

## 0.25.0

### Patch Changes

- @hot-updater/cli-tools@0.25.0
- @hot-updater/core@0.25.0
- @hot-updater/plugin-core@0.25.0

## 0.24.7

### Patch Changes

- 294e324: fix: update babel plugin path in documentation and plugin files
- Updated dependencies [294e324]
  - @hot-updater/cli-tools@0.24.7
  - @hot-updater/core@0.24.7
  - @hot-updater/plugin-core@0.24.7

## 0.24.6

### Patch Changes

- Updated dependencies [9d7b6af]
  - @hot-updater/cli-tools@0.24.6
  - @hot-updater/core@0.24.6
  - @hot-updater/plugin-core@0.24.6

## 0.24.5

### Patch Changes

- @hot-updater/cli-tools@0.24.5
- @hot-updater/core@0.24.5
- @hot-updater/plugin-core@0.24.5

## 0.24.4

### Patch Changes

- Updated dependencies [7ed539f]
  - @hot-updater/plugin-core@0.24.4
  - @hot-updater/cli-tools@0.24.4
  - @hot-updater/core@0.24.4

## 0.24.3

### Patch Changes

- @hot-updater/cli-tools@0.24.3
- @hot-updater/core@0.24.3
- @hot-updater/plugin-core@0.24.3

## 0.24.2

### Patch Changes

- @hot-updater/cli-tools@0.24.2
- @hot-updater/core@0.24.2
- @hot-updater/plugin-core@0.24.2

## 0.24.1

### Patch Changes

- @hot-updater/cli-tools@0.24.1
- @hot-updater/core@0.24.1
- @hot-updater/plugin-core@0.24.1

## 0.24.0

### Patch Changes

- @hot-updater/cli-tools@0.24.0
- @hot-updater/core@0.24.0
- @hot-updater/plugin-core@0.24.0

## 0.23.1

### Patch Changes

- @hot-updater/cli-tools@0.23.1
- @hot-updater/core@0.23.1
- @hot-updater/plugin-core@0.23.1

## 0.23.0

### Patch Changes

- Updated dependencies [e41fb6b]
  - @hot-updater/core@0.23.0
  - @hot-updater/plugin-core@0.23.0
  - @hot-updater/cli-tools@0.23.0

## 0.22.2

### Patch Changes

- @hot-updater/cli-tools@0.22.2
- @hot-updater/core@0.22.2
- @hot-updater/plugin-core@0.22.2

## 0.22.1

### Patch Changes

- 422bf89: feat: delete bundle softly(not storage only db)
  - @hot-updater/cli-tools@0.22.1
  - @hot-updater/core@0.22.1
  - @hot-updater/plugin-core@0.22.1

## 0.22.0

### Patch Changes

- @hot-updater/cli-tools@0.22.0
- @hot-updater/core@0.22.0
- @hot-updater/plugin-core@0.22.0

## 0.21.15

### Patch Changes

- @hot-updater/cli-tools@0.21.15
- @hot-updater/plugin-core@0.21.15
- @hot-updater/core@0.21.15

## 0.21.14

### Patch Changes

- @hot-updater/cli-tools@0.21.14
- @hot-updater/core@0.21.14
- @hot-updater/plugin-core@0.21.14

## 0.21.13

### Patch Changes

- @hot-updater/cli-tools@0.21.13
- @hot-updater/core@0.21.13
- @hot-updater/plugin-core@0.21.13

## 0.21.12

### Patch Changes

- Updated dependencies [5c4b98e]
  - @hot-updater/plugin-core@0.21.12
  - @hot-updater/cli-tools@0.21.12
  - @hot-updater/core@0.21.12

## 0.21.11

### Patch Changes

- e2b67d7: fix(cli-tools): esm only package bundle
- 2905e47: feat(server): supports hot-updater database plugin style
- Updated dependencies [d6c3a65]
- Updated dependencies [e2b67d7]
  - @hot-updater/cli-tools@0.21.11
  - @hot-updater/core@0.21.11
  - @hot-updater/plugin-core@0.21.11

## 0.21.10

### Patch Changes

- @hot-updater/cli-tools@0.21.10
- @hot-updater/plugin-core@0.21.10
- @hot-updater/core@0.21.10

## 0.21.9

### Patch Changes

- Updated dependencies [aa399a6]
  - @hot-updater/plugin-core@0.21.9
  - @hot-updater/cli-tools@0.21.9
  - @hot-updater/core@0.21.9

## 0.21.8

### Patch Changes

- Updated dependencies [3fe8c81]
  - @hot-updater/plugin-core@0.21.8
  - @hot-updater/cli-tools@0.21.8
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

- b7b83ae: feat(console): promote channel with copy
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

### Minor Changes

- 75e82a8: feat(console): prompt channel

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

- 8bf8f8f: rspress 2.0.0 and llms.txt
  - @hot-updater/core@0.18.1
  - @hot-updater/plugin-core@0.18.1

## 0.18.0

### Minor Changes

- 73ec434: fingerprint-based update stratgy

### Patch Changes

- Updated dependencies [73ec434]
  - @hot-updater/plugin-core@0.18.0
  - @hot-updater/core@0.18.0
