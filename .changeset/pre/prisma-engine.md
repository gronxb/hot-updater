---
"@hot-updater/server": minor
"@hot-updater/plugin-core": patch
"hot-updater": minor
---

Run the Prisma adapter on the new storage engine. `prismaAdapter({ prisma, provider })` keeps its signature; SQL Server is refused.

- **Engine:** reads and writes go through the shared SQL core, with Prisma's raw queries and interactive transactions. Prisma's P2010 and P2034 errors carry the database's code, so constraints and write conflicts are classified as with other drivers. A SQLite transaction takes the write lock with its first statement, as `BEGIN IMMEDIATE` would.
- **Schema:** `hot-updater db generate` merges the engine's tables into `prisma/schema.prisma` as models with keys and named indexes, and no relations; the engine keeps references itself. Fields that start with an underscore are mapped, such as `hu_v` to `_v`. On MySQL, ASCII keys are `VarBinary`, which keeps them within InnoDB's key limit.
- **Migrations:** after `prisma db push` or `prisma migrate`, `hot-updater db migrate` now runs for Prisma. It sets the collations Prisma cannot declare (`COLLATE "C"` on PostgreSQL and binary UTF-8 on MySQL), then writes the settings rows.
- **Schema fence:** the adapter fences its schema, so handlers answer 503 until `db migrate` has run.
- **JSON parameters:** PostgreSQL JSON parameters are cast to `jsonb`, since Prisma binds strings as text.
- **Booleans:** a stored `0n` or `1n` reads as a boolean, as Prisma returns SQLite `BIGINT` values.
