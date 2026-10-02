# @hot-updater/cli-tools

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

### Minor Changes

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

- ab04e15: Plugins no longer add `hot-updater` commands. `PluginCli` keeps `clientCredential` and `clientPlugin`, the metadata that `hot-updater init`, `hot-updater doctor`, and the agent scaffold read, and its `commands` is removed, with no replacement:
  - These names are removed from every package: `PluginCommand`, `PluginCommandArgument`, `PluginCommandOption`, `PluginCommandContext`, `PluginCommandUi`, and `PluginTableColumn`, which rc.20 exported from `@hot-updater/server/plugins`, and `pluginCommandsOf` and `PluginCommandEntry`, which rc.20 exported from `@hot-updater/server/db`.
  - `createHotUpdater` refuses a plugin whose `cli` holds `commands`, or any key other than `clientCredential` and `clientPlugin`, with `HotUpdaterConfigError`.
  - The CLI no longer looks for plugin commands, and `hot-updater --help` no longer lists **Plugin commands**.

  `hot-updater api-key create|list|revoke` is a built-in command again: `create --name <name>`, `list` with `--json`, and `revoke <id>` with `-y`, each with an optional trailing `[serverPath]`. It manages keys through `apiKeys()` over the first of:
  - the server file `serverPath` names, such as `src/hotUpdater.ts` in a server project;
  - `database` and `plugins` in `hot-updater.config.ts`, when the config sets `database`;
  - `src/hotUpdater.*` or `src/db.*`.

  When those plugins lack `apiKeys()`, it says to add it. With `database: standaloneRepository(...)`, it says to run the command in the server project with the server file's path, since the admin API serves no API key routes. The `cli` of `apiKeys()` from `@hot-updater/plugin-api-keys` holds only its `clientCredential`.

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

### Patch Changes

- c9cfed7: Every package now shares one release candidate version: `hot-updater` and every `@hot-updater/*` package move to the same version, so an app, its server, and the console can pin one version.
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
  - @hot-updater/protocol@1.0.0-rc.21
  - @hot-updater/plugin-core@1.0.0-rc.21
  - @hot-updater/server@1.0.0-rc.21

## 1.0.0-rc.17

### Minor Changes

- 9cd555b: Remove `formatApiKeyNote`, which returned its input unchanged.
- 9cd555b: The plugin that provides `clientAuth` describes the credential an app sends in `cli.clientCredential`: its label, header, environment variable, and how to generate and provision it. `@hot-updater/server/db` exports `clientAuthOf`, `generateClientCredential`, and `provisionClientCredential`, which read it from a plugin list.

  Managed init provisions the app's credential through the provider's plugins and prints `HotUpdater.init` with that credential's header, or with no `requestHeaders` when client routes are public; `@hot-updater/cli-tools` exports `renderAppSetup` and `printAppSetup` for it. AWS CloudFront cache and origin-request policies key on the client-route policy's `varyHeaders` instead of a fixed `x-api-key`.

  Agent and infrastructure scaffolds record the server's `clientAuth` in `manifest.json` and render their instructions from it. The helper is `app/provision-client-credential.mjs` with `app/database.config.ts`, and it saves `app/client-credential.local`. `hot-updater doctor` reads the credential's header and variable from the scaffold, and skips the 401 check when client routes are public.

- 9cd555b: A server plugin names the client plugin an app adds to `HotUpdater.init`'s `plugins` in `cli.clientPlugin`, as `{ module, name }`; `insights()` names `insights` from `@hot-updater/react-native/plugins/insights`. `createHotUpdater` checks them at startup: each names an export the app can import, not a reserved word, `App`, or `HotUpdater`, and no two plugins name one export from different modules. `@hot-updater/server/db` exports `clientPluginsOf`, which reads them from a plugin list. Managed init passes them to `printAppSetup`, which imports them and adds them to `plugins`, and agent scaffolds record them in `manifest.json` and render the app code in their instructions from them.

### Patch Changes

- Updated dependencies [e696e69]
- Updated dependencies [1ddd5fc]
- Updated dependencies [9a6715f]
- Updated dependencies [530cca5]
  - @hot-updater/plugin-core@1.0.0-rc.17

## 1.0.0-rc.16

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

- 228b6c7: Remove the legacy database contract. Every database runs on the storage engine, and core, its plugins, and the admin API are the only way to its data. Release candidate databases are recreated, not converted.
  - **Databases:** a provider returns an `EngineDatabase`, `{ name, adapter, dispose? }`, with `provider`, `createMigrator`, and `generateSchema` for `hot-updater db` where it has them. `createEngineDatabase({ name, adapter })` from `@hot-updater/server/database` puts the adapter behind the schema fence with the built-in settings; `builtInSchema`, `builtInSettings`, and `migrateBuiltInSchema` are the built-in tables, their settings rows, and their migration. `DatabasePlugin`, `createDatabasePlugin`, `createDatabaseClient`, the model and commit types, `commitReleaseCatalogMutation(s)`, and `BundleRepository` are gone.
  - **`createHotUpdater`:** takes `{ database, storage?, plugins?, clientAccess? }`; `plugins` defaults to none. `clientAccess` is `"public"`, or absent when a plugin provides clientAuth. A `clientAccess` object is a type error whose message names `apiKeys()`, and at startup a `HotUpdaterConfigError` that names it too. The instance is `{ handlers, core, api, adapterName }`: bundle, channel, release, Insights, and API key methods on it are gone; use `core` and the plugins' `api`. `registerApiKey`, `createApiKey`, `provisionApiKey`, and `createHandlers` are no longer exported; the `apiKeys()` plugin's API does the same work.
  - **Handlers:** client routes read catalogs and artifacts through core. The admin API speaks protocol 2 only: `v=2` is accepted and changes nothing, and `POST /database/commit`, `POST /bundles`, and `DELETE /bundles/:id` are gone (deploy with `POST /releases`, delete with `POST /bundles/delete`). `PATCH /bundles/:id` answers 204. The Insights routes come from `insights()`; without it they answer 204 with `x-hot-updater-insights: disabled`.
  - **Schema:** generated SQL, Drizzle, and Prisma schemas have no database foreign keys; the engine keeps references. CockroachDB and SQL Server are no longer supported, and `relationMode` is gone. The checked-in Postgres and Supabase SQL is regenerated.
  - **Providers:** `postgres`, `d1Database`, `supabaseDatabase`, `firebaseDatabase`, and `dynamoDB` return engine databases. `dynamoDB` invalidates the cached update-check routes after a write that changes a Release Catalog.
  - **`standaloneRepository`:** is `{ name, core, fetchAdmin }` over admin API protocol 2; its protocol 1 reads and custom bundle `routes` are gone.
  - **`@hot-updater/test-utils`:** `setupDatabaseTestSuite` runs core, bundles, the Release Catalog contract, and Insights through admin API protocol 2 over HTTP, and with `createInsightsModel` the Insights report contract. It replaces `setupDatabasePluginTestSuite` and `setupDatabaseClientTestSuite`. `setupBundleMethodsTestSuite` and `setupReleaseCatalogTestSuite` take `{ getClient }` on protocol 2.
  - **CLI and console:** they read and write through core only. `hot-updater api-key` manages keys through the config's `apiKeys()` plugin, and the console runs the config's `plugins`: without them, Insights and API keys are off.

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

- Updated dependencies [f5fffea]
- Updated dependencies [79c3eea]
  - @hot-updater/plugin-core@1.0.0-rc.15
  - @hot-updater/core@1.0.0-rc.15

## 1.0.0-rc.14

### Patch Changes

- Align all Hot Updater packages on 1.0.0-rc.14 for a coordinated release candidate. Future releases continue to use independent package versions.
- b23db5e: Replace shared Insights installation storage with canonical events and provider-private indexes for current installation queries. SQL and MongoDB keep nine access fields and fetch full event payloads only for selected results; DynamoDB counts compact scope entries. Custom providers implement `recordEvent({ event })`, `findLatestEvents`, and explicit `countLatestEvents` predicates without lifecycle helpers. Move ancillary event fields into typed `metadata`, reusing Bundle JSON conventions, while preserving SDK requests and Console responses.

  This changes the unreleased 1.0.0 initialization and custom database contract from the previous installation-row design. The read-cost fix preserves the canonical-event contract and keeps current-state queries independent of retained event history. Append and index updates are atomic; measured read/write costs are documented.

- Updated dependencies [479c1e5]
- Updated dependencies
- Updated dependencies [b23db5e]
  - @hot-updater/plugin-core@1.0.0-rc.14
  - @hot-updater/core@1.0.0-rc.14

## 1.0.0-rc.3

### Patch Changes

- Updated dependencies [663d8e9]
  - @hot-updater/plugin-core@1.0.0-rc.3

## 1.0.0-rc.2

### Patch Changes

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

- 590ca70: Upload non-archive files with `application/octet-stream` instead of `application/zip`. `getContentType` fell through to the compression format table for any name `mime` did not resolve, and that table defaults to zip, so brotli bundle assets (`.br`), extensionless content addressed assets, and `.bsdiff` patches were all mislabeled by the CLI storage upload helper.
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

- 8145d48: Separate bundle signer identity from the native trust anchor. Signing providers
  now expose public identity only through `getPublicKey()`, while Expo reads its
  public trust-anchor file exclusively from the app config plugin and includes it
  in native fingerprints. Add public-key materialization for Expo and validate
  Expo CNG trust anchors during deploy and doctor without loading signing
  credentials during prebuild.
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
- a9ffb2a: Remove unused `releaseChannel` from `hot-updater.config.ts`. The build-time channel is set with `hot-updater channel set`.
- a9ffb2a: Require R2 S3 credentials, drop Wrangler `r2Storage` and Android `stringResourcePaths`. Doctor only targets infrastructure generation 1.0.0. Channel, fingerprint, and signing keys live in AndroidManifest.xml.
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

## 0.36.0

### Patch Changes

- 9759e8a: Reduce S3 management query work by skipping legacy UUIDv7 artifact traversal, deriving channels from canonical manifest keys, and batching multi-bundle deletion scans and commits. Store new bundle artifacts below `bundles/<bundle-id>` while preserving legacy reads, and add exact target app version filters to the CLI and Console. Add an exclusive-maintenance `hot-updater storage prune` command for orphaned bundle objects and unreferenced shared assets, with an explicit `--dry-run` candidate table, a recent-object protection window, and fail-closed reference validation safeguards.
- Updated dependencies [9759e8a]
  - @hot-updater/plugin-core@0.36.0
  - @hot-updater/core@0.36.0

## 0.35.12

### Patch Changes

- fd30452: Support firebase-admin v14 by using the modular Admin SDK APIs.
- 6e8b32e: Replace the semver dependency with verkit.
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
  - @hot-updater/core@0.35.10

## 0.35.9

### Patch Changes

- 8688b1a: chore: migrate to TypeScript 7 and OXC
- f9bb26d: Declare init inputs in each provider package through a shared contract, ask
  once before saving credential inputs, and support prompt-free infrastructure
  reconciliation with `init --env-file .env.hotupdater`.
  - @hot-updater/core@0.35.9
  - @hot-updater/plugin-core@0.35.9

## 0.35.8

### Patch Changes

- 4f9fab2: Render spinner, progress, and task output statically in CI and non-interactive
  terminals, and update the embedded Clack runtime to 1.7.0.
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

- 070a86f: Fix copied bundle promotion to upload Brotli Hermes bundle assets expected by manifest-driven update checks.
- Updated dependencies [e914f56]
  - @hot-updater/plugin-core@0.33.0
  - @hot-updater/core@0.33.0

## 0.32.0

### Patch Changes

- 4e6d2ec: Use deterministic content-addressed storage keys for manifest assets, require storage plugins to implement object existence checks, skip uploads when the object already exists, limit deploy upload concurrency, stream hashing/compression work to reduce memory pressure, and report upload progress through 100%.
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

### Patch Changes

- Updated dependencies [5b0a0f5]
- Updated dependencies [5b0a0f5]
  - @hot-updater/core@0.31.0
  - @hot-updater/plugin-core@0.31.0

## 0.30.12

### Patch Changes

- @hot-updater/plugin-core@0.30.12

## 0.30.11

### Patch Changes

- @hot-updater/plugin-core@0.30.11

## 0.30.10

### Patch Changes

- @hot-updater/plugin-core@0.30.10

## 0.30.9

### Patch Changes

- @hot-updater/plugin-core@0.30.9

## 0.30.8

### Patch Changes

- 6019156: refactor(cli-tools): extract `promoteBundle` from `@hot-updater/console` so it can be reused by the CLI

  `promoteBundle` and `createCopiedBundleArchive` move from `@hot-updater/console`'s server-only `lib/server/promoteBundle.ts` into `@hot-updater/cli-tools`. The console's RPC handler now imports from `@hot-updater/cli-tools`. UUIDv7 helpers (`createUUIDv7`, `extractTimestampFromUUIDv7`, `createUUIDv7WithSameTimestamp`) move to `@hot-updater/plugin-core` since they are generic primitives, not console-specific.

  Pure refactor — no behavior change. Existing test coverage moves with the function. This unblocks an upcoming `hot-updater promote` CLI command that calls the same implementation as the console UI.

- Updated dependencies [6019156]
  - @hot-updater/plugin-core@0.30.8

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
  - @hot-updater/plugin-core@0.30.7

## 0.30.6

### Patch Changes

- @hot-updater/plugin-core@0.30.6

## 0.30.5

### Patch Changes

- @hot-updater/plugin-core@0.30.5

## 0.30.4

### Patch Changes

- @hot-updater/plugin-core@0.30.4

## 0.30.3

### Patch Changes

- @hot-updater/plugin-core@0.30.3

## 0.30.2

### Patch Changes

- @hot-updater/plugin-core@0.30.2

## 0.30.1

### Patch Changes

- @hot-updater/plugin-core@0.30.1

## 0.30.0

### Minor Changes

- 83c01c8: fix: keep target cohorts additive to rollout

### Patch Changes

- Updated dependencies [83c01c8]
  - @hot-updater/plugin-core@0.30.0

## 0.29.8

### Patch Changes

- @hot-updater/plugin-core@0.29.8

## 0.29.7

### Patch Changes

- @hot-updater/plugin-core@0.29.7

## 0.29.6

### Patch Changes

- 80cce61: feat(cli): merge init config on re-run
  - @hot-updater/plugin-core@0.29.6

## 0.29.5

### Patch Changes

- Updated dependencies [52208f4]
  - @hot-updater/plugin-core@0.29.5

## 0.29.4

### Patch Changes

- @hot-updater/plugin-core@0.29.4

## 0.29.3

### Patch Changes

- Updated dependencies [d1ffb83]
  - @hot-updater/plugin-core@0.29.3

## 0.29.2

### Patch Changes

- 2a1bc80: fix: node deps bundling
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

- 90f9610: Improve native build logging stream handling and make iOS child process
  termination on Ctrl+C more reliable.
- Updated dependencies [03c5adc]
  - @hot-updater/plugin-core@0.25.10
  - @hot-updater/core@0.25.10

## 0.25.9

### Patch Changes

- Updated dependencies [6b22072]
  - @hot-updater/plugin-core@0.25.9

## 0.25.8

### Patch Changes

- @hot-updater/plugin-core@0.25.8

## 0.25.7

### Patch Changes

- @hot-updater/plugin-core@0.25.7

## 0.25.6

### Patch Changes

- @hot-updater/plugin-core@0.25.6

## 0.25.5

### Patch Changes

- @hot-updater/plugin-core@0.25.5

## 0.25.4

### Patch Changes

- 8c83ff2: Add support for hot-updater.config.mjs
  - @hot-updater/plugin-core@0.25.4

## 0.25.3

### Patch Changes

- @hot-updater/plugin-core@0.25.3

## 0.25.2

### Patch Changes

- @hot-updater/plugin-core@0.25.2

## 0.25.1

### Patch Changes

- @hot-updater/plugin-core@0.25.1

## 0.25.0

### Patch Changes

- @hot-updater/plugin-core@0.25.0

## 0.24.7

### Patch Changes

- 294e324: fix: update babel plugin path in documentation and plugin files
- Updated dependencies [294e324]
  - @hot-updater/plugin-core@0.24.7

## 0.24.6

### Patch Changes

- 9d7b6af: feat(aws): sso template with fromSSO
  - @hot-updater/plugin-core@0.24.6

## 0.24.5

### Patch Changes

- @hot-updater/plugin-core@0.24.5

## 0.24.4

### Patch Changes

- Updated dependencies [7ed539f]
  - @hot-updater/plugin-core@0.24.4

## 0.24.3

### Patch Changes

- @hot-updater/plugin-core@0.24.3

## 0.24.2

### Patch Changes

- @hot-updater/plugin-core@0.24.2

## 0.24.1

### Patch Changes

- @hot-updater/plugin-core@0.24.1

## 0.24.0

### Patch Changes

- @hot-updater/plugin-core@0.24.0

## 0.23.1

### Patch Changes

- @hot-updater/plugin-core@0.23.1

## 0.23.0

### Patch Changes

- @hot-updater/plugin-core@0.23.0

## 0.22.2

### Patch Changes

- @hot-updater/plugin-core@0.22.2

## 0.22.1

### Patch Changes

- @hot-updater/plugin-core@0.22.1

## 0.22.0

### Patch Changes

- @hot-updater/plugin-core@0.22.0

## 0.21.15

### Patch Changes

- @hot-updater/plugin-core@0.21.15

## 0.21.14

### Patch Changes

- @hot-updater/plugin-core@0.21.14

## 0.21.13

### Patch Changes

- @hot-updater/plugin-core@0.21.13

## 0.21.12

### Patch Changes

- Updated dependencies [5c4b98e]
  - @hot-updater/plugin-core@0.21.12

## 0.21.11

### Patch Changes

- d6c3a65: chore(cli-tools): peerDeps
- e2b67d7: fix(cli-tools): esm only package bundle
- Updated dependencies [e2b67d7]
  - @hot-updater/plugin-core@0.21.11

## 0.21.10

### Patch Changes

- @hot-updater/plugin-core@0.21.10

## 0.21.9

### Patch Changes

- aa399a6: chore: deps picocolors
- Updated dependencies [aa399a6]
  - @hot-updater/plugin-core@0.21.9

## 0.21.8

### Patch Changes

- 3fe8c81: feat(plugin-core): reduced deps for edge-runtime
- Updated dependencies [3fe8c81]
  - @hot-updater/plugin-core@0.21.8
