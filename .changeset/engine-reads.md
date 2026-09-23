---
"@hot-updater/server": minor
---

Add engine reads to the unstable `@hot-updater/server/database` subpath. A module's typed `HotUpdaterDatabase` handle has `findOne` (by key or a unique field), `findMany` (one page of a declared index: every eq field bound, an optional range on the first order field, order, a limit up to `maxPageSize`), and `findAggregates` (logical rows with shards merged). There is no count, offset, or free-form filter. A page returns `next` only when it is full, and the cursor is bound to the model, index, eq values, order, and range, so it cannot resume another read. An aggregate row cut off by the limit is completed by reading only its remaining shards.

`createDatabaseEngine({ verify: true })` checks every adapter call and `measureReads` reports what one call read from the adapter and returned to the caller. Misused reads fail to type-check with messages that name the right read.
