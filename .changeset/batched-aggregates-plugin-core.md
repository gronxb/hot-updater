---
"@hot-updater/plugin-core": patch
---

`EngineDatabase` takes `aggregateBatching` (`AggregateBatching`), which sets how a database that bills each write batches the aggregates that plugins declare `batched`. `DatabaseAdapter` gains an optional `deleteConsumed(table, rows)`. It deletes rows the caller has already recorded as consumed, together with their index entries, without guards and not atomically. Backends that bill transactional deletes more can implement it with their plain batch delete.
