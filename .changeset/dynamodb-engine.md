---
"@hot-updater/aws": minor
"@hot-updater/server": patch
"hot-updater": patch
---

Run DynamoDB on the new storage engine. `dynamoDB(config)` keeps its signature and its CloudFront invalidation after commits that change bundles or patches.

- **One table, no secondary index:** the plugin is the key-value helper over one table keyed by string `pk` and `sk`. Each row is an item. Each index a row belongs to adds an item holding a copy of it, written in the same transaction. Reads are strongly consistent, and a write is one `TransactWriteItems` with a client request token. Commits over 100 items, 4 MB, or 400 KB in one item are refused before anything is written.
- **Schema settings:** the plugin checks the schema settings before its first read and answers 503 until they exist. `migrateDynamoDB(config)` writes them, and creates the table when it is missing. `hot-updater init` runs it after creating the table, the agent scaffold ships the same items as `dynamodb/schema-settings.json`, and the DynamoDB example runs it before registering its API key.
- **Infrastructure:** `hot-updater init` creates the table without `hot-updater-update-index` and refuses a table that still has it, which a 1.0 release candidate created. The IAM policy allows the key-value store's reads and writes on each table's partitions, `<table>` and `<table>#*`.
- **Insights shards:** gauge aggregates (`insights_distribution`, `insights_latest_by_bundle`) now spread over 32 shards, on every backend. DynamoDB's contention gate retried 2–24% of rollout moves at 16 and 1–5% at 32. Sketches stay at 16, since every read merges their 2 KB registers, and counters stay at 8. Rows already written on shards 0–15 keep counting.
- **Removed:** the DynamoDB implementation (about 4,200 lines) and `DYNAMODB_UPDATE_INDEX_NAME`.
