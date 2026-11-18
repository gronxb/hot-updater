---
"@hot-updater/plugin-core": patch
"@hot-updater/server": patch
"@hot-updater/cli-tools": patch
"hot-updater": patch
---

fix(db): the Drizzle schema converges under `drizzle-kit push`, and `db migrate` refuses a newer or incomplete schema.

- `hot-updater db generate` writes a Drizzle schema that matches what drizzle-kit reads back, so a second `drizzle-kit push` plans nothing. The push after upgrading adds only the new tables and indexes, with no data-loss prompt. On PostgreSQL its columns leave out `COLLATE "C"`, which `db migrate` sets where the database lacks it. On MySQL, apply it with `drizzle-kit generate` and `drizzle-kit migrate`. A project that applies it with `drizzle-kit generate` deletes the statements on Hot Updater's existing tables and indexes from the first migration after upgrading, as the 1.2.0 upgrade notes say.
- `db migrate` and a managed provider's init refuse a database whose `schema.core` is newer than this release's. They write nothing and name the version to upgrade to. Doctor reports it as `SCHEMA_NEWER_THAN_CLI` with the same step.
- On Drizzle and Prisma, `db migrate` checks that every table and index exists before it writes the settings rows, and names what is missing. Doctor reports it as `SCHEMA_TABLES_MISSING`.
- `hot-updater doctor` exits after a passing run on a MySQL or MongoDB config.
- `db migrate` lists only the tables and indexes it creates, and the settings it changes.
