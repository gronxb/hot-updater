---
"@hot-updater/firebase": patch
---

`firebaseDatabase()` batches Insights' totals by default. An event writes its own documents plus one compressed log document, instead of every total it changes. A compaction merges pending log documents into the totals every minute and deletes them in a plain batch. Set `aggregateBatching: { mode: "memory" }` on a long-lived server, or `false` to write totals in each event's transaction.
