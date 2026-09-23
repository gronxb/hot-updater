# Database adapter redesign: DynamoDB rollout gate

Recorded on 2026-09-24 (KST) for D8 (PRD: "contention gate on DynamoDB Local with 16 writers, zero exhausted
retries, at most 10% retried"). The gate is `plugins/aws/src/dynamoDB.contention.integration.spec.ts`: B3's
rollout, where each event moves one installation from release A to release B on one channel, through the
Insights plugin, the engine, D7's key-value helper, and the DynamoDB store, on `amazon/dynamodb-local`.
It seeds 3,000 installations onto A, then moves them to B at 100 per second over 16 writers, with 5 ms added
to every adapter call. Every run committed all 3,000 moves with no exhausted retries.

| Gauge shards | Sketch shards | Retried moves, one run each |
|---|---|---|
| 16 | 16 | 16.4%, 4.1%, 24.2%, 14.1%, 12.8%, 2.1% |
| 32 | 32 | 2.3%, 2.9%, 6.8% |
| 32 | 16 | 5.2%, 1.1%, 2.9% |

At 16 shards, 103 of 126 failed guards in an instrumented run were on `insights_distribution` gauge rows,
21 on sketches, and 2 on `insights_latest_by_bundle`. A write averaged 15 items.

The Insights schema now shards gauges 32 ways and keeps sketches at 16, since each sketch shard row holds 2 KB
of registers that every read merges. Counters stay at 8.

Host: Apple M4 (10 cores), Docker Desktop with 6 CPUs, while the local PR gates ran other integration suites
(load average 3 to 8). DynamoDB Local shares Docker's CPUs, so its transaction latency, and with it the gap
between a move's aggregate reads and its guarded write, varies with that load.
