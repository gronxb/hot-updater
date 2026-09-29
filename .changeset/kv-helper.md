---
"@hot-updater/plugin-core": patch
"@hot-updater/server": minor
"@hot-updater/test-utils": patch
---

Add the key-value helper, from `@hot-updater/server/database`, which the DynamoDB and Firestore databases run on. `createKvAdapter({ store, tablePrefix })` implements the storage adapter over a `KeyValueStore`, which provides strongly consistent point reads, one partition's sort-key range per page, and atomic writes whose conditions see the state before the write.

- **Layout:** a row is one item at `pk = <table>`, `sk = enc(key)`, where `encodeKvKey` keeps tuple order as UTF-8 order. An index in key order reads the row items. Every other index adds an item per entry at `pk = <table>#<index>#enc(eq)`, `sk = enc(order)`. A unique entry is one item, written only where no row holds it.
- **Index copies:** an index item holds a copy of the row without `_v` or counters (the columns with a default). An increment changes only those, so it never makes a copy stale. An increment on a table with index items may change only counters of an existing row. Reads fill counters from the rows, and a unique read outside a transaction takes one read.
- **Pages and limits:** `query` reads native pages until the limit or the range's end. `fits()` counts items and bytes against the store's limits.

The engine reads a row whole with `get` where a transaction guards it and the adapter returned an index copy, and reruns if the row changed since. Reads outside a transaction no longer return `_v` on any backend; their rows are typed `ReadRow`. The Release Catalog suite in `@hot-updater/test-utils` now commits at most three Releases, with their bundles, at a time. That fits DynamoDB's 100 items per transaction.
