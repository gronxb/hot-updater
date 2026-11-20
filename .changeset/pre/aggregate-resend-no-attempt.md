---
"@hot-updater/plugin-core": patch
---

**Database engine.** A transaction no longer fails with `DatabaseConflictError` because the aggregate rows it writes are busy, so Insights stops answering an occasional `503` under load. When a transaction's write loses only its aggregate rows (gauges and distinct counts, merged under a version guard) to another writer's commit, the engine reads those rows again and resends the write, as before. That resend no longer spends one of the `retry.attempts`: each such loss means another writer committed, so the system made progress and the transaction keeps going. A failed round with no sign of another commit (a transient database error, or rows read back unchanged) still counts, and so does every rerun of `fn`. Under 64 connections at 400 moves a second on PostgreSQL, about 1% of Insights writes used to run out of their 8 attempts; now every write commits.
