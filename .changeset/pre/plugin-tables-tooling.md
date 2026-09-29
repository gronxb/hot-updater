---
"@hot-updater/server": minor
"@hot-updater/supabase": minor
"@hot-updater/cloudflare": minor
"hot-updater": minor
---

Create third-party plugins' tables with `hot-updater db`.

- **Tooling:** `hot-updater db migrate` and `db generate` read the server's `plugins`. Besides the built-in tables, they create each third-party plugin's tables under its id and write its `schema.<id>` settings row last. Kysely's SQL, Drizzle's schema, Prisma's models, MongoDB's collections, and the Supabase and D1 migrations include them; DynamoDB and Firestore need only the settings row.
- **Fence:** a server on a fenced database also checks each third-party plugin's `schema.<id>` row before its first read, and answers 503 until `db migrate` writes it.
- **Any engine database:** `createEngineDatabase` gives an adapter with `migrations` the migrator `hot-updater db migrate` runs. The command now works for the `postgres` provider, DynamoDB, Firestore, D1's REST database, and custom adapters, besides the Kysely, Drizzle, Prisma, and MongoDB adapters.
- **Supabase:** `supabaseDatabase` from `@hot-updater/supabase` generates a migration in `supabase/migrations` with the plugin tables, their row-level security, and an apply RPC that may reach them. Its adapter no longer offers to create tables, since the RPC runs no DDL, so `db migrate` points to `db generate`.
- **D1:** the REST `d1Database` generates a Wrangler migration in `migrations`, and `db migrate` applies the same schema through the Cloudflare API.
- **Names:** a third-party plugin may not take a built-in plugin's id, or a table name that resolves to a built-in table, such as an `api` plugin's `keys` table.
- **SQL core:** `migrations.apply` also creates the write guard table for an executor with `batch`.
- **Types:** `SchemaGenerator` and `DatabaseTooling.createMigrator` take a `ToolingTarget` (`{ schema, settings }`, exported from `@hot-updater/server/db`); `builtInTarget` from `@hot-updater/server/database` is the target without third-party plugins.
- **CLI:** `db generate` skips a migration identical to one already in its directory.
