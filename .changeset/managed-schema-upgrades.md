---
"hot-updater": minor
"@hot-updater/cli-tools": minor
"@hot-updater/plugin-core": minor
"@hot-updater/cloudflare": minor
"@hot-updater/supabase": minor
"@hot-updater/standalone": minor
"@hot-updater/console": minor
---

Upgrade a database's schema with `hot-updater doctor --fix`.

- `hot-updater doctor` reads the database `hot-updater.config.ts` names through the schema fence, as the server does, and reports `SCHEMA_MIGRATION_PENDING` with each settings row a migration writes: after upgrading to a release whose schema changed, or after adding a plugin to `plugins`. It checks the release catalogs once the schema passes. A row newer than the CLI expects is `SCHEMA_NEWER_THAN_CLI`, which `--fix` never moves back; a v0 database is `SCHEMA_NOT_MIGRATABLE`; and a plugin of your own whose stored version differs is `PLUGIN_SCHEMA_CHANGED`, left to its own migration. `--fix` migrates nothing while any of these stands.
- `--fix` applies the migrations first. On a D1 database or Supabase project `hot-updater init` created, it runs the provider's numbered migration files the database has not run: through the D1 API token, recorded in `d1_migrations` as Wrangler records them, or with `supabase db push`, which needs the access token or CLI login and the database password. DynamoDB, Firestore, Cosmos DB, PostgreSQL, Kysely, and MongoDB databases get the missing tables and settings rows, as `hot-updater db migrate` creates them. A D1 database `init` did not create migrates the same way. Drizzle and Prisma keep creating their own tables. `--json` never prompts.
- The managed D1 and Supabase schemas ship as one migration per release that changes them, starting with `0002_hot-updater_1.2.0.sql`, after the unchanged `0001_hot-updater_1.0.0.sql`. Each holds what the earlier ones do not create, with Supabase's apply RPC, its grants, and row-level security for new tables, then every settings row.
- The schema fence's errors name `hot-updater doctor --fix` instead of rerunning `hot-updater init`.
- The Console shows a migration notice, with the settings and the command, instead of failing on every page while its database needs a migration.
