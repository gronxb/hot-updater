---
"@hot-updater/server": minor
"@hot-updater/postgres": minor
"hot-updater": patch
---

Run the Kysely adapter and the `postgres` plugin on the new storage engine. Their factory signatures are unchanged.

- **Kysely:** `kyselyAdapter` runs PostgreSQL, MySQL, and SQLite through the shared SQL core with `kyselyExecutor`. CockroachDB runs as PostgreSQL until E2 removes it.
  - Its migrator applies the generated SQL schema: tables, indexes, database foreign keys (left out in `fumadb` mode), and the settings rows, written last.
  - The migrator refuses a v0 or pre-engine database instead of converting it.
- **Schema fence:** both adapters fence their schema. A database without the `schema.engine` row is refused before its first read, and handlers answer 503.
- **`postgres` plugin:** `sql/bundles.sql` is now the generated SQL schema, and a test fails when the two differ.
- **Removed:** the plugin-specific Insights helpers `getKyselyAppUsage`, `getKyselyReleaseActivity`, `readKyselyInsightsHead`, and `recordKyselyInsightsOverview` are no longer exported from `@hot-updater/server`.
- **Upgrade note:** the 1.0.0 infrastructure upgrade note now says that RC databases created before the adapter redesign must be recreated.
