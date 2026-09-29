---
"@hot-updater/server": minor
"@hot-updater/plugin-core": patch
---

Generate the shared SQL schema from the resolved schema. `generateEngineSql(dialect, schema, settings)`, from `@hot-updater/server/db`, emits two things in order:

- **Tables and indexes:** the engine's version and reference-counter columns default to 0. There are no database foreign keys; the engine keeps references with those counters.
- **Settings rows:** written last, so the fence passes only once everything exists.

Providers generate their migrations from it. ORM providers that apply the tables with their own tooling get two more pieces:

- **Table shapes:** `sqlTableShapes` describes each table as the DDL creates it, so their schema generators match the DDL.
- **Settings-only migrations:** a migrator writes only the settings rows. It asks for the tables first when they are missing. Table DDL moves out of the SQL adapter's runtime into its own module, and migrations refuse a pre-engine database before changing any table.
