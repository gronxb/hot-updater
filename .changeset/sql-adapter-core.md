---
"@hot-updater/server": minor
"@hot-updater/test-utils": patch
---

Add the shared SQL core to the unstable `@hot-updater/server/database` subpath. `createSqlAdapter({ executor })` compiles adapter reads and writes to SQL for PostgreSQL, MySQL, and SQLite and runs them through a `SqlExecutor` (one per driver or ORM), with one transaction per write.

Guards are `UPDATE … WHERE _v = ?`, checks are locking reads (`FOR UPDATE`, or SQLite's `BEGIN IMMEDIATE`), counters are upserts, and index reads compare order tuples with row values (expanded ORs on MySQL). Unique and foreign-key violations name the failed op. Serialization failures, deadlocks, lock timeouts, and `SQLITE_BUSY` ask the engine to retry.

`createTableStatements` emits DDL with binary collation (`COLLATE "C"`, `utf8mb4_0900_bin`, SQLite's `BINARY`), `bigint` whole numbers, and an index table `<table>__<index>` for each index over a multi-valued field.

The adapter conformance suite in `@hot-updater/test-utils` now also orders a key with a trailing space after the same key without it.
