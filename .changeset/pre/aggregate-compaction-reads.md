---
"@hot-updater/plugin-core": patch
---

perf(plugin-core): aggregate compactions on DynamoDB, Firestore, and Cosmos DB no longer read again what they already read.

- After a rollback to a release without one of an aggregate's tables, the newer release's log rows waited for a process that could apply them, and every Insights read compacted again to find none. Reads now step past such rows once they are 5 minutes old; the rows still wait for a process that can apply them.
- A compaction reads each aggregate row once per group, where it read them again each time a group halved to fit one write.
- The rows a group leaves for the next are not read again.
