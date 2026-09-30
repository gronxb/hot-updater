---
"@hot-updater/test-utils": patch
---

Add `setupAggregateBatchingTestSuite`, which runs batched aggregates on a key-value store. It checks that reads return what transactional writes return in log and memory mode, that two servers compacting one log under 16 concurrent writers apply each log row once, and that a log row too large for one write is applied in parts.
