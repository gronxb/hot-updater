# hot-updater

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

- ab04e15: `hot-updater.config.ts` takes `plugins` beside `storage` and `database`: the server plugins the server runs. The config mirrors the server, so plugins are listed in three places: the server's `createHotUpdater({ plugins })`, `plugins` in `hot-updater.config.ts`, and the app's `HotUpdater.init({ plugins })`. A managed project lists them in two, the config and the app, since its prebuilt server runs the provider package's `plugins`.

  ```ts
  import { apiKeys } from "@hot-updater/server/plugins/api-keys";
  import { insights } from "@hot-updater/server/plugins/insights";

  export default defineConfig({
    build: bare(),
    storage: s3Storage({ ... }),
    database: standaloneRepository({ baseUrl, commonHeaders }),
    plugins: [insights(), apiKeys()],
    updateStrategy: "appVersion",
  });
  ```

  - `hotUpdater.plugins.ts` is no longer read. `hot-updater init` writes the provider package's `plugins` into `hot-updater.config.ts`, beside its storage and database, removes the `hotUpdater.plugins.ts` that an earlier init generated, and names one the project wrote. When it cannot edit the config, such as one whose own import takes a name init imports, like the project's own `plugins` list, it keeps the file unchanged and prints the storage, database, and plugins to set.
  - A managed project that an earlier release candidate's init set up, such as rc.20's, keeps its plugins in the generated `hotUpdater.plugins.ts`. Rerun `hot-updater init --provider <provider>`, which writes `plugins` into `hot-updater.config.ts` and removes that file, or add `plugins` from the provider package to `hot-updater.config.ts` and delete the file. Until then, `hot-updater console` shows neither Insights nor API keys, `hot-updater api-key` stops with an error, and `hot-updater doctor` checks no client plugins.
  - The CLI writes through the core it assembles from `database` and `plugins`, as `createHotUpdater` does: a listed plugin whose migration has not run stops a command, and writes on SQL databases delete the plugins' expired rows.
  - `hot-updater deploy` without `-p` loads `hot-updater.config` once for both platforms. A config object gives both the same `database` and `storage`, so one command deploys both, where rc.20 refused it even for a config object. A config function runs once per platform, so create its adapters outside the function and return the same ones; otherwise deploy stops before it builds with "Deploying multiple platforms requires a shared database configuration." or "Deploying multiple platforms requires a shared storage configuration."
  - `hot-updater doctor`, `hot-updater console`, and `hot-updater api-key` read the server's plugins from `plugins`. A self-hosted app imports the official ones from `@hot-updater/server`, which it installs as a development dependency.
  - `loadConfig` no longer fills a missing `database` or `storage` with a placeholder. `ConfigResponse` has both optional and `plugins` defaulting to `[]`, and a command that needs one says to set it in `hot-updater.config.ts`.
  - `hot-updater db migrate` and `db generate` load the server file named on the command line, which also loads `.env.hotupdater` from the working directory, or else `src/hotUpdater.*` or `src/db.*`. They no longer try `hot-updater.config.*`. `db generate --sql` reads the plugin list from the file named on the command line, then from `plugins` in `hot-updater.config.ts`, then from `src/hotUpdater.*` or `src/db.*`. These commands, and `hot-updater api-key` with a server file, close the file's database when they finish: through its `closeDatabase` export, or else the database's `dispose`.
  - The agent infrastructure scaffold's `app/hot-updater.config.ts` lists `plugins`, and the agent merges its storage, database, and plugins into the app's config. Its credential script provisions the client credential through the scaffold's own `app/hotUpdater.ts`, which replaces `app/database.config.ts` and `app/hotUpdater.plugins.ts` and stays in the scaffold.
  - In `@hot-updater/plugin-core`, `ConfigInput` takes `plugins?: readonly AnyHotUpdaterPlugin[]`.
  - `@hot-updater/cli-tools`:
    - adds `assembleServer({ database, storage, plugins })`, which runs `createHotUpdater` over a config's database, storage, and plugins, and returns them with the `core`, `api`, `clientPlugins`, and `clientAuth` it assembles. Over `standaloneRepository`, `core` is the server's admin API and `api` is `undefined`, since the plugins run on the server. Its types are `AssembleServerOptions` and `AssembledServer`;
    - adds `loadPlatformConfigs(platforms, { channel })`, which loads `hot-updater.config` once and returns each platform's config;
    - adds `writeHotUpdaterFiles(scaffold, { cwd, settings })`, which writes `hot-updater.config.ts` and removes the `hotUpdater.plugins.ts` an earlier init generated;
    - adds `moduleSpecifiersOf(fileName, source)`, which lists the modules a source file imports or re-exports;
    - removes rc.20's plugins file helpers, with no replacement: `HOT_UPDATER_PLUGINS_PATH`, `renderHotUpdaterPlugins`, `writeHotUpdaterPlugins`, `WriteHotUpdaterPluginsResult`, `generateHotUpdaterPlugins`, and `loadHotUpdaterPlugins`. It also removes `IConfigBuilder`, the interface `ConfigBuilder` implemented;
    - `createHotUpdaterConfigScaffold` requires `plugins`, and `ConfigBuilder.getScaffold()` and `getResult()` throw until `setPlugins()` sets them. `ConfigBuilder`'s `setStorage` and `setDatabase` no longer add the `applicationDefault` import from `firebase-admin/app` for Firebase; pass it with `addImport`.

- 0d8d03b: `hot-updater doctor` warns `MISSING_CLIENT_PLUGIN` when a server plugin's client plugin is missing from the app: for each client plugin that the plugins in `hot-updater.config.ts` name and no app source imports, it says to import it and pass it to `HotUpdater.init({ plugins })`. It checks a project that installs `@hot-updater/react-native` and sets `database`, and warns `CLIENT_PLUGINS_UNCHECKED` when it cannot load the config's database and plugins.
- ab04e15: Plugins no longer add `hot-updater` commands. `PluginCli` keeps `clientCredential` and `clientPlugin`, the metadata that `hot-updater init`, `hot-updater doctor`, and the agent scaffold read, and its `commands` is removed, with no replacement:
  - These names are removed from every package: `PluginCommand`, `PluginCommandArgument`, `PluginCommandOption`, `PluginCommandContext`, `PluginCommandUi`, and `PluginTableColumn`, which rc.20 exported from `@hot-updater/server/plugins`, and `pluginCommandsOf` and `PluginCommandEntry`, which rc.20 exported from `@hot-updater/server/db`.
  - `createHotUpdater` refuses a plugin whose `cli` holds `commands`, or any key other than `clientCredential` and `clientPlugin`, with `HotUpdaterConfigError`.
  - The CLI no longer looks for plugin commands, and `hot-updater --help` no longer lists **Plugin commands**.

  `hot-updater api-key create|list|revoke` is a built-in command again: `create --name <name>`, `list` with `--json`, and `revoke <id>` with `-y`, each with an optional trailing `[serverPath]`. It manages keys through `apiKeys()` over the first of:
  - the server file `serverPath` names, such as `src/hotUpdater.ts` in a server project;
  - `database` and `plugins` in `hot-updater.config.ts`, when the config sets `database`;
  - `src/hotUpdater.*` or `src/db.*`.

  When those plugins lack `apiKeys()`, it says to add it. With `database: standaloneRepository(...)`, it says to run the command in the server project with the server file's path, since the admin API serves no API key routes. The `cli` of `apiKeys()` from `@hot-updater/plugin-api-keys` holds only its `clientCredential`.

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
- eebe617: The "Next step" link that `hot-updater init` prints after it sets up AWS, Cloudflare, Firebase, or Supabase opens the provider guide at "Step 3: Add HotUpdater to your project". The old links named headings that the guides do not have, so they opened at the top of the page.
- 48cdd14: When no native build scheme is configured, the experimental native build commands (`build:android`, `build:ios`, `run:android`, and `run:ios`, available with `EXPERIMENTAL` set) say to add one under `nativeBuild.<platform>` in `hot-updater.config.ts` instead of linking to the Native Build docs page, which is removed until native builds are ready.
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

- bb57f25: What fills one slot of a config is now an adapter: storage, build, database, and signing. What you list in `plugins` stays a plugin: server plugins, client plugins, and the Sentry, Datadog, and BugSnag integration plugins that wrap a build adapter.
  - `@hot-updater/plugin-core`: `StoragePlugin` is `StorageAdapter`, `createStoragePlugin` is `createStorageAdapter`, `StoragePluginWith` is `StorageAdapterWith`, `CreateStoragePluginOptions` is `CreateStorageAdapterOptions`, `BuildPlugin` is `BuildAdapter`, `BuildPluginConfig` is `BuildAdapterConfig`, `BasePluginArgs` is `BuildAdapterArgs`, `BundleSigningPlugin` is `BundleSigningAdapter`, and `DatabasePluginInputError` is `DatabaseAdapterInputError`. There are no aliases.
  - `@hot-updater/bare`, `@hot-updater/expo`, and `@hot-updater/rock`: their options types are `BareAdapterConfig`, `ExpoAdapterConfig`, and `RockAdapterConfig`.
  - The CLI, the server, and the console say "storage adapter", "build adapter", "database adapter", and "signing adapter" in their messages, such as `Storage adapter "<name>" does not implement <operation>.` and `No storage adapter for protocol: <protocol>`. `hot-updater init --build <adapter>` names its option accordingly.

  Package names and factory names do not change: `s3Storage()`, `r2Storage()`, `bare()`, `expo()`, `rock()`, `postgres()`, and the rest are configured as before.

- Updated dependencies [c9cfed7]
- Updated dependencies [5ec6796]
- Updated dependencies [ab04e15]
- Updated dependencies [ab04e15]
- Updated dependencies [d500c97]
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
  - @hot-updater/android-helper@1.0.0-rc.21
  - @hot-updater/apple-helper@1.0.0-rc.21
  - @hot-updater/bsdiff@1.0.0-rc.21
  - @hot-updater/cli-tools@1.0.0-rc.21
  - @hot-updater/console@1.0.0-rc.21
  - @hot-updater/protocol@1.0.0-rc.21
  - @hot-updater/plugin-core@1.0.0-rc.21
  - @hot-updater/server@1.0.0-rc.21

## 1.0.0-rc.20

### Minor Changes

- 9cd555b: The plugin that provides `clientAuth` describes the credential an app sends in `cli.clientCredential`: its label, header, environment variable, and how to generate and provision it. `@hot-updater/server/db` exports `clientAuthOf`, `generateClientCredential`, and `provisionClientCredential`, which read it from a plugin list.

  Managed init provisions the app's credential through the provider's plugins and prints `HotUpdater.init` with that credential's header, or with no `requestHeaders` when client routes are public; `@hot-updater/cli-tools` exports `renderAppSetup` and `printAppSetup` for it. AWS CloudFront cache and origin-request policies key on the client-route policy's `varyHeaders` instead of a fixed `x-api-key`.

  Agent and infrastructure scaffolds record the server's `clientAuth` in `manifest.json` and render their instructions from it. The helper is `app/provision-client-credential.mjs` with `app/database.config.ts`, and it saves `app/client-credential.local`. `hot-updater doctor` reads the credential's header and variable from the scaffold, and skips the 401 check when client routes are public.

- 9cd555b: A server plugin names the client plugin an app adds to `HotUpdater.init`'s `plugins` in `cli.clientPlugin`, as `{ module, name }`; `insights()` names `insights` from `@hot-updater/react-native/plugins/insights`. `createHotUpdater` checks them at startup: each names an export the app can import, not a reserved word, `App`, or `HotUpdater`, and no two plugins name one export from different modules. `@hot-updater/server/db` exports `clientPluginsOf`, which reads them from a plugin list. Managed init passes them to `printAppSetup`, which imports them and adds them to `plugins`, and agent scaffolds record them in `manifest.json` and render the app code in their instructions from them.
- 9cd555b: Server plugins add their own `hot-updater` commands through a `cli` field on `definePlugin`. A command runs `run` with the plugin's API over a database the CLI opens itself; with a `standaloneRepository` config, it asks for the server config that exports `hotUpdater`. The CLI looks for plugin commands only when it has no core command of that name: in a server config the command line names, then `hotUpdater.plugins.ts` over the database in `hot-updater.config.ts`, then `hot-updater.config.ts`, `src/hotUpdater.ts`, or `src/db.ts`. `hot-updater --help` and the unknown-command error list them under **Plugin commands**, marked with their plugin's id.

  `hot-updater api-key create|list|revoke` now comes from `apiKeys()`, with the same arguments and options, and also runs in managed projects through `hotUpdater.plugins.ts`. `@hot-updater/server/db` exports `serverPluginsOf` and `pluginCommandsOf` for tooling.

- 9cd555b: Remove the `hot-updater codemod` command and its `client-access` codemod. It only moved `clientAccess` objects from earlier release candidates to plugins, and release candidates keep no compatibility with each other: recreate the RC database, and update the server, app, and console together.

### Patch Changes

- e696e69: The 1.0.0 infrastructure upgrade notes that `hot-updater infra scaffold` writes, and the AWS agent setup, list the DynamoDB policy's batched Insights log partitions, `aggregate_log_0` to `aggregate_log_7` and `aggregate_lease`, and its `BatchWriteItem` permission. The IAM policy changed: rerun `hot-updater init`, and recreate release candidate data if needed. The notes' Insights check reads overview summaries through the Console or the admin API on DynamoDB and Firestore, since a read applies pending batches first.
- 9574287: Cache a scope's missing Release Catalog like a catalog. The `404` for a scope with no catalog yet, such as a store version before its first OTA release, now uses the catalog's `public, max-age=0, s-maxage=5` and is marked `x-hot-updater-catalog: none`, so a shared cache absorbs those update checks instead of passing each one to the origin. Other `404`s stay `private, no-store` and unmarked. `hot-updater doctor` and the agent server check accept the marked `404` as an empty catalog and still reject an unmarked one.
- a084eda: `hot-updater db generate --sql` writes core's tables and those of the server's plugins, which it finds as plugin commands find theirs: in the server config the first argument names, in `hotUpdater.plugins.ts`, or in a default server config. It names the file it read them from; without one, it says so and writes core's tables only. The agent scaffold's Firestore `database.config.ts` exports `migrate(plugins)`, which `provision-client-credential.mjs` runs with the plugins `hotUpdater.plugins.ts` lists.
- d7f1688: The `HotUpdater.init` snippet that managed `init` prints now adds the Insights client plugin, `plugins: [insights()]` from `@hot-updater/react-native/plugins/insights`, since an app reports to Insights only with it. The CLI's agent setup instructions add the same plugin.
- 14188a7: Update packaged infrastructure instructions for the stable release, remove
  release-candidate migration procedures, and correct provider verification order
  and schema prerequisites.
- 530cca5: Each provider deletes rows past their table's retention with no scheduler. DynamoDB deletes items by Time to Live on `_ttl`: `migrateDynamoDB`, `hot-updater db migrate`, and the managed AWS setup turn it on, and `hot-updater infra scaffold` writes `dynamodb/enable-ttl.json`. Firestore deletes documents by a TTL policy on `expireAt`, declared in `firestore.indexes.json`. Cloudflare D1 and Supabase delete them during writes, in bounded batches, within D1's query limit for one Worker invocation and through Supabase's apply RPC. The D1 and Supabase schemas add the Insights daily and lifetime tables and the indexes pruning walks. A deployment from a 1.0.0 release candidate recreates its database and updates the server, app, and console together.
- Updated dependencies [e696e69]
- Updated dependencies [e696e69]
- Updated dependencies [e696e69]
- Updated dependencies [e696e69]
- Updated dependencies [e696e69]
- Updated dependencies [9574287]
- Updated dependencies [9cd555b]
- Updated dependencies [9cd555b]
- Updated dependencies [9cd555b]
- Updated dependencies [1ddd5fc]
- Updated dependencies [9a6715f]
- Updated dependencies [a084eda]
- Updated dependencies [530cca5]
- Updated dependencies [959ba94]
- Updated dependencies [b317d49]
- Updated dependencies [d7f1688]
- Updated dependencies [1ddd5fc]
- Updated dependencies [9cd555b]
- Updated dependencies [530cca5]
- Updated dependencies [b317d49]
- Updated dependencies [9cd555b]
- Updated dependencies [9a6715f]
- Updated dependencies [a084eda]
- Updated dependencies [530cca5]
- Updated dependencies [b317d49]
- Updated dependencies [9a6715f]
- Updated dependencies [a084eda]
- Updated dependencies [530cca5]
- Updated dependencies [b317d49]
  - @hot-updater/aws@1.0.0-rc.18
  - @hot-updater/firebase@1.0.0-rc.18
  - @hot-updater/plugin-core@1.0.0-rc.17
  - @hot-updater/server@1.0.0-rc.18
  - @hot-updater/cli-tools@1.0.0-rc.17
  - @hot-updater/cloudflare@1.0.0-rc.18
  - @hot-updater/supabase@1.0.0-rc.18
  - @hot-updater/console@1.0.0-rc.20
  - @hot-updater/android-helper@1.0.0-rc.17
  - @hot-updater/apple-helper@1.0.0-rc.17

## 1.0.0-rc.19

### Patch Changes

- 038c804: Move `createBundleDiff` from `@hot-updater/server/db` to its own entry, `@hot-updater/server/diff`. The `db` entry no longer loads bsdiff's WebAssembly, so a console that uses it builds for Cloudflare Workers.
- Updated dependencies [038c804]
- Updated dependencies [038c804]
- Updated dependencies [038c804]
  - @hot-updater/console@1.0.0-rc.19
  - @hot-updater/server@1.0.0-rc.17
  - @hot-updater/aws@1.0.0-rc.17
  - @hot-updater/cloudflare@1.0.0-rc.17
  - @hot-updater/firebase@1.0.0-rc.17
  - @hot-updater/supabase@1.0.0-rc.17

## 1.0.0-rc.18

### Minor Changes

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

- d482b13: Add `hot-updater codemod client-access [paths...]`, which moves `createHotUpdater` calls from the 1.0 release candidates' `clientAccess` objects to plugins.
  - **Rewrites:** `clientAccess: { type: "public" }` becomes `clientAccess: "public"`. `clientAccess: { type: "api-key", headerName? }` is removed, and `apiKeys()` joins `plugins`, with the same `headerName` when one was set. A call without `plugins` gets `insights()`, which the release candidates ran by default. Missing imports from `@hot-updater/server/plugins/api-keys` and `@hot-updater/server/plugins/insights` are added, as `require` calls in CommonJS files.
  - **Edits in place:** the command parses each file with OXC and changes only the spans it rewrites, so formatting and comments survive. Calls that already use `clientAccess: "public"` or `plugins` stay as they are, so it can run again.
  - **Reports:** a file with a call it cannot rewrite safely, such as a `clientAccess` or `plugins` value held in a variable or options built with a spread, is reported with its line and left unchanged, and the command exits with code 1.
  - **Paths:** it takes files, directories, or globs, and defaults to the current directory without `node_modules`, `dist`, and `build`. `--dry-run` prints a unified diff and writes nothing.

- 7ba867c: Run the Drizzle adapter on the new storage engine. `drizzleAdapter({ db, provider })` keeps its signature.
  - **Engine:** reads and writes go through the shared SQL core over the Drizzle database's own driver. `db` may also be a function that returns the database on first use.
  - **Drivers:** the first use checks that the driver can run an interactive transaction. The supported drivers are node-postgres, postgres-js, PGlite, and Neon over WebSockets for PostgreSQL; mysql2 for MySQL; and libSQL, better-sqlite3, or bun:sqlite for SQLite. Other drivers are refused with `DrizzleTransactionUnsupportedError`. Sync SQLite drivers run one statement at a time and begin transactions with `BEGIN IMMEDIATE`.
  - **Schema:** `hot-updater db generate` writes the engine's tables as a Drizzle schema for `drizzle-kit push`. Every column is typed exactly as the SQL schema declares it.
  - **Migrations:** after `drizzle-kit push`, `hot-updater db migrate` now runs for Drizzle and writes only the settings rows. It asks for the tables when they are missing and refuses a pre-engine database.
  - **Schema fence:** the adapter fences its schema, so handlers answer 503 until `db migrate` has run.
  - **Unused options:** the `schema` option is accepted and ignored; it is for drizzle-kit. The `transaction` option is gone: every write runs in a transaction.

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

- d482b13: The agent setup checklists that `hot-updater agent infra` writes describe a 1.0 release candidate's resources the way the upgrade notes do. The Supabase checklist no longer points to a removed commit RPC migration: release candidate tables and functions are dropped and their migrations marked reverted before the push. The Cloudflare checklist treats a D1 database that recorded `0001_hot-updater_1.0.0.sql` without `schema.engine` as incompatible, and the AWS checklist's DynamoDB leading keys match the policy the scaffold writes.
- d482b13: Auto-patch bases match what `deploy` chose before the storage engine. `core.findBaseBundleIds` reads the new bundle's Release Catalog scope in one point read and keeps every enabled bundle release whose target app version range intersects the new target (the same fingerprint, in a fingerprint scope), newest release first, each bundle once and older than the new bundle, up to `patch.maxBaseBundles`. Targets such as `1.x`, `*`, or `>=1.2.0 <2` get bases again, a `*` or `1.x` release serves every version it covers, a release on another patch version of the same minor line no longer takes a slot, and a promoted or republished bundle counts from its newest release.

  `targetBaseCandidateKey` takes the channel name instead of its id, and its key names the catalog scope and the normalized range. The `base_candidates` aggregate and its gauge writes are gone, so each release change writes up to 16 fewer rows; the checked-in D1, Postgres, and Supabase schemas drop the table.

- 94b56f3: Run DynamoDB on the new storage engine. `dynamoDB(config)` keeps its signature, and still invalidates the update-check routes' CloudFront copies after a write that changes what they answer.
  - **One table, no secondary index:** the plugin is the key-value helper over one table keyed by string `pk` and `sk`. Each row is an item. Each index a row belongs to adds an item holding a copy of it, written in the same transaction. Reads are strongly consistent, and a write is one `TransactWriteItems` with a client request token. Commits over 100 items, 4 MB, or 400 KB in one item are refused before anything is written.
  - **Schema settings:** the plugin checks the schema settings before its first read and answers 503 until they exist. `migrateDynamoDB(config)` writes them, and creates the table when it is missing. `hot-updater init` runs it after creating the table, the agent scaffold ships the same items as `dynamodb/schema-settings.json`, and the DynamoDB example runs it before registering its API key.
  - **Infrastructure:** `hot-updater init` creates the table without `hot-updater-update-index` and refuses a table that still has it, which a 1.0 release candidate created. The IAM policy allows the key-value store's reads and writes on each table's partitions, `<table>` and `<table>#*`.
  - **Insights shards:** gauge aggregates (`insights_distribution`, `insights_latest_by_bundle`) now spread over 32 shards, on every backend. DynamoDB's contention gate, on DynamoDB Local with 16 writers at 100 moves per second, retried 2–24% of rollout moves at 16 and 1–5% at 32; these are test figures, not production limits. Sketches stay at 16, since every read merges their 2 KB registers, and counters stay at 8. Rows already written on shards 0–15 keep counting.
  - **Removed:** the DynamoDB implementation (about 4,200 lines) and `DYNAMODB_UPDATE_INDEX_NAME`.

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

- d482b13: The 1.0.0 infrastructure upgrade notes that `hot-updater infra scaffold` writes no longer ask a release candidate deployment to apply schema additions in place, or to look for tables and columns that the storage engine replaced. A release candidate's database is recreated: a D1 database that recorded `0001_hot-updater_1.0.0.sql` gets a new database or dropped tables before the scaffold's migrations, and the Worker waits for `schema.engine`.
- e542054: Run the Kysely adapter and the `postgres` plugin on the new storage engine. Their factory signatures are unchanged.
  - **Kysely:** `kyselyAdapter` runs PostgreSQL, MySQL, and SQLite through the shared SQL core with `kyselyExecutor`.
    - Its migrator applies the generated SQL schema: tables, indexes, and the settings rows, written last.
    - The migrator refuses a v0 or pre-engine database instead of converting it.
  - **Schema fence:** both adapters fence their schema. A database without the `schema.engine` row is refused before its first read, and handlers answer 503.
  - **`postgres` plugin:** `sql/bundles.sql` is now the generated SQL schema, and a test fails when the two differ.
  - **Removed:** the plugin-specific Insights helpers `getKyselyAppUsage`, `getKyselyReleaseActivity`, `readKyselyInsightsHead`, and `recordKyselyInsightsOverview` are no longer exported from `@hot-updater/server`.
  - **Upgrade note:** the 1.0.0 infrastructure upgrade note now says that RC databases created before the adapter redesign must be recreated.

- 3f30a23: Serve Insights and API keys through plugins.
  - **Insights routes:** `POST /events` and the admin Insights reads come from the `insights()` plugin. Without it, each answers 204 with `x-hot-updater-insights: disabled`.
  - **API keys:** the `apiKeys()` plugin protects client routes with the same header the `clientAccess: { type: "api-key" }` option used, so a server that moves to plugins never falls back to public.
  - **Core reads:** `hotUpdater.core` reads bundles, Releases, Catalogs, and channels. Plugins get the same reads as `ctx.core`, on the same engine. A plugin cannot take the id `core`.
  - **Plugin APIs:** `hotUpdater.api.insights` and `hotUpdater.api.apiKeys` replace `hotUpdater.insights` and `hotUpdater.apiKeys`.
  - **Providers:** `@hot-updater/aws`, `cloudflare`, `firebase`, and `supabase` export `plugins`, their managed server's plugin list (`insights()` and `apiKeys()`). The Lambda, Worker, Cloud Function, and Edge Function templates use it, with the same `x-api-key` header.
  - **CLI:** `generate-standalone-sql` and the missing-export help text use the new options.

- Updated dependencies [152db48]
- Updated dependencies [23a972d]
- Updated dependencies [d482b13]
- Updated dependencies [802374f]
- Updated dependencies [d482b13]
- Updated dependencies [d482b13]
- Updated dependencies [d482b13]
- Updated dependencies [fe03f59]
- Updated dependencies [8d60f68]
- Updated dependencies [d482b13]
- Updated dependencies [d482b13]
- Updated dependencies [d482b13]
- Updated dependencies [23a972d]
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
- Updated dependencies [d482b13]
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
  - @hot-updater/aws@1.0.0-rc.16
  - @hot-updater/cloudflare@1.0.0-rc.16
  - @hot-updater/supabase@1.0.0-rc.16
  - @hot-updater/plugin-core@1.0.0-rc.16
  - @hot-updater/console@1.0.0-rc.18
  - @hot-updater/cli-tools@1.0.0-rc.16
  - @hot-updater/firebase@1.0.0-rc.16
  - @hot-updater/android-helper@1.0.0-rc.16
  - @hot-updater/apple-helper@1.0.0-rc.16

## 1.0.0-rc.17

### Minor Changes

- f5fffea: Add atomic Release Insights aggregates, direct release-health and app-usage
  queries, and the redesigned Insights console without reconstructing metrics from
  raw event history.
- 88add06: Add deterministic doctor scopes for configured infrastructure scaffolds and live server verification. Agents can gate completion on structured checks and exit codes instead of deployment records. Reuse the server protocol probe in doctor and the packaged helper, and document which checks remain outside each scope.

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

- d99530b: Stop installing dotenv during init. Generate configs with Node's built-in environment loader, allow CI to supply environment variables without a local env file, and preserve existing environment setup when merging configs.

  Use Node's native environment parser for server verification and remove dotenv from generated infrastructure dependency lists and API-key configs.

  Remove direct dotenv dependencies from examples and server examples, replace react-native-dotenv in mobile examples with explicit public configuration, and update the documentation. Preserve public E2E build settings for manual launches.

- 39f60f9: Serialize Kysely database commits and retry native serialization conflicts so concurrent Release revision and Catalog generation expectations cannot both succeed with the same version.

  Replace Firebase row fields atomically instead of recursively merging JSON metadata, while preserving unrelated document extension fields.

  Apply Supabase migration `20260922000000_idempotent_channel_commit.sql` to existing generation 1 projects. It makes generic deletion of a missing Channel an atomic no-op, preserving table layouts, schema version, existing data, and RPC permissions.

- Updated dependencies [f5fffea]
- Updated dependencies [79c3eea]
- Updated dependencies [d99530b]
- Updated dependencies [79c3eea]
- Updated dependencies [39f60f9]
  - @hot-updater/aws@1.0.0-rc.15
  - @hot-updater/cloudflare@1.0.0-rc.15
  - @hot-updater/console@1.0.0-rc.17
  - @hot-updater/firebase@1.0.0-rc.15
  - @hot-updater/plugin-core@1.0.0-rc.15
  - @hot-updater/server@1.0.0-rc.15
  - @hot-updater/supabase@1.0.0-rc.15
  - @hot-updater/cli-tools@1.0.0-rc.15
  - @hot-updater/core@1.0.0-rc.15
  - @hot-updater/android-helper@1.0.0-rc.15
  - @hot-updater/apple-helper@1.0.0-rc.15

## 1.0.0-rc.16

### Patch Changes

- 03d4369: Read the default iOS target app version from `project.pbxproj` when `Info.plist` holds an unresolved build setting. The React Native template ships `CFBundleShortVersionString` as `$(MARKETING_VERSION)`, which the plist parser cannot resolve, so `getDefaultTargetAppVersion` returned `null` for most iOS projects: `deploy -i` prefilled the "Target app version" prompt with `1.0.0` instead of the real version, and non-interactive `deploy` without `-t` failed outright. `getNativeAppVersion` already falls back to the same parser; this aligns the two.
- Updated dependencies [3fa24fc]
  - @hot-updater/console@1.0.0-rc.16

## 1.0.0-rc.15

### Patch Changes

- Updated dependencies [7f3ba17]
  - @hot-updater/console@1.0.0-rc.15

## 1.0.0-rc.14

### Patch Changes

- Align all Hot Updater packages on 1.0.0-rc.14 for a coordinated release candidate. Future releases continue to use independent package versions.
- b23db5e: Replace shared Insights installation storage with canonical events and provider-private indexes for current installation queries. SQL and MongoDB keep nine access fields and fetch full event payloads only for selected results; DynamoDB counts compact scope entries. Custom providers implement `recordEvent({ event })`, `findLatestEvents`, and explicit `countLatestEvents` predicates without lifecycle helpers. Move ancillary event fields into typed `metadata`, reusing Bundle JSON conventions, while preserving SDK requests and Console responses.

  This changes the unreleased 1.0.0 initialization and custom database contract from the previous installation-row design. The read-cost fix preserves the canonical-event contract and keeps current-state queries independent of retained event history. Append and index updates are atomic; measured read/write costs are documented.

- b23db5e: Align Firebase Functions and its CLI with the Admin SDK used by generated servers. Firebase emulator checks now require Java 21.

  Forward the original JSON request body through the Firebase Functions entrypoint so Insights events retain their payload and can be recorded.

  Allow the managed AWS runtime to access release catalogs and release lookup records required by the current storage implementation.

- e828ecb: Finish agent infrastructure setup with a ready-to-copy HotUpdater.init snippet
  containing the verified server URL and registered client API key.
- Updated dependencies [479c1e5]
- Updated dependencies
- Updated dependencies [b23db5e]
- Updated dependencies [b23db5e]
- Updated dependencies [b0387d8]
  - @hot-updater/server@1.0.0-rc.14
  - @hot-updater/console@1.0.0-rc.14
  - @hot-updater/plugin-core@1.0.0-rc.14
  - @hot-updater/cloudflare@1.0.0-rc.14
  - @hot-updater/supabase@1.0.0-rc.14
  - @hot-updater/firebase@1.0.0-rc.14
  - @hot-updater/aws@1.0.0-rc.14
  - @hot-updater/android-helper@1.0.0-rc.14
  - @hot-updater/apple-helper@1.0.0-rc.14
  - @hot-updater/cli-tools@1.0.0-rc.14
  - @hot-updater/core@1.0.0-rc.14

## 1.0.0-rc.13

### Patch Changes

- Updated dependencies [1e42b0b]
  - @hot-updater/console@1.0.0-rc.11

## 1.0.0-rc.12

### Patch Changes

- Updated dependencies [21520c7]
  - @hot-updater/console@1.0.0-rc.10

## 1.0.0-rc.11

### Patch Changes

- Updated dependencies [3385448]
  - @hot-updater/console@1.0.0-rc.9

## 1.0.0-rc.10

### Patch Changes

- Updated dependencies [6108b6d]
- Updated dependencies [f9686ed]
  - @hot-updater/console@1.0.0-rc.8

## 1.0.0-rc.9

### Patch Changes

- 2cb3cf0: Make agent infrastructure onboarding resumable through provider checklists with explicit prerequisites, verification evidence and pending-operation records. Package a read-only server verification helper, align database/key/deployment ordering with init, and export AWS DynamoDB/IAM request templates from the same builders used by interactive setup.
- 610054e: Report the configured console port when it is already in use and exit before starting another server.
- Updated dependencies [24653fd]
- Updated dependencies [8a331bf]
- Updated dependencies [2cb3cf0]
  - @hot-updater/console@1.0.0-rc.7
  - @hot-updater/aws@1.0.0-rc.4

## 1.0.0-rc.8

### Patch Changes

- Updated dependencies [f869358]
- Updated dependencies [663d8e9]
- Updated dependencies [663d8e9]
  - @hot-updater/supabase@1.0.0-rc.4
  - @hot-updater/console@1.0.0-rc.6
  - @hot-updater/server@1.0.0-rc.3
  - @hot-updater/plugin-core@1.0.0-rc.3
  - @hot-updater/cloudflare@1.0.0-rc.5
  - @hot-updater/aws@1.0.0-rc.3
  - @hot-updater/firebase@1.0.0-rc.4
  - @hot-updater/android-helper@1.0.0-rc.3
  - @hot-updater/apple-helper@1.0.0-rc.3
  - @hot-updater/cli-tools@1.0.0-rc.3

## 1.0.0-rc.7

### Minor Changes

- ed17bef: Add `hot-updater infra scaffold --provider <provider>` for standalone server
  template extraction without an agent or app build selection. Reuse its extractor
  in `hot-updater agent infra setup` and `hot-updater agent infra upgrade` to
  generate versioned deployment templates and agent instructions for Cloudflare,
  Supabase, AWS, and Firebase. Scaffolds preserve existing edits and provide
  provider-specific verification, resume guidance, and private reusable API-key
  provisioning. Agents apply the files through their available provider tools.

  Connect doctor remediation to the agent commands and require a complete
  version-named Markdown release file for every infrastructure requirement.
  Retain historical files and provide an ordered index so agents can read the
  complete upgrade path, including intermediate releases. Include the
  v0-to-v1 coexistence and native-build transition as the initial upgrade record.
  Share existing provider config builders with the packaged scaffolds.

  Include provider environment guides explaining each variable's purpose,
  conditions and secure source. Guide agents to discover the app and existing
  resources, create missing infrastructure, and ask only for unresolved choices
  or access, without requesting secrets in chat.

  Accept the bundled server prerelease in doctor when running the matching
  prerelease CLI, while retaining generation checks and stable release requirements.
  Check helper runtime prerequisites before provisioning, apply Cloudflare config
  before migrations, and include Firebase download-signing permissions and reusable
  application-default credentials in the onboarding instructions.

### Patch Changes

- Updated dependencies [ed17bef]
- Updated dependencies [5c8972c]
- Updated dependencies [c3f7896]
  - @hot-updater/cloudflare@1.0.0-rc.4
  - @hot-updater/supabase@1.0.0-rc.3
  - @hot-updater/firebase@1.0.0-rc.3
  - @hot-updater/console@1.0.0-rc.5

## 1.0.0-rc.6

### Patch Changes

- Updated dependencies [8afd7a8]
  - @hot-updater/console@1.0.0-rc.4

## 1.0.0-rc.5

### Patch Changes

- 47caf8a: Validate signing only for the selected deploy platform.

## 1.0.0-rc.4

### Patch Changes

- Updated dependencies [1067058]
  - @hot-updater/console@1.0.0-rc.3

## 1.0.0-rc.3

### Patch Changes

- 8c3c4f2: Report the default `production` channel in `hot-updater channel` when the native files carry no channel value, instead of showing an empty channel.
- 6ccceec: Exit with code 1 when `hot-updater doctor` fails with an error such as a missing `package.json` or an uninstalled CLI. The default output previously printed "Doctor check failed." and exited 0, so CI treated a failed doctor run as a pass, while `--json` already exited 1 for the same result.
- a837c71: Upgrade verkit to 0.4.0 while preserving canonical app-version strings and
  Doctor's package-version compatibility checks with the new parsed SemVer
  return values. Upgrade the workspace build tool tsdown to 0.22.14.
- f48521a: Align the console ID, `HotUpdater.getBundleId()`, update-check results, completion callbacks, and `bundle list/show` with the selected update identity so promotions sharing an artifact remain distinguishable. The getter can reflect a staged update before reload. Remove the prerelease `getReleaseId()` getter, keep artifact and crash identities unchanged, and move Artifact IDs into Advanced diagnostics. `bundle list --json` returns the internal rows, and `bundle show` accepts the console ID. Use `HotUpdater.getManifest().bundleId` for BugSnag sourcemap matching.
- 0546348: Keep the v0 bundle mental model while using the console update ID everywhere. Deploy now prints that ID once in its final success area, and `bundle list`, `show`, `update`, `preflight`, `enable`, `disable`, `delete`, and `promote` all accept the same ID. The prerelease `release` command is removed. Immutable-file cleanup moves to Advanced `bundle artifact delete <artifact-id>`, and patch creation uses `--artifact-id` and `--base-artifact-id` (with the old bundle-named flags retained as hidden aliases). Raw JSON and internal database fields remain unchanged.
- Updated dependencies [e6d9ae7]
- Updated dependencies [51300d4]
- Updated dependencies [483483e]
- Updated dependencies [590ca70]
- Updated dependencies [a837c71]
- Updated dependencies [f48521a]
  - @hot-updater/console@1.0.0-rc.2
  - @hot-updater/server@1.0.0-rc.2
  - @hot-updater/plugin-core@1.0.0-rc.2
  - @hot-updater/aws@1.0.0-rc.2
  - @hot-updater/cloudflare@1.0.0-rc.3
  - @hot-updater/firebase@1.0.0-rc.2
  - @hot-updater/supabase@1.0.0-rc.2
  - @hot-updater/cli-tools@1.0.0-rc.2
  - @hot-updater/android-helper@1.0.0-rc.2
  - @hot-updater/apple-helper@1.0.0-rc.2

## 1.0.0-rc.2

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
  - @hot-updater/console@1.0.0-rc.1
  - @hot-updater/cli-tools@1.0.0-rc.1
  - @hot-updater/aws@1.0.0-rc.1
  - @hot-updater/cloudflare@1.0.0-rc.2
  - @hot-updater/firebase@1.0.0-rc.1
  - @hot-updater/supabase@1.0.0-rc.1
  - @hot-updater/android-helper@1.0.0-rc.1
  - @hot-updater/apple-helper@1.0.0-rc.1

## 1.0.0-rc.1

### Patch Changes

- 2aeccfb: Allow Doctor to accept package increments within the same prerelease channel.

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

- 88c163a: Align the CLI with the Release Catalog ownership model. Deploy now reports the
  committed Release and Catalog handles, Release commands expose and preview
  policy state, Bundle commands report Release references, missing Catalog
  projections can be rebuilt, and storage pruning safely reclaims unreferenced
  patch objects below live Bundle prefixes.

  Remove the ambiguous top-level Bundle-targeted rollback command. Use
  `hot-updater release disable <release-id>` to roll back an exact Release.

- a9ffb2a: Require R2 S3 credentials, drop Wrangler `r2Storage` and Android `stringResourcePaths`. Doctor only targets infrastructure generation 1.0.0. Channel, fingerprint, and signing keys live in AndroidManifest.xml.
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

- a9ffb2a: Create schema 1.0.0 from empty databases only. `db migrate` and `db generate` no longer accept or upgrade v0 schema markers, and managed SQL templates are a single 1.0.0 CREATE.

### Patch Changes

- 353e1ca: Package the full Console application behind root and `/vite` exports so a thin
  Vite and Nitro host can deploy it with injected runtime configuration and
  authentication. Keep the CLI console unauthenticated but force it to bind to
  the loopback interface.
- c387b0b: Allow independently released Hot Updater packages from the same stable major
  version to pass doctor compatibility checks.
- c06c7df: Restore the plain `#!/usr/bin/env node` shebang on the CLI entry so Yarn Classic generates a working `hot-updater.cmd` shim on Windows.
- c06c7df: Rename the CLI's `init --env-file` option to `init --from-env-file` to avoid Node.js interpreting replay files as its own startup configuration. This keeps the portable shebang required by Yarn Classic on Windows without allowing `NODE_OPTIONS` in a replay file to run preloads before the CLI starts.

  Breaking change: update replay commands to `hot-updater init --from-env-file .env.hotupdater`. The old `--env-file` CLI option is no longer supported. The programmatic `envFile` option is unchanged.

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

- Updated dependencies [3b367e7]
- Updated dependencies [467e5f6]
- Updated dependencies [353e1ca]
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
- Updated dependencies [c06c7df]
- Updated dependencies [c355c26]
- Updated dependencies [e494531]
- Updated dependencies [3b367e7]
- Updated dependencies [7ec1a46]
- Updated dependencies [1af8cba]
- Updated dependencies [3b367e7]
- Updated dependencies [86f610b]
- Updated dependencies [a9ffb2a]
- Updated dependencies [a9ffb2a]
  - @hot-updater/plugin-core@1.0.0-rc.0
  - @hot-updater/server@1.0.0-rc.0
  - @hot-updater/console@1.0.0-rc.0
  - @hot-updater/cli-tools@1.0.0-rc.0
  - @hot-updater/aws@1.0.0-rc.0
  - @hot-updater/cloudflare@1.0.0-rc.0
  - @hot-updater/firebase@1.0.0-rc.0
  - @hot-updater/supabase@1.0.0-rc.0
  - @hot-updater/core@1.0.0-rc.0
  - @hot-updater/android-helper@1.0.0-rc.0
  - @hot-updater/apple-helper@1.0.0-rc.0

## 0.36.0

### Minor Changes

- 9759e8a: Reduce S3 management query work by skipping legacy UUIDv7 artifact traversal, deriving channels from canonical manifest keys, and batching multi-bundle deletion scans and commits. Store new bundle artifacts below `bundles/<bundle-id>` while preserving legacy reads, and add exact target app version filters to the CLI and Console. Add an exclusive-maintenance `hot-updater storage prune` command for orphaned bundle objects and unreferenced shared assets, with an explicit `--dry-run` candidate table, a recent-object protection window, and fail-closed reference validation safeguards.

### Patch Changes

- da7de2d: Preserve UUIDv7 S3 channels while avoiding per-prefix legacy traversal, respect
  standalone server pagination limits during storage pruning and batch deletion,
  and document the safe storage cleanup workflow.
- Updated dependencies [9759e8a]
  - @hot-updater/cli-tools@0.36.0
  - @hot-updater/plugin-core@0.36.0
  - @hot-updater/console@0.36.0
  - @hot-updater/server@0.36.0
  - @hot-updater/android-helper@0.36.0
  - @hot-updater/apple-helper@0.36.0
  - @hot-updater/core@0.36.0

## 0.35.12

### Patch Changes

- 6e8b32e: Replace the semver dependency with verkit.
- Updated dependencies [fd30452]
- Updated dependencies [6e8b32e]
  - @hot-updater/cli-tools@0.35.12
  - @hot-updater/console@0.35.12
  - @hot-updater/plugin-core@0.35.12
  - @hot-updater/server@0.35.12
  - @hot-updater/android-helper@0.35.12
  - @hot-updater/apple-helper@0.35.12
  - @hot-updater/core@0.35.12

## 0.35.11

### Patch Changes

- bfbb823: fix: read the iOS app version from Info.plist before project.pbxproj

  `getNativeAppVersion("ios")` tried the `xcodeproj` parser first and only fell back
  to `info-plist`. Parsing project.pbxproj is synchronous, so on a large project it
  blocks the event loop for the whole parse, and `deploy` does this after the bundle
  has already been uploaded, just to fill in `metadata.app_version`. On a 12.5MB
  pbxproj that was ~5 minutes locally and ~16 minutes on CI.

  Info.plist is read first now. `CFBundleShortVersionString` is also closer to what
  the built app actually reports than `MARKETING_VERSION` (#84). The xcodeproj parser
  is still there as a fallback when Info.plist has no version.

- bfbb823: fix: bump the bundled `@bacons/xcode` to 1.0.0-alpha.33

  alpha.24 was published in December 2024 and still uses the old Chevrotain-based
  pbxproj parser. alpha.31 picked up the single-pass rewrite from
  EvanBacon/xcode#37, which is 42x faster on their benchmarks and considerably more
  than that on large files.

  On a 12.5MB `project.pbxproj`, `XcodeProject.open()` goes from 286s and 1.8GB of
  peak RSS down to 0.2s and 285MB, returning the same 48,670 objects. The only API
  used here is `XcodeProject.open().toJSON()` in `getIOSVersion`, which is unchanged
  between the two versions.

- fceb580: fix: fallback to project.pbxproj when Info.plist contains an unresolved build setting
- Updated dependencies [1a3a621]
  - @hot-updater/plugin-core@0.35.11
  - @hot-updater/android-helper@0.35.11
  - @hot-updater/apple-helper@0.35.11
  - @hot-updater/cli-tools@0.35.11
  - @hot-updater/console@0.35.11
  - @hot-updater/server@0.35.11
  - @hot-updater/core@0.35.11

## 0.35.10

### Patch Changes

- ce8d254: feat: support platform-scoped `fingerprint.extraSources`

  `fingerprint.extraSources` now accepts `{ ios?: string[], android?: string[] }`
  in addition to `string[]`. An array keeps the existing behavior (shared by both
  platforms); the object form only feeds the fingerprint of the platform it is
  scoped to, so an iOS-only native input no longer moves the Android fingerprint
  (and vice versa).

  The default config no longer sets `extraSources: []`, which the config deep
  merge would otherwise use to clobber a user-supplied object.

- Updated dependencies [ce8d254]
  - @hot-updater/plugin-core@0.35.10
  - @hot-updater/cli-tools@0.35.10
  - @hot-updater/android-helper@0.35.10
  - @hot-updater/apple-helper@0.35.10
  - @hot-updater/console@0.35.10
  - @hot-updater/server@0.35.10
  - @hot-updater/core@0.35.10

## 0.35.9

### Patch Changes

- f9bb26d: Declare init inputs in each provider package through a shared contract, ask
  once before saving credential inputs, and support prompt-free infrastructure
  reconciliation with `init --env-file .env.hotupdater`.
- Updated dependencies [8688b1a]
- Updated dependencies [f9bb26d]
  - @hot-updater/cli-tools@0.35.9
  - @hot-updater/android-helper@0.35.9
  - @hot-updater/apple-helper@0.35.9
  - @hot-updater/console@0.35.9
  - @hot-updater/core@0.35.9
  - @hot-updater/server@0.35.9
  - @hot-updater/plugin-core@0.35.9

## 0.35.8

### Patch Changes

- Updated dependencies [4f9fab2]
  - @hot-updater/cli-tools@0.35.8
  - @hot-updater/android-helper@0.35.8
  - @hot-updater/apple-helper@0.35.8
  - @hot-updater/console@0.35.8
  - @hot-updater/core@0.35.8
  - @hot-updater/server@0.35.8
  - @hot-updater/plugin-core@0.35.8

## 0.35.7

### Patch Changes

- @hot-updater/android-helper@0.35.7
- @hot-updater/apple-helper@0.35.7
- @hot-updater/cli-tools@0.35.7
- @hot-updater/console@0.35.7
- @hot-updater/core@0.35.7
- @hot-updater/server@0.35.7
- @hot-updater/plugin-core@0.35.7

## 0.35.6

### Patch Changes

- @hot-updater/android-helper@0.35.6
- @hot-updater/apple-helper@0.35.6
- @hot-updater/cli-tools@0.35.6
- @hot-updater/console@0.35.6
- @hot-updater/core@0.35.6
- @hot-updater/server@0.35.6
- @hot-updater/plugin-core@0.35.6

## 0.35.5

### Patch Changes

- @hot-updater/android-helper@0.35.5
- @hot-updater/apple-helper@0.35.5
- @hot-updater/cli-tools@0.35.5
- @hot-updater/console@0.35.5
- @hot-updater/core@0.35.5
- @hot-updater/server@0.35.5
- @hot-updater/plugin-core@0.35.5

## 0.35.4

### Patch Changes

- @hot-updater/android-helper@0.35.4
- @hot-updater/apple-helper@0.35.4
- @hot-updater/cli-tools@0.35.4
- @hot-updater/console@0.35.4
- @hot-updater/core@0.35.4
- @hot-updater/server@0.35.4
- @hot-updater/plugin-core@0.35.4

## 0.35.3

### Patch Changes

- @hot-updater/android-helper@0.35.3
- @hot-updater/apple-helper@0.35.3
- @hot-updater/cli-tools@0.35.3
- @hot-updater/console@0.35.3
- @hot-updater/core@0.35.3
- @hot-updater/server@0.35.3
- @hot-updater/plugin-core@0.35.3

## 0.35.2

### Patch Changes

- e3f0962: Add bulk deletion to `hot-updater bundle delete`. The command now accepts multiple bundle ids (`bundle delete <id...>`)
  - @hot-updater/android-helper@0.35.2
  - @hot-updater/apple-helper@0.35.2
  - @hot-updater/cli-tools@0.35.2
  - @hot-updater/console@0.35.2
  - @hot-updater/core@0.35.2
  - @hot-updater/server@0.35.2
  - @hot-updater/plugin-core@0.35.2

## 0.35.1

### Patch Changes

- @hot-updater/android-helper@0.35.1
- @hot-updater/apple-helper@0.35.1
- @hot-updater/cli-tools@0.35.1
- @hot-updater/console@0.35.1
- @hot-updater/core@0.35.1
- @hot-updater/server@0.35.1
- @hot-updater/plugin-core@0.35.1

## 0.35.0

### Minor Changes

- 4e1b86d: Make the `@hot-updater/server` root export runtime-safe, remove the ambiguous `@hot-updater/server/runtime` subpath, keep `@hot-updater/server/node` focused on `toNodeHandler`, and move database generation, migration, and bundle diff APIs to `@hot-updater/server/db`.

### Patch Changes

- Updated dependencies [4e1b86d]
  - @hot-updater/server@0.35.0
  - @hot-updater/console@0.35.0
  - @hot-updater/android-helper@0.35.0
  - @hot-updater/apple-helper@0.35.0
  - @hot-updater/cli-tools@0.35.0
  - @hot-updater/core@0.35.0
  - @hot-updater/plugin-core@0.35.0

## 0.34.0

### Minor Changes

- 8a4a269: feat(hot-updater): add `--provider` and `--build` flags to `init`

  `hot-updater init` always prompts for the build plugin and the provider. These optional flags pre-answer those two prompts so `init` can run without interaction:

  ```
  hot-updater init --provider cloudflare --build expo
  ```

  When a flag is omitted, the prompt is shown as before. Values are validated against the known choices.

  This is aimed at the Cloudflare redeploy flow described in #849: with a populated `.env.hotupdater`, re-running `init` redeploys the worker and applies pending migrations, and these flags remove the two prompts that otherwise block it from running unattended. Providers still prompt for any value that is not already present in `.env.hotupdater`.

### Patch Changes

- 088f6c1: refactor(server): remove fumadb adapter split
- 7244b65: Fix standalone database generation for provider SQL output and generated schema regeneration, and centralize the generated DB schema artifact contract.
- Updated dependencies [088f6c1]
- Updated dependencies [7244b65]
  - @hot-updater/server@0.34.0
  - @hot-updater/plugin-core@0.34.0
  - @hot-updater/core@0.34.0
  - @hot-updater/console@0.34.0
  - @hot-updater/android-helper@0.34.0
  - @hot-updater/apple-helper@0.34.0
  - @hot-updater/cli-tools@0.34.0

## 0.33.2

### Patch Changes

- @hot-updater/android-helper@0.33.2
- @hot-updater/apple-helper@0.33.2
- @hot-updater/cli-tools@0.33.2
- @hot-updater/console@0.33.2
- @hot-updater/core@0.33.2
- @hot-updater/server@0.33.2
- @hot-updater/plugin-core@0.33.2

## 0.33.1

### Patch Changes

- Updated dependencies [a5c4467]
  - @hot-updater/console@0.33.1
  - @hot-updater/plugin-core@0.33.1
  - @hot-updater/server@0.33.1
  - @hot-updater/android-helper@0.33.1
  - @hot-updater/apple-helper@0.33.1
  - @hot-updater/cli-tools@0.33.1
  - @hot-updater/core@0.33.1

## 0.33.0

### Minor Changes

- 0eb4639: Unify doctor infrastructure update targets so runtime and migration requirements share one version target source.

### Patch Changes

- e914f56: Avoid redundant provider bundle reads during update checks and teach doctor to flag server runtime redeploy requirements.
- Updated dependencies [070a86f]
- Updated dependencies [e914f56]
- Updated dependencies [2b9944a]
  - @hot-updater/cli-tools@0.33.0
  - @hot-updater/server@0.33.0
  - @hot-updater/plugin-core@0.33.0
  - @hot-updater/console@0.33.0
  - @hot-updater/android-helper@0.33.0
  - @hot-updater/apple-helper@0.33.0
  - @hot-updater/core@0.33.0

## 0.32.0

### Patch Changes

- 4e6d2ec: Use deterministic content-addressed storage keys for manifest assets, require storage plugins to implement object existence checks, skip uploads when the object already exists, limit deploy upload concurrency, stream hashing/compression work to reduce memory pressure, and report upload progress through 100%.
- c6d10fc: fix(fingerprint): load `@expo/fingerprint` as an optional peer dependency for fingerprint commands
- 8e87b5f: Harden Supabase init by enabling RLS for Hot Updater tables, pinning
  Supabase function search paths, and generating service-role env naming while
  failing skipped legacy configs before writing the service-role env key.
- Updated dependencies [4e6d2ec]
- Updated dependencies [499e139]
  - @hot-updater/cli-tools@0.32.0
  - @hot-updater/console@0.32.0
  - @hot-updater/plugin-core@0.32.0
  - @hot-updater/server@0.32.0
  - @hot-updater/android-helper@0.32.0
  - @hot-updater/apple-helper@0.32.0
  - @hot-updater/core@0.32.0

## 0.31.4

### Patch Changes

- @hot-updater/android-helper@0.31.4
- @hot-updater/apple-helper@0.31.4
- @hot-updater/cli-tools@0.31.4
- @hot-updater/console@0.31.4
- @hot-updater/core@0.31.4
- @hot-updater/server@0.31.4
- @hot-updater/plugin-core@0.31.4

## 0.31.3

### Patch Changes

- d5d9c48: fix(hot-updater): match patch bases by semver compatibility
  - @hot-updater/android-helper@0.31.3
  - @hot-updater/apple-helper@0.31.3
  - @hot-updater/cli-tools@0.31.3
  - @hot-updater/console@0.31.3
  - @hot-updater/core@0.31.3
  - @hot-updater/server@0.31.3
  - @hot-updater/plugin-core@0.31.3

## 0.31.2

### Patch Changes

- fe365ef: Bundle CLI-only dependencies so Expo projects do not install a duplicate
  `@expo/fingerprint` through `hot-updater`.
- 0084a78: tree-shake sql-formatter dialects
  - @hot-updater/android-helper@0.31.2
  - @hot-updater/apple-helper@0.31.2
  - @hot-updater/cli-tools@0.31.2
  - @hot-updater/console@0.31.2
  - @hot-updater/core@0.31.2
  - @hot-updater/server@0.31.2
  - @hot-updater/plugin-core@0.31.2

## 0.31.1

### Patch Changes

- 8eb21d7: Check native OTA wiring in doctor
  - @hot-updater/android-helper@0.31.1
  - @hot-updater/apple-helper@0.31.1
  - @hot-updater/cli-tools@0.31.1
  - @hot-updater/console@0.31.1
  - @hot-updater/core@0.31.1
  - @hot-updater/server@0.31.1
  - @hot-updater/plugin-core@0.31.1

## 0.31.0

### Minor Changes

- 5b0a0f5: Add signed manifest-based diff update support across deploy, server, provider storage, console tooling, and React Native runtime.

### Patch Changes

- 5b0a0f5: Add CLI bundle inspection and metadata mutation commands for automation:
  `bundle show`, `bundle update`, and `bundle delete`.
- Updated dependencies [5b0a0f5]
- Updated dependencies [5b0a0f5]
  - @hot-updater/core@0.31.0
  - @hot-updater/console@0.31.0
  - @hot-updater/server@0.31.0
  - @hot-updater/android-helper@0.31.0
  - @hot-updater/cli-tools@0.31.0
  - @hot-updater/plugin-core@0.31.0
  - @hot-updater/apple-helper@0.31.0

## 0.30.12

### Patch Changes

- @hot-updater/android-helper@0.30.12
- @hot-updater/apple-helper@0.30.12
- @hot-updater/cli-tools@0.30.12
- @hot-updater/console@0.30.12
- @hot-updater/core@0.30.12
- @hot-updater/server@0.30.12
- @hot-updater/plugin-core@0.30.12

## 0.30.11

### Patch Changes

- eb32048: fix(cli): `deploy` falls back to the auto-detected target app version in non-interactive mode

  Previously, running `hot-updater deploy` without `-t` and without `-i` errored with
  "Target app version not found", even though `getDefaultTargetAppVersion` had already
  extracted the version from the binary's native files (Info.plist for iOS, build.gradle
  for Android) for use as the interactive prompt's placeholder. CI deploys had to
  either pass `-t` explicitly or scrape the version out of package.json.

  Now the resolution order is: explicit `-t` → interactive prompt (with the auto-detected
  value as placeholder) → auto-detected default → clear error if the native config is
  unreadable. Existing `-t` and `-i` invocations are unchanged.
  - @hot-updater/android-helper@0.30.11
  - @hot-updater/apple-helper@0.30.11
  - @hot-updater/cli-tools@0.30.11
  - @hot-updater/console@0.30.11
  - @hot-updater/core@0.30.11
  - @hot-updater/server@0.30.11
  - @hot-updater/plugin-core@0.30.11

## 0.30.10

### Patch Changes

- 677271a: feat(cli): `deploy` runs both platforms when `-p` is omitted

  `hot-updater deploy` (without `-p ios` or `-p android`) now deploys ios then android sequentially. If ios fails, android is not attempted — the channel is never left half-updated. This is the typical CI/CD invocation pattern.

  ```
  hot-updater deploy -c dev               # ios + android, sequential, abort-on-first-failure
  hot-updater deploy -p ios -c dev        # unchanged: single platform
  hot-updater deploy -i -c dev            # unchanged: interactive prompt for one platform
  ```

  Existing `-p ios` / `-p android` invocations are unchanged; `-i` (interactive) still prompts for a single platform. The change is purely in the no-`-p`-no-`-i` path, which previously errored with "Platform not found" — that error path is now the multi-platform deploy.

- fb780c1: feat(cli): add `bundle promote` command

  Move or copy a bundle to a different channel from the CLI, mirroring the console's Promote-to-Channel UI.

  ```
  hot-updater bundle promote <bundle-id> -t <target-channel> [-a copy|move] [-y]
  ```

  - The bundle id is positional — the bundle carries its own source channel, so no `--source` flag is needed.
  - `--action copy` (default) creates a new bundle id on the target channel and leaves the original in place — CodePush-promote semantics.
  - `--action move` updates the bundle's `channel` column without creating a new bundle (D1-only mutation; no R2 work).
  - Wraps the `promoteBundle` function from `@hot-updater/cli-tools`, so the CLI and console use one implementation. Surfaces the underlying `LEGACY_BUNDLE_ERROR` and signing/storage configuration errors directly.

  Pre-flight: rejects bundle-already-on-target, missing bundle id, empty target. Refuses to mutate without `-y` in a non-TTY shell. Lives under the `bundle` namespace alongside `bundle list/disable/enable` since the noun being mutated is the bundle (its channel attribute, or a copy of it).

- 014430a: fix(cli): make multi-platform deploy a first-class flow

  `hot-updater deploy` now handles the no-`-p` path inside the deploy command
  itself instead of looping from the CLI entrypoint. This keeps the banner and
  success output consistent, makes it explicit that iOS and Android are deployed
  sequentially, and writes local bundle archives to platform-specific output
  directories so one platform no longer overwrites the other.
  - @hot-updater/android-helper@0.30.10
  - @hot-updater/apple-helper@0.30.10
  - @hot-updater/cli-tools@0.30.10
  - @hot-updater/console@0.30.10
  - @hot-updater/core@0.30.10
  - @hot-updater/server@0.30.10
  - @hot-updater/plugin-core@0.30.10

## 0.30.9

### Patch Changes

- @hot-updater/android-helper@0.30.9
- @hot-updater/apple-helper@0.30.9
- @hot-updater/cli-tools@0.30.9
- @hot-updater/console@0.30.9
- @hot-updater/core@0.30.9
- @hot-updater/server@0.30.9
- @hot-updater/plugin-core@0.30.9

## 0.30.8

### Patch Changes

- 655b97c: feat(cli): add `bundle list/disable/enable` commands

  Adds three subcommands under a new top-level `bundle` namespace:
  - `hot-updater bundle list [-c <channel>] [-p <ios|android>] [--limit <n>]` — tabulated listing of bundles, most recent first. `--limit` validation uses commander's idiomatic `InvalidArgumentError` shape.
  - `hot-updater bundle disable <bundle-id> [-y]` — disable a single bundle. Refuses to mutate without `-y` in a non-TTY shell. Re-reads the bundle after `commitBundle` and exits non-zero if the change did not take effect; treats a mid-flight deletion as success.
  - `hot-updater bundle enable <bundle-id> [-y]` — re-enable a previously disabled bundle.

  All three commands load config via `loadConfig(null)` (matching the `console` command's idiom) since they are not platform-scoped operations. They use the existing `DatabasePlugin` interface (`getBundles`, `getBundleById`, `updateBundle`, `commitBundle`), so they work against every supported provider with no plugin-side changes. The `--platform` option is the shared `platformCommandOption` already used by `deploy`. `onUnmount` is wrapped in its own try/catch so cleanup errors never mask the originating mutation error. Help text documents the read-mutate-verify contract and exit codes (0 = success, 1 = error, 2 = user-aborted).

- 8318094: feat(cli): add `rollback <channel>` command

  Disables the most recent enabled bundle on a channel for each requested platform.

  ```
  hot-updater rollback <channel> [-p ios|android] [-y] [--confirm-revert-to-binary] [--target <bundle-id>]
  ```

  Behavior:
  - **Read phase** loads up to two most-recent enabled bundles per (channel, platform) so the operator can see what would become active after rollback.
  - **Validate phase** refuses with non-zero exit if any (channel, platform) would have **no** enabled bundles after the rollback unless `--confirm-revert-to-binary` is passed. The error message names both safe escape hatches in priority order: `-p <unaffected>` first, then `--confirm-revert-to-binary`.
  - **Mutate phase** queues `updateBundle({ enabled: false })` for each target and commits once. Note: `DatabasePlugin.commitBundle` runs ops sequentially in the underlying provider, so atomicity across platforms is **not** guaranteed. The mutate is wrapped in a try/catch so a mid-commit throw still falls through to the verify phase.
  - **Verify phase** re-reads each target. Distinguishes three states — disabled (success), still-enabled (failure), and gone (success: a deleted bundle satisfies the rollback intent). Surfaces partial-failure state explicitly with non-zero exit and per-platform `FAILED` lines naming the exact retry command, including a `--target <bundle-id>` flag for scoped retry.

  Refuses to mutate without `-y` in a non-TTY shell. `onUnmount` is wrapped in its own try/catch so cleanup errors never mask the originating mutation error. Help text documents the four-phase contract and exit codes (0 = success, 1 = error, 2 = user-aborted).

- deff7ab: feat(cli): cli design system
- 8318094: Feature - CLI Rollback
- Updated dependencies [6019156]
  - @hot-updater/cli-tools@0.30.8
  - @hot-updater/plugin-core@0.30.8
  - @hot-updater/console@0.30.8
  - @hot-updater/android-helper@0.30.8
  - @hot-updater/apple-helper@0.30.8
  - @hot-updater/server@0.30.8
  - @hot-updater/core@0.30.8

## 0.30.7

### Patch Changes

- 03fd179: Run the `hot-updater` CLI from native ESM on Node 20 so TypeScript config
  files load through ESM import conditions.

  Require Node.js 20.19.0 or newer for the CLI package surface.

  Run the `hot-updater` CLI bin from the native ESM entrypoint and stop emitting
  a CommonJS build for the CLI entry.

  Bump the `hot-updater` CLI package's vulnerable `kysely` and
  `fast-xml-parser` dependency entries to patched versions without pnpm
  overrides.

- Updated dependencies [03fd179]
  - @hot-updater/apple-helper@0.30.7
  - @hot-updater/cli-tools@0.30.7
  - @hot-updater/android-helper@0.30.7
  - @hot-updater/console@0.30.7
  - @hot-updater/core@0.30.7
  - @hot-updater/server@0.30.7
  - @hot-updater/plugin-core@0.30.7

## 0.30.6

### Patch Changes

- 82de1c6: fix(deps): widen `@expo/fingerprint` to caret range to allow dedupe with Expo SDK
  - @hot-updater/android-helper@0.30.6
  - @hot-updater/apple-helper@0.30.6
  - @hot-updater/cli-tools@0.30.6
  - @hot-updater/console@0.30.6
  - @hot-updater/core@0.30.6
  - @hot-updater/server@0.30.6
  - @hot-updater/plugin-core@0.30.6

## 0.30.5

### Patch Changes

- @hot-updater/android-helper@0.30.5
- @hot-updater/apple-helper@0.30.5
- @hot-updater/cli-tools@0.30.5
- @hot-updater/console@0.30.5
- @hot-updater/core@0.30.5
- @hot-updater/server@0.30.5
- @hot-updater/plugin-core@0.30.5

## 0.30.4

### Patch Changes

- @hot-updater/android-helper@0.30.4
- @hot-updater/apple-helper@0.30.4
- @hot-updater/cli-tools@0.30.4
- @hot-updater/console@0.30.4
- @hot-updater/core@0.30.4
- @hot-updater/server@0.30.4
- @hot-updater/plugin-core@0.30.4

## 0.30.3

### Patch Changes

- @hot-updater/android-helper@0.30.3
- @hot-updater/apple-helper@0.30.3
- @hot-updater/cli-tools@0.30.3
- @hot-updater/console@0.30.3
- @hot-updater/core@0.30.3
- @hot-updater/server@0.30.3
- @hot-updater/plugin-core@0.30.3

## 0.30.2

### Patch Changes

- @hot-updater/android-helper@0.30.2
- @hot-updater/apple-helper@0.30.2
- @hot-updater/cli-tools@0.30.2
- @hot-updater/console@0.30.2
- @hot-updater/core@0.30.2
- @hot-updater/server@0.30.2
- @hot-updater/plugin-core@0.30.2

## 0.30.1

### Patch Changes

- 5a7cb26: feat(cli): check infra in hot-updater doctor
- Updated dependencies [35b8720]
  - @hot-updater/console@0.30.1
  - @hot-updater/android-helper@0.30.1
  - @hot-updater/apple-helper@0.30.1
  - @hot-updater/cli-tools@0.30.1
  - @hot-updater/core@0.30.1
  - @hot-updater/server@0.30.1
  - @hot-updater/plugin-core@0.30.1

## 0.30.0

### Minor Changes

- 83c01c8: fix: keep target cohorts additive to rollout

### Patch Changes

- Updated dependencies [83c01c8]
  - @hot-updater/console@0.30.0
  - @hot-updater/server@0.30.0
  - @hot-updater/core@0.30.0
  - @hot-updater/android-helper@0.30.0
  - @hot-updater/apple-helper@0.30.0
  - @hot-updater/cli-tools@0.30.0
  - @hot-updater/plugin-core@0.30.0

## 0.29.8

### Patch Changes

- Updated dependencies [28e14aa]
  - @hot-updater/console@0.29.8
  - @hot-updater/android-helper@0.29.8
  - @hot-updater/apple-helper@0.29.8
  - @hot-updater/cli-tools@0.29.8
  - @hot-updater/core@0.29.8
  - @hot-updater/server@0.29.8
  - @hot-updater/plugin-core@0.29.8

## 0.29.7

### Patch Changes

- @hot-updater/android-helper@0.29.7
- @hot-updater/apple-helper@0.29.7
- @hot-updater/cli-tools@0.29.7
- @hot-updater/console@0.29.7
- @hot-updater/core@0.29.7
- @hot-updater/server@0.29.7
- @hot-updater/plugin-core@0.29.7

## 0.29.6

### Patch Changes

- 5a2d37c: Fix the local `fix-ci` runner so the integration step finishes cleanly after
  background emulator processes exit.
- Updated dependencies [80cce61]
  - @hot-updater/cli-tools@0.29.6
  - @hot-updater/android-helper@0.29.6
  - @hot-updater/apple-helper@0.29.6
  - @hot-updater/console@0.29.6
  - @hot-updater/core@0.29.6
  - @hot-updater/server@0.29.6
  - @hot-updater/plugin-core@0.29.6

## 0.29.5

### Patch Changes

- Updated dependencies [52208f4]
  - @hot-updater/server@0.29.5
  - @hot-updater/plugin-core@0.29.5
  - @hot-updater/android-helper@0.29.5
  - @hot-updater/apple-helper@0.29.5
  - @hot-updater/cli-tools@0.29.5
  - @hot-updater/console@0.29.5
  - @hot-updater/core@0.29.5

## 0.29.4

### Patch Changes

- @hot-updater/android-helper@0.29.4
- @hot-updater/apple-helper@0.29.4
- @hot-updater/cli-tools@0.29.4
- @hot-updater/console@0.29.4
- @hot-updater/core@0.29.4
- @hot-updater/server@0.29.4
- @hot-updater/plugin-core@0.29.4

## 0.29.3

### Patch Changes

- ca2e17d: refactor(cli): deploy log align print
- Updated dependencies [d1ffb83]
  - @hot-updater/plugin-core@0.29.3
  - @hot-updater/console@0.29.3
  - @hot-updater/server@0.29.3
  - @hot-updater/android-helper@0.29.3
  - @hot-updater/apple-helper@0.29.3
  - @hot-updater/cli-tools@0.29.3
  - @hot-updater/core@0.29.3

## 0.29.2

### Patch Changes

- 2a1bc80: fix: node deps bundling
- Updated dependencies [2a1bc80]
  - @hot-updater/cli-tools@0.29.2
  - @hot-updater/core@0.29.2
  - @hot-updater/server@0.29.2
  - @hot-updater/plugin-core@0.29.2
  - @hot-updater/android-helper@0.29.2
  - @hot-updater/apple-helper@0.29.2
  - @hot-updater/console@0.29.2

## 0.29.1

### Patch Changes

- @hot-updater/android-helper@0.29.1
- @hot-updater/apple-helper@0.29.1
- @hot-updater/cli-tools@0.29.1
- @hot-updater/console@0.29.1
- @hot-updater/core@0.29.1
- @hot-updater/server@0.29.1
- @hot-updater/plugin-core@0.29.1

## 0.29.0

### Minor Changes

- a935992: feat: Rollout feature with control from 1% to 100%

### Patch Changes

- d0fe908: fix(console): rebuild copied bundles with fresh uuidv7 ids
- Updated dependencies [a935992]
- Updated dependencies [d0fe908]
- Updated dependencies [a935992]
  - @hot-updater/plugin-core@0.29.0
  - @hot-updater/cli-tools@0.29.0
  - @hot-updater/console@0.29.0
  - @hot-updater/server@0.29.0
  - @hot-updater/core@0.29.0
  - @hot-updater/android-helper@0.29.0
  - @hot-updater/apple-helper@0.29.0

## 0.28.0

### Patch Changes

- @hot-updater/android-helper@0.28.0
- @hot-updater/apple-helper@0.28.0
- @hot-updater/cli-tools@0.28.0
- @hot-updater/console@0.28.0
- @hot-updater/core@0.28.0
- @hot-updater/server@0.28.0
- @hot-updater/plugin-core@0.28.0

## 0.27.1

### Patch Changes

- @hot-updater/server@0.27.1
- @hot-updater/android-helper@0.27.1
- @hot-updater/apple-helper@0.27.1
- @hot-updater/cli-tools@0.27.1
- @hot-updater/console@0.27.1
- @hot-updater/core@0.27.1
- @hot-updater/plugin-core@0.27.1

## 0.27.0

### Minor Changes

- 81f9437: feat(android): for safe reloading, Android reloads the process (#869)

### Patch Changes

- Updated dependencies [81f9437]
  - @hot-updater/android-helper@0.27.0
  - @hot-updater/apple-helper@0.27.0
  - @hot-updater/cli-tools@0.27.0
  - @hot-updater/console@0.27.0
  - @hot-updater/core@0.27.0
  - @hot-updater/server@0.27.0
  - @hot-updater/plugin-core@0.27.0

## 0.26.2

### Patch Changes

- @hot-updater/server@0.26.2
- @hot-updater/android-helper@0.26.2
- @hot-updater/apple-helper@0.26.2
- @hot-updater/cli-tools@0.26.2
- @hot-updater/console@0.26.2
- @hot-updater/core@0.26.2
- @hot-updater/plugin-core@0.26.2

## 0.26.1

### Patch Changes

- @hot-updater/android-helper@0.26.1
- @hot-updater/apple-helper@0.26.1
- @hot-updater/cli-tools@0.26.1
- @hot-updater/console@0.26.1
- @hot-updater/core@0.26.1
- @hot-updater/server@0.26.1
- @hot-updater/plugin-core@0.26.1

## 0.26.0

### Patch Changes

- @hot-updater/android-helper@0.26.0
- @hot-updater/apple-helper@0.26.0
- @hot-updater/cli-tools@0.26.0
- @hot-updater/console@0.26.0
- @hot-updater/core@0.26.0
- @hot-updater/server@0.26.0
- @hot-updater/plugin-core@0.26.0

## 0.25.14

### Patch Changes

- @hot-updater/server@0.25.14
- @hot-updater/android-helper@0.25.14
- @hot-updater/apple-helper@0.25.14
- @hot-updater/cli-tools@0.25.14
- @hot-updater/console@0.25.14
- @hot-updater/core@0.25.14
- @hot-updater/plugin-core@0.25.14

## 0.25.13

### Patch Changes

- 169b019: chore: bump fast-xml-parser
- Updated dependencies [169b019]
  - @hot-updater/apple-helper@0.25.13
  - @hot-updater/android-helper@0.25.13
  - @hot-updater/cli-tools@0.25.13
  - @hot-updater/console@0.25.13
  - @hot-updater/core@0.25.13
  - @hot-updater/server@0.25.13
  - @hot-updater/plugin-core@0.25.13

## 0.25.12

### Patch Changes

- 38b2af0: fix(expo): android template SDK 55
  - @hot-updater/android-helper@0.25.12
  - @hot-updater/apple-helper@0.25.12
  - @hot-updater/cli-tools@0.25.12
  - @hot-updater/console@0.25.12
  - @hot-updater/core@0.25.12
  - @hot-updater/server@0.25.12
  - @hot-updater/plugin-core@0.25.12

## 0.25.11

### Patch Changes

- @hot-updater/android-helper@0.25.11
- @hot-updater/apple-helper@0.25.11
- @hot-updater/cli-tools@0.25.11
- @hot-updater/console@0.25.11
- @hot-updater/core@0.25.11
- @hot-updater/server@0.25.11
- @hot-updater/plugin-core@0.25.11

## 0.25.10

### Patch Changes

- Updated dependencies [90f9610]
- Updated dependencies [03c5adc]
  - @hot-updater/android-helper@0.25.10
  - @hot-updater/apple-helper@0.25.10
  - @hot-updater/cli-tools@0.25.10
  - @hot-updater/plugin-core@0.25.10
  - @hot-updater/console@0.25.10
  - @hot-updater/server@0.25.10
  - @hot-updater/core@0.25.10

## 0.25.9

### Patch Changes

- 6b22072: Change the default value of `podInstalls` option in iOS native build scheme to `false`
- Updated dependencies [6b22072]
  - @hot-updater/apple-helper@0.25.9
  - @hot-updater/plugin-core@0.25.9
  - @hot-updater/android-helper@0.25.9
  - @hot-updater/cli-tools@0.25.9
  - @hot-updater/console@0.25.9
  - @hot-updater/server@0.25.9
  - @hot-updater/core@0.25.9

## 0.25.8

### Patch Changes

- @hot-updater/android-helper@0.25.8
- @hot-updater/apple-helper@0.25.8
- @hot-updater/cli-tools@0.25.8
- @hot-updater/console@0.25.8
- @hot-updater/core@0.25.8
- @hot-updater/server@0.25.8
- @hot-updater/plugin-core@0.25.8

## 0.25.7

### Patch Changes

- @hot-updater/android-helper@0.25.7
- @hot-updater/apple-helper@0.25.7
- @hot-updater/cli-tools@0.25.7
- @hot-updater/console@0.25.7
- @hot-updater/core@0.25.7
- @hot-updater/server@0.25.7
- @hot-updater/plugin-core@0.25.7

## 0.25.6

### Patch Changes

- c7a0cc5: fix(cli): even though "provider: 'mysql'" is configured, the error still shows the dialect as postgresql
  - @hot-updater/android-helper@0.25.6
  - @hot-updater/apple-helper@0.25.6
  - @hot-updater/cli-tools@0.25.6
  - @hot-updater/console@0.25.6
  - @hot-updater/core@0.25.6
  - @hot-updater/server@0.25.6
  - @hot-updater/plugin-core@0.25.6

## 0.25.5

### Patch Changes

- 8041bab: fix(cli): function parse$4 expects an xml, but some inputs come as binary as well
  - @hot-updater/android-helper@0.25.5
  - @hot-updater/apple-helper@0.25.5
  - @hot-updater/cli-tools@0.25.5
  - @hot-updater/console@0.25.5
  - @hot-updater/core@0.25.5
  - @hot-updater/server@0.25.5
  - @hot-updater/plugin-core@0.25.5

## 0.25.4

### Patch Changes

- Updated dependencies [8c83ff2]
  - @hot-updater/cli-tools@0.25.4
  - @hot-updater/console@0.25.4
  - @hot-updater/server@0.25.4
  - @hot-updater/core@0.25.4
  - @hot-updater/plugin-core@0.25.4

## 0.25.3

### Patch Changes

- cddc20f: feat: add critical conflict check for expo-updates
  - @hot-updater/cli-tools@0.25.3
  - @hot-updater/console@0.25.3
  - @hot-updater/core@0.25.3
  - @hot-updater/server@0.25.3
  - @hot-updater/plugin-core@0.25.3

## 0.25.2

### Patch Changes

- @hot-updater/cli-tools@0.25.2
- @hot-updater/console@0.25.2
- @hot-updater/core@0.25.2
- @hot-updater/server@0.25.2
- @hot-updater/plugin-core@0.25.2

## 0.25.1

### Patch Changes

- @hot-updater/cli-tools@0.25.1
- @hot-updater/console@0.25.1
- @hot-updater/core@0.25.1
- @hot-updater/server@0.25.1
- @hot-updater/plugin-core@0.25.1

## 0.25.0

### Minor Changes

- d22b48a: feat(expo): expo 'use dom' correct ota update

### Patch Changes

- @hot-updater/cli-tools@0.25.0
- @hot-updater/console@0.25.0
- @hot-updater/core@0.25.0
- @hot-updater/server@0.25.0
- @hot-updater/plugin-core@0.25.0

## 0.24.7

### Patch Changes

- 294e324: fix: update babel plugin path in documentation and plugin files
- Updated dependencies [294e324]
  - @hot-updater/cli-tools@0.24.7
  - @hot-updater/console@0.24.7
  - @hot-updater/core@0.24.7
  - @hot-updater/server@0.24.7
  - @hot-updater/plugin-core@0.24.7

## 0.24.6

### Patch Changes

- 9d7b6af: feat(aws): sso template with fromSSO
- 962ecdd: fix(expo): fingerprint autolinking for expo
- Updated dependencies [9d7b6af]
  - @hot-updater/cli-tools@0.24.6
  - @hot-updater/console@0.24.6
  - @hot-updater/server@0.24.6
  - @hot-updater/core@0.24.6
  - @hot-updater/plugin-core@0.24.6

## 0.24.5

### Patch Changes

- f755c3c: Add build\* to default fingerprint ignore paths
  - @hot-updater/cli-tools@0.24.5
  - @hot-updater/console@0.24.5
  - @hot-updater/core@0.24.5
  - @hot-updater/server@0.24.5
  - @hot-updater/plugin-core@0.24.5

## 0.24.4

### Patch Changes

- Updated dependencies [7ed539f]
  - @hot-updater/plugin-core@0.24.4
  - @hot-updater/cli-tools@0.24.4
  - @hot-updater/console@0.24.4
  - @hot-updater/server@0.24.4
  - @hot-updater/core@0.24.4

## 0.24.3

### Patch Changes

- @hot-updater/cli-tools@0.24.3
- @hot-updater/console@0.24.3
- @hot-updater/core@0.24.3
- @hot-updater/server@0.24.3
- @hot-updater/plugin-core@0.24.3

## 0.24.2

### Patch Changes

- @hot-updater/cli-tools@0.24.2
- @hot-updater/console@0.24.2
- @hot-updater/core@0.24.2
- @hot-updater/server@0.24.2
- @hot-updater/plugin-core@0.24.2

## 0.24.1

### Patch Changes

- @hot-updater/cli-tools@0.24.1
- @hot-updater/console@0.24.1
- @hot-updater/core@0.24.1
- @hot-updater/server@0.24.1
- @hot-updater/plugin-core@0.24.1

## 0.24.0

### Patch Changes

- @hot-updater/cli-tools@0.24.0
- @hot-updater/console@0.24.0
- @hot-updater/core@0.24.0
- @hot-updater/server@0.24.0
- @hot-updater/plugin-core@0.24.0

## 0.23.1

### Patch Changes

- 7fa9a20: feat(expo): bundle-signing supports cng plugin
  - @hot-updater/cli-tools@0.23.1
  - @hot-updater/console@0.23.1
  - @hot-updater/core@0.23.1
  - @hot-updater/server@0.23.1
  - @hot-updater/plugin-core@0.23.1

## 0.23.0

### Minor Changes

- e41fb6b: feat: add bundle signing for cryptographic OTA verification

### Patch Changes

- Updated dependencies [e41fb6b]
  - @hot-updater/core@0.23.0
  - @hot-updater/console@0.23.0
  - @hot-updater/server@0.23.0
  - @hot-updater/plugin-core@0.23.0
  - @hot-updater/cli-tools@0.23.0

## 0.22.2

### Patch Changes

- @hot-updater/cli-tools@0.22.2
- @hot-updater/console@0.22.2
- @hot-updater/core@0.22.2
- @hot-updater/server@0.22.2
- @hot-updater/aws@0.22.2
- @hot-updater/cloudflare@0.22.2
- @hot-updater/firebase@0.22.2
- @hot-updater/plugin-core@0.22.2
- @hot-updater/supabase@0.22.2

## 0.22.1

### Patch Changes

- Updated dependencies [422bf89]
  - @hot-updater/console@0.22.1
  - @hot-updater/cli-tools@0.22.1
  - @hot-updater/core@0.22.1
  - @hot-updater/server@0.22.1
  - @hot-updater/aws@0.22.1
  - @hot-updater/cloudflare@0.22.1
  - @hot-updater/firebase@0.22.1
  - @hot-updater/plugin-core@0.22.1
  - @hot-updater/supabase@0.22.1

## 0.22.0

### Patch Changes

- Updated dependencies [32ad614]
  - @hot-updater/server@0.22.0
  - @hot-updater/cli-tools@0.22.0
  - @hot-updater/console@0.22.0
  - @hot-updater/core@0.22.0
  - @hot-updater/aws@0.22.0
  - @hot-updater/cloudflare@0.22.0
  - @hot-updater/firebase@0.22.0
  - @hot-updater/plugin-core@0.22.0
  - @hot-updater/supabase@0.22.0

## 0.21.15

### Patch Changes

- Updated dependencies [a169f06]
  - @hot-updater/server@0.21.15
  - @hot-updater/cli-tools@0.21.15
  - @hot-updater/aws@0.21.15
  - @hot-updater/cloudflare@0.21.15
  - @hot-updater/firebase@0.21.15
  - @hot-updater/plugin-core@0.21.15
  - @hot-updater/console@0.21.15
  - @hot-updater/core@0.21.15
  - @hot-updater/supabase@0.21.15

## 0.21.14

### Patch Changes

- @hot-updater/cli-tools@0.21.14
- @hot-updater/console@0.21.14
- @hot-updater/core@0.21.14
- @hot-updater/server@0.21.14
- @hot-updater/aws@0.21.14
- @hot-updater/cloudflare@0.21.14
- @hot-updater/firebase@0.21.14
- @hot-updater/plugin-core@0.21.14
- @hot-updater/supabase@0.21.14

## 0.21.13

### Patch Changes

- 44f4e95: Fix processing of directory glob patterns on extraSources
  - @hot-updater/cli-tools@0.21.13
  - @hot-updater/console@0.21.13
  - @hot-updater/core@0.21.13
  - @hot-updater/server@0.21.13
  - @hot-updater/aws@0.21.13
  - @hot-updater/cloudflare@0.21.13
  - @hot-updater/firebase@0.21.13
  - @hot-updater/plugin-core@0.21.13
  - @hot-updater/supabase@0.21.13

## 0.21.12

### Patch Changes

- 56e849b: chore(server): storagePlugins to storages
- Updated dependencies [56e849b]
- Updated dependencies [5c4b98e]
  - @hot-updater/server@0.21.12
  - @hot-updater/plugin-core@0.21.12
  - @hot-updater/cloudflare@0.21.12
  - @hot-updater/firebase@0.21.12
  - @hot-updater/supabase@0.21.12
  - @hot-updater/aws@0.21.12
  - @hot-updater/cli-tools@0.21.12
  - @hot-updater/console@0.21.12
  - @hot-updater/core@0.21.12

## 0.21.11

### Patch Changes

- e2b67d7: fix(cli-tools): esm only package bundle
- 2905e47: feat(server): supports hot-updater database plugin style
- Updated dependencies [d6c3a65]
- Updated dependencies [7ee2830]
- Updated dependencies [e2b67d7]
- Updated dependencies [2905e47]
  - @hot-updater/cli-tools@0.21.11
  - @hot-updater/server@0.21.11
  - @hot-updater/console@0.21.11
  - @hot-updater/core@0.21.11
  - @hot-updater/aws@0.21.11
  - @hot-updater/cloudflare@0.21.11
  - @hot-updater/firebase@0.21.11
  - @hot-updater/plugin-core@0.21.11
  - @hot-updater/supabase@0.21.11

## 0.21.10

### Patch Changes

- Updated dependencies [5289b17]
  - @hot-updater/server@0.21.10
  - @hot-updater/cli-tools@0.21.10
  - @hot-updater/aws@0.21.10
  - @hot-updater/cloudflare@0.21.10
  - @hot-updater/firebase@0.21.10
  - @hot-updater/plugin-core@0.21.10
  - @hot-updater/console@0.21.10
  - @hot-updater/core@0.21.10
  - @hot-updater/supabase@0.21.10

## 0.21.9

### Patch Changes

- 396ae54: feat(cli): db generate --sql create only sql
- aa399a6: chore: deps picocolors
- Updated dependencies [aa399a6]
  - @hot-updater/plugin-core@0.21.9
  - @hot-updater/cli-tools@0.21.9
  - @hot-updater/console@0.21.9
  - @hot-updater/server@0.21.9
  - @hot-updater/aws@0.21.9
  - @hot-updater/cloudflare@0.21.9
  - @hot-updater/firebase@0.21.9
  - @hot-updater/supabase@0.21.9
  - @hot-updater/core@0.21.9

## 0.21.8

### Patch Changes

- 3fe8c81: feat(plugin-core): reduced deps for edge-runtime
- Updated dependencies [3fe8c81]
  - @hot-updater/plugin-core@0.21.8
  - @hot-updater/cli-tools@0.21.8
  - @hot-updater/cloudflare@0.21.8
  - @hot-updater/firebase@0.21.8
  - @hot-updater/aws@0.21.8
  - @hot-updater/console@0.21.8
  - @hot-updater/supabase@0.21.8
  - @hot-updater/core@0.21.8

## 0.21.7

### Patch Changes

- Updated dependencies [2b408f2]
  - @hot-updater/plugin-core@0.21.7
  - @hot-updater/cloudflare@0.21.7
  - @hot-updater/firebase@0.21.7
  - @hot-updater/supabase@0.21.7
  - @hot-updater/aws@0.21.7
  - @hot-updater/console@0.21.7
  - @hot-updater/core@0.21.7

## 0.21.6

### Patch Changes

- b12394d: feat(cli): create migration sql hot-updater generate-db
  - @hot-updater/console@0.21.6
  - @hot-updater/core@0.21.6
  - @hot-updater/aws@0.21.6
  - @hot-updater/cloudflare@0.21.6
  - @hot-updater/firebase@0.21.6
  - @hot-updater/plugin-core@0.21.6
  - @hot-updater/supabase@0.21.6

## 0.21.5

### Patch Changes

- fc2bd56: feat: Add disabled option to deploy command
- a253498: chore(cli): replace es-git with native Git commands
  - @hot-updater/console@0.21.5
  - @hot-updater/core@0.21.5
  - @hot-updater/aws@0.21.5
  - @hot-updater/cloudflare@0.21.5
  - @hot-updater/firebase@0.21.5
  - @hot-updater/plugin-core@0.21.5
  - @hot-updater/supabase@0.21.5

## 0.21.4

### Patch Changes

- Updated dependencies [5d3070a]
  - @hot-updater/plugin-core@0.21.4
  - @hot-updater/aws@0.21.4
  - @hot-updater/cloudflare@0.21.4
  - @hot-updater/firebase@0.21.4
  - @hot-updater/console@0.21.4
  - @hot-updater/supabase@0.21.4
  - @hot-updater/core@0.21.4

## 0.21.3

### Patch Changes

- @hot-updater/console@0.21.3
- @hot-updater/core@0.21.3
- @hot-updater/aws@0.21.3
- @hot-updater/cloudflare@0.21.3
- @hot-updater/firebase@0.21.3
- @hot-updater/plugin-core@0.21.3
- @hot-updater/supabase@0.21.3

## 0.21.2

### Patch Changes

- Updated dependencies [b72da6e]
  - @hot-updater/firebase@0.21.2
  - @hot-updater/console@0.21.2
  - @hot-updater/core@0.21.2
  - @hot-updater/aws@0.21.2
  - @hot-updater/cloudflare@0.21.2
  - @hot-updater/plugin-core@0.21.2
  - @hot-updater/supabase@0.21.2

## 0.21.1

### Patch Changes

- Updated dependencies [7b7bc48]
  - @hot-updater/plugin-core@0.21.1
  - @hot-updater/console@0.21.1
  - @hot-updater/aws@0.21.1
  - @hot-updater/cloudflare@0.21.1
  - @hot-updater/firebase@0.21.1
  - @hot-updater/supabase@0.21.1
  - @hot-updater/core@0.21.1

## 0.22.0

### Minor Changes

- 610b2dd: feat: supports `compressStrategy` => `tar.br` (brotli) / `tar.gz` (gzip)
- 036f8f0: feat: support `@hot-updater/server` for self-hosted (WIP)

### Patch Changes

- Updated dependencies [610b2dd]
- Updated dependencies [afb084b]
- Updated dependencies [036f8f0]
  - @hot-updater/plugin-core@0.22.0
  - @hot-updater/cloudflare@0.22.0
  - @hot-updater/firebase@0.22.0
  - @hot-updater/supabase@0.22.0
  - @hot-updater/aws@0.22.0
  - @hot-updater/console@0.22.0
  - @hot-updater/core@0.22.0

## 0.20.15

### Patch Changes

- Updated dependencies [526a5ba]
- Updated dependencies [ddf6f2c]
  - @hot-updater/plugin-core@0.20.15
  - @hot-updater/console@0.20.15
  - @hot-updater/aws@0.20.15
  - @hot-updater/cloudflare@0.20.15
  - @hot-updater/firebase@0.20.15
  - @hot-updater/supabase@0.20.15
  - @hot-updater/core@0.20.15

## 0.20.14

### Patch Changes

- Updated dependencies [a61fa0e]
  - @hot-updater/plugin-core@0.20.14
  - @hot-updater/aws@0.20.14
  - @hot-updater/console@0.20.14
  - @hot-updater/cloudflare@0.20.14
  - @hot-updater/firebase@0.20.14
  - @hot-updater/supabase@0.20.14
  - @hot-updater/core@0.20.14

## 0.20.13

### Patch Changes

- @hot-updater/console@0.20.13
- @hot-updater/core@0.20.13
- @hot-updater/aws@0.20.13
- @hot-updater/cloudflare@0.20.13
- @hot-updater/firebase@0.20.13
- @hot-updater/plugin-core@0.20.13
- @hot-updater/supabase@0.20.13

## 0.20.12

### Patch Changes

- @hot-updater/console@0.20.12
- @hot-updater/core@0.20.12
- @hot-updater/aws@0.20.12
- @hot-updater/cloudflare@0.20.12
- @hot-updater/firebase@0.20.12
- @hot-updater/plugin-core@0.20.12
- @hot-updater/supabase@0.20.12

## 0.20.11

### Patch Changes

- afb3a6e: fix(fingerprint): separate fingerprint generation for cng
- cb9c05b: feat(fingerprint): bring back ignorePaths
- Updated dependencies [cb9c05b]
  - @hot-updater/plugin-core@0.20.11
  - @hot-updater/console@0.20.11
  - @hot-updater/aws@0.20.11
  - @hot-updater/cloudflare@0.20.11
  - @hot-updater/firebase@0.20.11
  - @hot-updater/supabase@0.20.11
  - @hot-updater/core@0.20.11

## 0.20.10

### Patch Changes

- 6b5435c: Ignore android/ios folder changes in fingerprint to avoid mismatch after prebuild
  - @hot-updater/console@0.20.10
  - @hot-updater/core@0.20.10
  - @hot-updater/aws@0.20.10
  - @hot-updater/cloudflare@0.20.10
  - @hot-updater/firebase@0.20.10
  - @hot-updater/plugin-core@0.20.10
  - @hot-updater/supabase@0.20.10

## 0.20.9

### Patch Changes

- Updated dependencies [5cbea75]
  - @hot-updater/cloudflare@0.20.9
  - @hot-updater/console@0.20.9
  - @hot-updater/core@0.20.9
  - @hot-updater/aws@0.20.9
  - @hot-updater/firebase@0.20.9
  - @hot-updater/plugin-core@0.20.9
  - @hot-updater/supabase@0.20.9

## 0.20.8

### Patch Changes

- ad7c999: feat(fingerprint): calculate OTA fingerprint only in native module
- Updated dependencies [ad7c999]
  - @hot-updater/plugin-core@0.20.8
  - @hot-updater/console@0.20.8
  - @hot-updater/aws@0.20.8
  - @hot-updater/cloudflare@0.20.8
  - @hot-updater/firebase@0.20.8
  - @hot-updater/supabase@0.20.8
  - @hot-updater/core@0.20.8

## 0.20.7

### Patch Changes

- a92992c: chore(tsdown): failOnWarn true
- Updated dependencies [a92992c]
  - @hot-updater/plugin-core@0.20.7
  - @hot-updater/cloudflare@0.20.7
  - @hot-updater/console@0.20.7
  - @hot-updater/firebase@0.20.7
  - @hot-updater/supabase@0.20.7
  - @hot-updater/core@0.20.7
  - @hot-updater/aws@0.20.7

## 0.20.6

### Patch Changes

- Updated dependencies [6a905d8]
  - @hot-updater/plugin-core@0.20.6
  - @hot-updater/console@0.20.6
  - @hot-updater/aws@0.20.6
  - @hot-updater/cloudflare@0.20.6
  - @hot-updater/firebase@0.20.6
  - @hot-updater/supabase@0.20.6
  - @hot-updater/core@0.20.6

## 0.20.5

### Patch Changes

- @hot-updater/console@0.20.5
- @hot-updater/core@0.20.5
- @hot-updater/aws@0.20.5
- @hot-updater/cloudflare@0.20.5
- @hot-updater/firebase@0.20.5
- @hot-updater/plugin-core@0.20.5
- @hot-updater/supabase@0.20.5

## 0.20.4

### Patch Changes

- 5314b31: feat(rock): intergration formerly rnef
- Updated dependencies [5314b31]
- Updated dependencies [711392b]
  - @hot-updater/plugin-core@0.20.4
  - @hot-updater/cloudflare@0.20.4
  - @hot-updater/firebase@0.20.4
  - @hot-updater/supabase@0.20.4
  - @hot-updater/aws@0.20.4
  - @hot-updater/console@0.20.4
  - @hot-updater/core@0.20.4

## 0.20.3

### Patch Changes

- e63056a: fix(cli): platform parser from hot-updater.config
- Updated dependencies [e63056a]
  - @hot-updater/plugin-core@0.20.3
  - @hot-updater/console@0.20.3
  - @hot-updater/aws@0.20.3
  - @hot-updater/cloudflare@0.20.3
  - @hot-updater/firebase@0.20.3
  - @hot-updater/supabase@0.20.3
  - @hot-updater/core@0.20.3

## 0.20.2

### Patch Changes

- Updated dependencies [0e78fb0]
  - @hot-updater/plugin-core@0.20.2
  - @hot-updater/console@0.20.2
  - @hot-updater/aws@0.20.2
  - @hot-updater/cloudflare@0.20.2
  - @hot-updater/firebase@0.20.2
  - @hot-updater/supabase@0.20.2
  - @hot-updater/core@0.20.2

## 0.20.1

### Patch Changes

- a3a4a28: feat(cli): set stringResourcePaths and infoPlistPaths in hot-updater.config.ts
- 42ff0e1: chore: bump @expo/fingerprint
- Updated dependencies [a3a4a28]
- Updated dependencies [b7b83ae]
  - @hot-updater/plugin-core@0.20.1
  - @hot-updater/console@0.20.1
  - @hot-updater/aws@0.20.1
  - @hot-updater/cloudflare@0.20.1
  - @hot-updater/firebase@0.20.1
  - @hot-updater/supabase@0.20.1
  - @hot-updater/core@0.20.1

## 0.20.0

### Patch Changes

- Updated dependencies [a0e538c]
- Updated dependencies [bc8e23d]
  - @hot-updater/cloudflare@0.20.0
  - @hot-updater/plugin-core@0.20.0
  - @hot-updater/console@0.20.0
  - @hot-updater/aws@0.20.0
  - @hot-updater/firebase@0.20.0
  - @hot-updater/supabase@0.20.0
  - @hot-updater/core@0.20.0

## 0.19.10

### Patch Changes

- 85b236d: skip gitignore and package json scripts
- 8d2d55a: Injectable minimum bundle id for Android
- Updated dependencies [a3c0901]
- Updated dependencies [4be92bd]
- Updated dependencies [2bc52e8]
  - @hot-updater/firebase@0.19.10
  - @hot-updater/cloudflare@0.19.10
  - @hot-updater/supabase@0.19.10
  - @hot-updater/aws@0.19.10
  - @hot-updater/plugin-core@0.19.10
  - @hot-updater/console@0.19.10
  - @hot-updater/core@0.19.10

## 0.19.9

### Patch Changes

- Updated dependencies [bcf6798]
  - @hot-updater/aws@0.19.9
  - @hot-updater/console@0.19.9
  - @hot-updater/core@0.19.9
  - @hot-updater/cloudflare@0.19.9
  - @hot-updater/firebase@0.19.9
  - @hot-updater/plugin-core@0.19.9
  - @hot-updater/supabase@0.19.9

## 0.19.8

### Patch Changes

- 4a6a769: feat(cli): show fingerprint diff
  - @hot-updater/console@0.19.8
  - @hot-updater/core@0.19.8
  - @hot-updater/aws@0.19.8
  - @hot-updater/cloudflare@0.19.8
  - @hot-updater/firebase@0.19.8
  - @hot-updater/plugin-core@0.19.8
  - @hot-updater/supabase@0.19.8

## 0.19.7

### Patch Changes

- e28313d: chore(cli): move commander to devDependencies and bundle it
- bcc641e: fix(cli): skipping set config `expo prebuild --platform android`
  - @hot-updater/console@0.19.7
  - @hot-updater/core@0.19.7
  - @hot-updater/aws@0.19.7
  - @hot-updater/cloudflare@0.19.7
  - @hot-updater/firebase@0.19.7
  - @hot-updater/plugin-core@0.19.7
  - @hot-updater/supabase@0.19.7

## 0.19.6

### Patch Changes

- 657a10e: Android Native Build - Gradle Build
- Updated dependencies [657a10e]
  - @hot-updater/aws@0.19.6
  - @hot-updater/cloudflare@0.19.6
  - @hot-updater/firebase@0.19.6
  - @hot-updater/plugin-core@0.19.6
  - @hot-updater/console@0.19.6
  - @hot-updater/supabase@0.19.6
  - @hot-updater/core@0.19.6

## 0.19.5

### Patch Changes

- 40d28c2: bump rnef
- Updated dependencies [40d28c2]
  - @hot-updater/console@0.19.5
  - @hot-updater/core@0.19.5
  - @hot-updater/aws@0.19.5
  - @hot-updater/cloudflare@0.19.5
  - @hot-updater/firebase@0.19.5
  - @hot-updater/plugin-core@0.19.5
  - @hot-updater/supabase@0.19.5

## 0.19.4

### Patch Changes

- Updated dependencies [0ddc955]
  - @hot-updater/plugin-core@0.19.4
  - @hot-updater/console@0.19.4
  - @hot-updater/aws@0.19.4
  - @hot-updater/cloudflare@0.19.4
  - @hot-updater/firebase@0.19.4
  - @hot-updater/supabase@0.19.4
  - @hot-updater/core@0.19.4

## 0.19.3

### Patch Changes

- 0c0ab1d: Add debug option while creating fingerprint
- Updated dependencies [0c0ab1d]
  - @hot-updater/plugin-core@0.19.3
  - @hot-updater/console@0.19.3
  - @hot-updater/aws@0.19.3
  - @hot-updater/cloudflare@0.19.3
  - @hot-updater/firebase@0.19.3
  - @hot-updater/supabase@0.19.3
  - @hot-updater/core@0.19.3

## 0.19.2

### Patch Changes

- 6aa6cd7: fix: globby to fast-glob unicorn-magic error
  - @hot-updater/console@0.19.2
  - @hot-updater/core@0.19.2
  - @hot-updater/aws@0.19.2
  - @hot-updater/cloudflare@0.19.2
  - @hot-updater/firebase@0.19.2
  - @hot-updater/plugin-core@0.19.2
  - @hot-updater/supabase@0.19.2

## 0.19.1

### Patch Changes

- 755b9fe: fix(expo): ensure fingerprint when prebuild
  - @hot-updater/console@0.19.1
  - @hot-updater/core@0.19.1
  - @hot-updater/aws@0.19.1
  - @hot-updater/cloudflare@0.19.1
  - @hot-updater/firebase@0.19.1
  - @hot-updater/plugin-core@0.19.1
  - @hot-updater/supabase@0.19.1

## 0.19.0

### Minor Changes

- c408819: feat(expo): channel supports expo cng
- 886809d: fix(babel): make sure the backend can handle channel changes for a bundle and still receive updates correctly

### Patch Changes

- Updated dependencies [886809d]
- Updated dependencies [fb846ce]
- Updated dependencies [75e82a8]
  - @hot-updater/plugin-core@0.19.0
  - @hot-updater/firebase@0.19.0
  - @hot-updater/console@0.19.0
  - @hot-updater/aws@0.19.0
  - @hot-updater/cloudflare@0.19.0
  - @hot-updater/supabase@0.19.0
  - @hot-updater/core@0.19.0

## 0.18.5

### Patch Changes

- Updated dependencies [494ce31]
  - @hot-updater/plugin-core@0.18.5
  - @hot-updater/cloudflare@0.18.5
  - @hot-updater/console@0.18.5
  - @hot-updater/firebase@0.18.5
  - @hot-updater/supabase@0.18.5
  - @hot-updater/aws@0.18.5
  - @hot-updater/core@0.18.5

## 0.18.4

### Patch Changes

- c6c4838: cancellation of platform selection prompt shows log correctly
  - @hot-updater/console@0.18.4
  - @hot-updater/core@0.18.4
  - @hot-updater/aws@0.18.4
  - @hot-updater/cloudflare@0.18.4
  - @hot-updater/firebase@0.18.4
  - @hot-updater/plugin-core@0.18.4
  - @hot-updater/supabase@0.18.4

## 0.18.3

### Patch Changes

- 34b96c1: fix(native): extracted bundle.zip directly into folder
- d56a2b3: hot-updater doctor
- 72f881c: channel set <channel> after create fingerprint
- 85fc787: fix doctor command check semver version
- 894b2bc: `app-version` shows naive native app version with refactored version utilties
- Updated dependencies [d56a2b3]
  - @hot-updater/aws@0.18.3
  - @hot-updater/console@0.18.3
  - @hot-updater/core@0.18.3
  - @hot-updater/cloudflare@0.18.3
  - @hot-updater/firebase@0.18.3
  - @hot-updater/plugin-core@0.18.3
  - @hot-updater/supabase@0.18.3

## 0.18.2

### Patch Changes

- 70c7f11: fix: no exit deploy in warning state
- Updated dependencies [437c98e]
- Updated dependencies [70c7f11]
  - @hot-updater/plugin-core@0.18.2
  - @hot-updater/cloudflare@0.18.2
  - @hot-updater/console@0.18.2
  - @hot-updater/firebase@0.18.2
  - @hot-updater/supabase@0.18.2
  - @hot-updater/aws@0.18.2
  - @hot-updater/core@0.18.2

## 0.18.1

### Patch Changes

- 8bf8f8f: rspress 2.0.0 and llms.txt
- 7db6246: create fingerprint
- Updated dependencies [8bf8f8f]
  - @hot-updater/console@0.18.1
  - @hot-updater/core@0.18.1
  - @hot-updater/aws@0.18.1
  - @hot-updater/cloudflare@0.18.1
  - @hot-updater/firebase@0.18.1
  - @hot-updater/plugin-core@0.18.1
  - @hot-updater/supabase@0.18.1

## 0.18.0

### Minor Changes

- 73ec434: fingerprint-based update stratgy

### Patch Changes

- Updated dependencies [73ec434]
  - @hot-updater/plugin-core@0.18.0
  - @hot-updater/cloudflare@0.18.0
  - @hot-updater/console@0.18.0
  - @hot-updater/firebase@0.18.0
  - @hot-updater/supabase@0.18.0
  - @hot-updater/core@0.18.0
  - @hot-updater/aws@0.18.0
