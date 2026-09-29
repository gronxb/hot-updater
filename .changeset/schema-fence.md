---
"@hot-updater/server": minor
---

Add the schema fence for the new storage engine. Migrations write settings rows last, after every table exists: `schema.engine` (`"1"`) and one row per module, such as `schema.core`, `schema.insights`, and `schema.apiKeys`.

- **Fence:** a provider that turns it on checks those rows with one batch read before its process's first read. A missing or different row throws `HotUpdaterSchemaMigrationRequiredError`, and handlers answer 503. The error now names the setting, the expected value, and the value it found. A missing settings table counts as a missing row; any other read failure, such as a refused connection, is thrown as is.
- **Old databases:** migrations refuse a database that has `schema.core` but no `schema.engine`, because it predates the engine and must be recreated.
- **Helpers:** `migrateSchema`, `writeSchemaSettings`, `checkSchemaFence`, `withSchemaFence`, `isMissingSchemaError`, and the façade's `migrateLegacyFacade` and `legacyFacadeSettings` are exported from the unstable `@hot-updater/server/database` subpath.
