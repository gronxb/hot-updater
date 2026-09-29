---
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"@hot-updater/test-utils": minor
---

Add the storage adapter contract that every Hot Updater database runs on. An adapter implements batched `get`, index-range `query`, and atomic `write` of guarded ops with its backend's native features, and knows nothing about Hot Updater's domain. `@hot-updater/plugin-core/internal` ships the contract types, value conversion for backend types (int8 text, BigInt, Decimal, SQLite 0/1, JSON text), a `verifyAdapter` wrapper that checks every read and write at the adapter boundary and counts reads, and the reference memory adapter. `@hot-updater/server/database` re-exports them for adapter authors.

`@hot-updater/test-utils` adds `setupDatabaseAdapterConformanceSuite`: value round-trips, point and range reads, UTF-8 byte ordering, cursor paging without gaps or repeats, multi-valued and unique indexes, full pages under capped native pages, atomic batches with a failure injected at every op, one winner among 32 concurrent writers, no lost increments, write-skew rejection, and over-limit writes rejected before sending.
