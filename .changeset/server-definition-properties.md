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

Tooling reads a server through its definition, the value `createHotUpdater` returns. Beside `core`, `api`, and `handlers`, the definition has public, read-only properties: `database`, `storage`, `plugins`, `clientPlugins`, `clientEndpoints`, and `clientAuth`, which names the plugin that guards client routes and the request headers its decision reads, lowercase. `@hot-updater/server` drops `./db`, `./diff`, and `./internal`. It now exports only its root, `./adapters/*`, `./plugins/insights`, and `./plugins/api-keys`.

The CLI and the console write through the definition's `core`, the same path the server's own writes take, and call plugins through its `api`:

- **Missing plugin migrations.** A command stops before it reads or writes if a plugin's migration has not run. `HotUpdaterSchemaMigrationRequiredError` lists every missing or stale settings row (`settings`) and names their plugins (`plugins`). It also gives the fix for the database:
  - `hot-updater db migrate`;
  - `hot-updater db generate`, for a database migrated from files;
  - on a managed server, rerunning `hot-updater init`.
- **Expired rows on SQL databases.** When a retention pass is due, a write first deletes expired rows from plugins' tables. The server and the CLI share one lease. A pass deletes at most 500 rows a table. A pass that fails, such as for credentials that cannot delete, logs a warning and the write goes ahead.
- **Key-value databases** (DynamoDB, Firestore) expire rows themselves, so their writes delete nothing.
- **Storage.** Core resolves file URLs through the definition's storage. A definition whose storage only uploads can still write.

Other changes:

- **Tooling moves to `@hot-updater/cli-tools`.** These take a definition: `serverDefinitionOf`, `isServerDefinition`, `managedServerDefinitionOf`, `pluginCommandsOf`, `clientAuthOf`, `generateClientCredential`, `provisionClientCredential`, `createMigrator`, `generateSchema`, and `generatesSchema`. Tooling refuses a definition from an older `@hot-updater/server` and says to upgrade it.
- **`createDatabaseCoreApi` and `createDatabasePluginApis` are removed.** Use a definition's `core` and `api`. In a test, that is for example `createHotUpdater({ database, plugins, clientAccess: "public" }).api.insights`.
- **`createBundleDiff` moves into the `hot-updater` CLI**, so `@hot-updater/server` no longer depends on `@hot-updater/bsdiff`.
- **Insights test suite.** `insightsTestSuite`'s `createModel` receives the database as an `EngineDatabase`.
- **Managed init:**
  - It reads the client endpoints, headers, client plugins, and credential of the plugins it deploys from a definition over the database it set up.
  - It refuses an edited definition whose clientAuth plugin gives no credential, before changing any resource.
  - The agent infrastructure scaffolds read the definition's properties. Firebase's `migrate.ts` imports `toolingTargetOf` from `@hot-updater/plugin-core`, which its app now lists.
