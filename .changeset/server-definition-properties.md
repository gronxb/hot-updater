---
"@hot-updater/server": minor
"@hot-updater/cli-tools": minor
"@hot-updater/plugin-core": minor
"hot-updater": minor
"@hot-updater/console": minor
"@hot-updater/test-utils": patch
"@hot-updater/aws": patch
"@hot-updater/cloudflare": patch
"@hot-updater/firebase": patch
"@hot-updater/supabase": patch
---

Tooling reads a server through its definition, the value `createHotUpdater` returns. Beside `core`, `api`, and `handlers`, a definition has public, read-only properties:

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
  - `clientAuthOf`, `generateClientCredential`, `provisionClientCredential`, `pluginCommandsOf`, `createMigrator`, `generateSchema`, `generatesSchema`, `ClientAuthSpec`, `ClientCredentialSpec`, `PluginCommandEntry`, and `ProvisionedClientCredential`. Import them from `@hot-updater/cli-tools`, where each takes a definition.
- From `@hot-updater/server/diff`: `createBundleDiff`, `CreateBundleDiffDependencies`, `CreateBundleDiffInput`, and `CreateBundleDiffOptions`. There is no public replacement: the `hot-updater` CLI creates bundle diffs itself, and `@hot-updater/server` no longer depends on `@hot-updater/bsdiff`.

The CLI and the console write through the definition's `core`, the same path the server's own writes take, and call plugins through its `api`:

- **Missing plugin migrations.** A command stops before it reads or writes if a plugin's migration has not run. `HotUpdaterSchemaMigrationRequiredError` lists every missing or stale settings row in `settings` and names their plugins in `plugins`. Its message gives the fix for the database:
  - `hot-updater db migrate`;
  - `hot-updater db generate`, for a database migrated from files;
  - on a managed server, rerunning `hot-updater init --provider <provider>`.
- **Expired rows on SQL databases.** When a retention pass is due, a write first deletes expired rows from plugins' tables:
  - The server and the CLI share one lease.
  - A pass deletes at most 500 rows from each table.
  - A failed pass, for example one whose credentials cannot delete, logs a warning and the write goes ahead. The pass is due again at once, so the next writer that can delete, such as the server, runs it. The process whose pass failed tries again in a minute.
- **Key-value databases** (DynamoDB, Firestore) expire rows themselves, so their writes delete nothing.
- **Storage.** Core resolves file URLs through the definition's storage. A definition whose storage only uploads can still write, and its `core.getArtifactInfo` returns `null`, because it can neither read nor sign a file.

Other changes:

- **`@hot-updater/cli-tools`** adds `serverDefinitionOf`, `isServerDefinition`, and `managedServerDefinitionOf`, which read a definition. Tooling refuses a definition from an older `@hot-updater/server` and says to upgrade it.
- **Insights test suite.** `insightsTestSuite`'s `createModel` receives the database as an `EngineDatabase`.
- **Managed init:**
  - It reads the client endpoints, headers, client plugins, and credential of the plugins it deploys from a definition over the database it set up.
  - It refuses an edited definition whose clientAuth plugin gives no credential, before changing any resource.
  - The agent infrastructure scaffolds read the definition's properties. Firebase's `migrate.ts` imports `toolingTargetOf` from `@hot-updater/plugin-core`, which its app now lists. The scaffolds' `provision-client-credential.mjs` refuses a clientAuth plugin whose `cli.clientCredential` lacks a label, header, env, `generate`, or `provision`.
