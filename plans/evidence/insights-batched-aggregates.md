# Insights: batched aggregates on DynamoDB Local

Recorded on 2026-09-30 (KST) for PRD decision 59 (5): on stores that bill each write, Insights' aggregates
apply in batches outside the event's transaction. The case is "Insights write budgets with batched aggregates
on DynamoDB Local" in `plugins/aws/src/dynamoDB.writeBudgets.integration.spec.ts`, run as

```bash
HOT_UPDATER_WRITE_BUDGET_RATES=1 mise exec java@temurin-21 -- pnpm exec vitest run --project integration:default plugins/aws/src/dynamoDB.writeBudgets.integration.spec.ts -t tenfold
```

Each run records 60 simulated seconds of events at a steady rate, on a table where every installation
launched the day before. Nine events in ten are a returning installation's first launch of the UTC day
(`UNCHANGED`), one in twenty a download and one in twenty an apply, across ios and android. Write units
follow DynamoDB's billing: 2 per KB of each item in `TransactWriteItems`, and 1 per KB of each item a plain
`BatchWriteItem` deletes. The meter reads each request's items, and prices a deleted log item at the size it
was written with. Default windows: log mode compacts every 60 seconds, and memory mode flushes every 15.

"Aggregate" counts everything an event's totals cost: the aggregate items of its transaction, or the log item
it writes plus its share of each compaction (the lease, the group writes, and the log deletes), or of each
memory flush. "Event" is the event's own items: its event row and index copies, and its installation's head.

| Events per second | Mode | Event WRU per event | Aggregate WRU per event | Aggregate items per event | Flushes | WRU per flush |
|---|---|---|---|---|---|---|
| 1 | transactional | 5.0 | 44.6 | 17.35 | – | – |
| 1 | log | 5.0 | 6.1 | 3.28 | 2 | 123 |
| 1 | memory | 5.0 | 7.67 | 3.12 | 4 | 115 |
| 10 | transactional | 5.0 | 41.39 | 16.55 | – | – |
| 10 | log | 5.0 | 3.37 | 2.13 | 2 | 410 |
| 10 | memory | 5.0 | 0.83 | 0.34 | 4 | 124 |
| 100 | transactional | 5.0 | 34.66 | 14.86 | – | – |
| 100 | log | 5.0 | 3.16 | 2.04 | 2 | 3,468 |
| 100 | memory | 5.0 | 0.08 | 0.03 | 4 | 124 |

Aggregate write units per event fall 7.3x at 1 event a second, 12.3x at 10, and 11x at 100 in log mode,
and 5.8x, 50x, and 433x in memory mode. Total write units per event fall from 49.6, 46.4, and 39.7 to
11.1, 8.4, and 8.2 in log mode, and 12.7, 5.8, and 5.1 in memory mode.

Log mode costs at least 3 write units per event: 2 for its log item, deflated under 1 KB, in the event's
transaction, and 1 for its plain delete. At 1 event a second a window holds about 60 events, and the
aggregate rows they touch dominate. A log-mode run's two compactions are the one after its first commit and
the one on flush; in steady traffic there is one per 60-second window, so the WRU per flush above is the cost
of one window. Memory mode's flush writes each aggregate row it changed once, on its process's shard.

The default case in CI measures 10 events a second and checks that both modes cut an event's aggregate write
units at least tenfold. These are DynamoDB Local's request sizes, not a production table's bill.

Host: Apple M4 (10 cores), Docker Desktop, `amazon/dynamodb-local:latest`; the simulated clock makes the
counts independent of host speed.
