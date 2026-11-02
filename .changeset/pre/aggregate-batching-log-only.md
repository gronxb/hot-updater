---
"@hot-updater/plugin-core": patch
"@hot-updater/server": patch
"@hot-updater/test-utils": patch
"@hot-updater/aws": patch
"@hot-updater/azure": patch
"@hot-updater/firebase": patch
---

Remove `aggregateBatching: { mode: "memory" }`, which kept a process's aggregate changes in a buffer until a timer wrote them, so a crash lost them. Batched aggregates now always go through log rows, in the same write as the transaction that made them. `aggregateBatching: { windowMs }` and `aggregateBatching: false` stay, and `mode` is gone from the type, so `{ mode: "log" }` and `{ mode: "memory" }` are TypeScript errors: delete the key.

- A JavaScript config that still passes `mode` runs the same way: the key is ignored. Its `windowMs`, or 60 seconds without one, is how often a commit compacts.
- `dynamoDB`, `firebaseDatabase`, and `cosmosDatabase` need no migration: log rows live in the same table, collection, or container, under the same indexes. A hand-written DynamoDB policy with a `dynamodb:LeadingKeys` condition must list `aggregate_log_0` to `aggregate_log_7` and `aggregate_lease`, as the managed policy does.
- A report on these stores costs about 3 more write units than it did in memory mode, for its log row and the row's delete. Totals on other shards keep counting: reads sum every shard.
- `hot-updater db migrate` creates no log tables. A store with a table per model that you passed `aggregateBatching` yourself, such as a custom SQL adapter, used to run memory mode without them; its batched writes now fail until you run `adapter.migrations.apply(aggregateBatchingTables)` or drop the option.
- `hotUpdater.flush()` stays and merges pending log rows. A server no longer needs it before exiting. `createEngine(...).dispose()`, which only stopped the removed timer, is gone: delete the call.
