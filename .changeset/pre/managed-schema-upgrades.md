---
"hot-updater": minor
"@hot-updater/plugin-core": minor
"@hot-updater/cloudflare": minor
"@hot-updater/supabase": minor
"@hot-updater/standalone": minor
"@hot-updater/console": minor
---

`hot-updater doctor` reports a database whose schema is behind, and names the command that migrates it.

- `hot-updater doctor` reads the database `hot-updater.config.ts` names through the schema fence, as the server does, and reports `SCHEMA_MIGRATION_PENDING` with each settings row a migration writes: after upgrading to a release whose schema changed, or after adding a plugin to `plugins`. It checks the release catalogs once the schema passes. A row newer than the CLI expects is `SCHEMA_NEWER_THAN_CLI`; a v0 database is `SCHEMA_NOT_MIGRATABLE`; and a plugin of your own whose stored version differs is `PLUGIN_SCHEMA_CHANGED`, left to its own migration. Doctor names no migration while any of these stands.
- The managed D1 and Supabase schemas ship as one migration per release that changes them, starting with `0002_hot-updater_1.2.0.sql`, after the unchanged `0001_hot-updater_1.0.0.sql`. Each holds what the earlier ones do not create, with Supabase's apply RPC, its grants, and row-level security for new tables, then every settings row. `hot-updater init`, run again with its saved inputs, applies them.
- The schema fence's errors send you to `npx hot-updater doctor`, which names the command for the database.
- The Console shows a migration notice, with the settings and the command, instead of failing on every page while its database needs a migration.
