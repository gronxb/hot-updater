---
"hot-updater": patch
"@hot-updater/aws": patch
---

The 1.0.0 infrastructure upgrade notes that `hot-updater infra scaffold` writes, and the AWS agent setup, have AWS deployments apply the scaffold's DynamoDB policy before they publish the Lambda. The policy covers the batched Insights log partitions `aggregate_log_0` to `aggregate_log_7` and `aggregate_lease`, and allows `BatchWriteItem`. Under an earlier policy, the server's event writes are denied. The notes' Insights check reads overview summaries through the Console or the admin API on DynamoDB and Firestore, since a read applies pending batches first.
