---
"@hot-updater/server": minor
---

Run the MongoDB adapter on the new storage engine. `mongoAdapter({ client })` keeps its signature; the `transactions` option is accepted and ignored.

- **Storage:** each table is a collection with its key as `_id`, and each index is created as declared. Multi-valued fields use multikey indexes, and unique indexes skip missing values, as SQL's skip nulls.
- **Writes:** every write runs in one transaction, so MongoDB must run as a replica set or a sharded cluster; a standalone server's first write fails with `MongoTransactionUnsupportedError`.
  - Guarded patches and deletes are conditional on the row's version.
  - A `check` is a conditional `$inc`: a real write, so a concurrent transaction on the same document conflicts.
  - Increments create a missing row from its initial values in one upsert.
  - Write conflicts and racing upserts are retried by the engine.
- **Migrations:** `hot-updater db migrate` creates the collections and indexes, then writes the settings rows. It refuses a v0 database and a database from before the engine.
- **Schema fence:** the adapter fences its schema, so handlers answer 503 until `db migrate` has run.
