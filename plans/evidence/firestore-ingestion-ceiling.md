# Database adapter redesign: Firestore ingestion ceiling

Recorded on 2026-09-24 (KST) for D9 (PRD metric "Firestore and Supabase ingestion ceilings: measured and
recorded"). The measurement is `plugins/firebase/src/firestore.ingestion.integration.spec.ts`, which logs one
`firestore-ingestion-ceiling` JSON line:

```bash
HOT_UPDATER_INGESTION_CEILING=1 pnpm exec vitest run --reporter=default --project integration:default plugins/firebase/src/firestore.ingestion.integration.spec.ts
```

Without `HOT_UPDATER_INGESTION_CEILING=1`, it runs one step of 200 moves at 50 per second. It asserts only
that a move either commits or runs out of retries (`DatabaseConflictError`), since the figures depend on the
host.

The scenario and ladder are the same as Supabase's (`supabase-ingestion-ceiling.md`): B3's rollout, where each
event moves one installation from release A to release B on one channel, through the Insights plugin, the
engine, D7's key-value helper, and the Firestore store. Each step first moves 600 installations onto A, then
moves the same 600 from A to B at the offered rate, over 16 writers, with 5 ms added to every adapter call.
Firestore is the emulator that `firebase-tools` starts (cloud-firestore-emulator v1.22.0).

| Offered/s | Committed | Errors | Resends | Retried | Achieved/s |
|---|---|---|---|---|---|
| 50 | 600 | 0 | 0 | 0% | 50 |
| 100 | 600 | 0 | 7 | 1.2% | 100 |
| 200 | 600 | 0 | 2 | 0.3% | 199 |
| 400 | 600 | 0 | 52 | 5.0% | 29 |
| 800 | 600 | 0 | 70 | 7.8% | 16 |

**Ceiling on the emulator: 200 moves per second**, the highest offered rate that was kept up with, no errors,
and at most 5% retried. Every move committed, and no step reran a transaction.

## Why throughput collapses above it

The emulator waits at most 2 seconds for a document lock (`LOCK_ACQUIRE_TIMEOUT`, a constant in the
emulator), then fails the request with `Transaction lock timeout`, and the client reruns the transaction. A
read lock conflicts with a write lock, and a transaction's read lock becomes a write lock when it writes the
document. So two transactions that read the same row and then write it wait on each other until one times out,
and each such conflict costs a writer 2 seconds.

The store reads a document inside its transaction only when an op guards it. Of the rows a move guards, only
Insights' gauge and sketch rows (32 and 16 shards) are shared between moves: Insights reads, merges, and writes
them back under a `_v` guard. At 400 and 800 offered moves per second, all 16 writers were busy, and 202 lock
waits timed out in the run, most of them from the 400 step on. Throughput fell to 29 and 16 moves per second.

Firestore's documentation says that contention is resolved "by delaying or failing one of the operations"
([Transaction data contention](https://docs.cloud.google.com/firestore/native/docs/transaction-data-contention))
and gives no fixed lock timeout. So these figures describe the store on the emulator, not a bound for a Firestore
project, which also adds a network round trip to every call.

## Counters increment without a read

Counter rows (8 shards) are the most contended. The Insights schema treats them as blind increments, and the
store now increments them with `update`, which needs the document but reads nothing, so they hold no read lock.
When a counter row is missing, the commit fails with `NOT_FOUND`, and the write reruns, reads it, and creates it
from `init`. That happened in 16 commits, all when the first moves onto A, and then to B, created their rows.

An earlier version read every counted document in the transaction. Of four ladder runs of it, two kept up at
every rate (100 moves per step at 5 to 80 per second, and 300 at 10 to 160), and two collapsed. One of those,
with this ladder, timed out about 225 lock waits a minute from its second minute on and was stopped after 9
minutes; the other achieved 4 moves per second with 200 moves offered at 50.

Host: Apple M4 (10 cores), with the emulator on the host JVM (Temurin 21) while another integration suite ran
in the local PR gate (load average about 4).
