---
"@hot-updater/aws": patch
---

`dynamoDB()` batches Insights' totals by default. An event writes its own items plus one compressed log item, under the partitions `aggregate_log_0` to `aggregate_log_7`, instead of every total it changes. A compaction merges pending log items into the totals every minute and deletes them with `BatchWriteItem`, under the lock item `aggregate_lease`. Set `aggregateBatching: { mode: "memory" }` on a long-lived server, or `false` to write totals in each event's transaction. The managed IAM policy allows `BatchWriteItem` and the new partitions; rerun `hot-updater init` to update an earlier setup's policy. Without `BatchWriteItem`, log items are deleted through `TransactWriteItems` instead.
