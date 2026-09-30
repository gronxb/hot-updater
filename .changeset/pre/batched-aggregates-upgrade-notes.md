---
"hot-updater": patch
"@hot-updater/aws": patch
---

The 1.0.0 infrastructure upgrade notes that `hot-updater infra scaffold` writes, and the AWS agent setup, list the DynamoDB policy's batched Insights log partitions, `aggregate_log_0` to `aggregate_log_7` and `aggregate_lease`, and its `BatchWriteItem` permission. The IAM policy changed: rerun `hot-updater init`, and recreate release candidate data if needed. The notes' Insights check reads overview summaries through the Console or the admin API on DynamoDB and Firestore, since a read applies pending batches first.
