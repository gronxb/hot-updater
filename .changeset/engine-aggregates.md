---
"@hot-updater/server": minor
"@hot-updater/test-utils": minor
---

Add aggregates to engine transactions in the unstable `@hot-updater/server/database` subpath. `tx.aggregate(model, identity, changes, { shardBy })` records counter and gauge deltas and HLL sketches for one shard row. `shardBy` picks the shard with a stable FNV-1a hash, and gauges of a sharded aggregate require it, so each −1/+1 pair lands on one shard.

At commit, counter-only rows become blind increments that create the row and bump `_v`. Rows with gauges or sketches are read in one batch per table, merged, and written back under a guard, and a row whose counters and gauges reach zero is deleted. When only aggregate rows fail their guard, or the adapter reports a transient failure, the engine re-reads those rows and resends the write instead of rerunning `fn`. `retry.onRetry` reports each rerun and resend.

The engine assembly moves to `createEngine`, which addresses tables by physical name; `createDatabaseEngine` adds the typed `database(module)` handle on top of it.

`@hot-updater/test-utils` adds `runContentionHarness`, which starts transactions at a steady rate through a fixed pool and counts how they ended, and `withAdapterLatency`, which delays every adapter call.
