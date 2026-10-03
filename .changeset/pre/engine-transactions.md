---
"@hot-updater/server": minor
---

Add the storage engine's transactions, from `@hot-updater/server/database`. `db.transaction(fn)` hands `fn` a handle whose `findOne` records every row it reads, null reads by key included, and whose `findMany` reads only rooted indexes, guarding the range through its parent row. `create`, `update` (a patch of a row read in the same transaction), and `delete` coalesce into one op per key, guarded by the version each read saw.

A failed guard on a row the transaction read reruns `fn` with jittered backoff until the retry budget runs out (`DatabaseConflictError`). `DatabaseConstraintError` reports `exists`, `unique`, `not_found`, `referenced`, and `too_large` only when the current state confirms them, and a write whose outcome is unknown is reported as `DatabaseAmbiguousCommitError` and never rerun. References keep per-relation counters on the parent: `restrict` refuses the delete, and `cascade` deletes the children too. A write sends its inserts first and its deletes last, children before parents. Calling `db.*` inside `fn`, or using the handle after it returns, throws `DatabaseTransactionError`.
