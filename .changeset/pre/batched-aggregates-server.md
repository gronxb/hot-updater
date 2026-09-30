---
"@hot-updater/server": patch
---

Aggregates declared with `batched: true` in `defineAggregate` apply after the transaction that changed them commits, merged with other transactions' changes into one write per aggregate row, on a database that batches aggregates. Insights' counters, gauges, and sketches are batched; core's bundle counters are not.

- In `aggregateBatching: { mode: "log" }`, the default, a transaction that changes a batched aggregate also writes one compressed log row in the same atomic write. A compaction applies a group of pending log rows in one write, together with a lease row that lists them as applied, then deletes them. Only one compaction runs at a time, under the lease. No crash loses a change or applies one twice. A commit starts a compaction once `windowMs`, 60 seconds by default, has passed since the last one. A read of a batched aggregate compacts first; when it cannot write, it serves the stored aggregates and logs one warning.
- In `aggregateBatching: { mode: "memory" }`, meant for a long-lived server, changes stay in the process and are flushed every `windowMs`, 15 seconds by default. No log rows are written, but a crash loses up to one window. `hotUpdater.flush()` applies what is pending before the process exits.

A batched gauge can be negative on one shard row, because each write puts a row's net change on a single shard; reads sum the shards. `createEngineDatabase` takes `aggregateBatching`. `@hot-updater/server/database` exports `aggregateBatchingModule`, the log and lease tables that an engine which batches needs in its schema. The key-value helper implements the adapter's optional `deleteConsumed` when its store does.
