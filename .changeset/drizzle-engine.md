---
"@hot-updater/server": minor
"hot-updater": minor
---

Run the Drizzle adapter on the new storage engine. `drizzleAdapter({ db, provider })` keeps its signature.

- **Engine:** reads and writes go through the shared SQL core over the Drizzle database's own driver. `db` may also be a function that returns the database on first use.
- **Drivers:** the first use checks that the driver can run an interactive transaction. The supported drivers are node-postgres, postgres-js, PGlite, and Neon over WebSockets for PostgreSQL; mysql2 for MySQL; and libSQL, better-sqlite3, or bun:sqlite for SQLite. Other drivers are refused with `DrizzleTransactionUnsupportedError`. Sync SQLite drivers run one statement at a time and begin transactions with `BEGIN IMMEDIATE`.
- **Schema:** `hot-updater db generate` writes the engine's tables as a Drizzle schema for `drizzle-kit push`. Every column is typed exactly as the SQL schema declares it.
- **Migrations:** after `drizzle-kit push`, `hot-updater db migrate` now runs for Drizzle and writes only the settings rows. It asks for the tables when they are missing and refuses a pre-engine database.
- **Schema fence:** the adapter fences its schema, so handlers answer 503 until `db migrate` has run.
- **Unused options:** the `schema` and `transaction` options are accepted and ignored.
