---
"@hot-updater/server": minor
"@hot-updater/cloudflare": minor
---

Run Cloudflare D1 on the new storage engine. `d1Database(config)` over the REST API and `d1Database(env.DB)` inside a Worker keep their signatures.

- **Batch writes:** D1 has no interactive transactions, so the shared SQL core gains a batch mode. An executor that provides `batch` writes each change as one atomic batch.
  - The batch first records each op's guard in the `_hu_write` guard row, against the rows before any change. Unique fields are checked there too, ignoring rows the same write deletes or patches.
  - Every change then applies only when no guard failed.
  - The last statements read the first failed op and remove the row.
- **Parameter limit:** `createSqlAdapter` accepts `maxParams`, and splits a batch read to stay within it. D1 allows 100 parameters per statement.
- **Op limit:** a D1 write sends at most 450 ops, within a Worker invocation's 1,000 queries on the paid plan.
- **Schema:** `sql/bundles.sql` and the Worker's `0001_hot-updater_1.0.0.sql` migration are now the generated shared SQL schema, with the guard table and the settings rows. A test fails when either file differs from the generator.
- **Schema fence:** the adapter fences its schema, so handlers answer 503 until the migration has run.
- **REST:** values are still sent as JSON text and read back with `json_extract`.
- **Exports:** `@hot-updater/server/database` exports `WRITE_GUARD_TABLE` and `isMultiIndex`.
