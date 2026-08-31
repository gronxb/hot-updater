# PostgreSQL report accumulation

This implements durable report jobs and bounded accumulation for the four finite
report kinds. It is a building block, not the completed Insights runtime: section
pagination, retention/expiry tooling, historical search, other providers and the
required server/Console contract replacement remain unfinished. The legacy
50,000-row runtime path has not been removed by this change.

## Durable request and publication

`createPostgresInsightsJobs` is an internal request store. It canonicalizes the
query, hashes its semantic/storage revision and retains the complete identity to
detect mismatches. Freshness is a selector, not part of that key. Concurrent polls
reuse one active job; a previous publication remains readable during a refresh.
Future freshness requirements fail validation against the database clock.

Each job fixes `asOfMs` at reservation. The worker captures and saves the committed
source prefix once after claiming that job. Later commits, even with earlier
event timestamps, do not enter that publication. Event content, IDs and source
assignments must remain immutable after capture. Out-of-band raw UPDATE, DELETE
or TRUNCATE is unsupported; the ordinary plugin event API is append-only.

A 30-second database-clock lease has a monotonically increasing epoch. The worker
locks its job and commits projection writes together with its checkpoint. Both
the entry and final write check the lease. If waiting on a publication-head lock
crosses the deadline, the head promotion and all callback writes roll back. A
stale worker cannot publish over a newer lease.

Claiming inspects one indexed candidate. If that candidate is locked it returns
without scanning/refilling from later jobs. The candidate cutoff uses the SQL
statement timestamp so future leases are excluded by the index boundary; lease
expiry checks still use the current database clock. Missing claim/projection
indexes fail explicitly before the corresponding work.

An unavailable source releases the same job back to queued, without inventing a
source generation or retrying within that invocation. A failed batch rolls back
and records terminal failure. Polling does not create a new job to silently retry
poison data. Explicit terminal-failure recovery tooling is still pending.

## Exact accumulation

- Bundle summaries retain distinct `(metric, bundle, installation)` membership.
  Batches do not create unused cohort or bucket memberships.
- Bundle detail counts summary, UTC bucket and cohort memberships independently.
  Applying **to** and recovering **from** a bundle remain separate metrics.
- Installation overview keeps the newest `(event time, ID)` per installation.
- Active overview keeps the newest row per installation and per rolling bucket.
  The final phase applies the user filter to the newest window identity, then
  counts all stored bucket activity for selected installations, including events
  under an older user identity. Its buckets remain anchored at `asOfMs-duration`.

Private storage keys are fixed-size hashes with complete identities retained and
checked. Arbitrarily long valid cohort labels are not truncated or newly rejected.
No full-label B-tree index is created: a real 1,400-character Unicode label was
shown to exceed PostgreSQL's index tuple limit during review. Bounded, correctly
ordered section pages for these labels remain a release requirement, not a
fallback sort performed during a read.

Completed summary metadata is bounded to 100 requested bundles (200 counters),
or one overview/detail summary. Output belongs to its immutable job ID; computing
a successor does not alter the previous job's counters.

An empty bundle batch captures a real source generation and completes without
reading events. Its zero result needs no membership scan. Query and publication
JSON also preserve valid zero-match NUL/surrogate strings rather than failing on
PostgreSQL JSONB conversion; raw event fields are not changed to accommodate them.

## Explicit maintenance

```ts
import {
  createPostgresInsightsReportWorker,
  migratePostgresInsightsReports,
} from "@hot-updater/postgres/db";

// Explicit schema tooling. Creates empty private tables, without reading events.
await migratePostgresInsightsReports(db);

// Requires the separate source migration and completed source preparation.
// Runtime report reservation is not wired into the public provider yet.
const worker = createPostgresInsightsReportWorker(db);
const result = await worker.runStep({ maxItems: 256, maxRequests: 128 });
```

The budgets count returned database rows and SQL requests, including transaction
boundaries and control reads. This provider requires at least 256 items and 128
requests: one indivisible final installation may require its latest row, 30 bucket
rows and 92 counter results. The worker reserves 32 requests/rows for control and
caps source/finalization pages by the remaining worst-case budget. Each source
page is also capped at 200 events. Larger budgets do not remove that cap. A failed
transaction may consume its original budget before recording failure; that final
control write is included in the reserved overhead.

These bounds do not measure arbitrary physical disk I/O, bytes or wall-clock
duration. Native source and claim index plans are separately checked. SQL schema
maintenance must not race running workers. The common all-provider maintenance
runner and operational scheduling still need integration.

## Verification

Meaningful worker regressions cover independent membership dimensions, duplicate
events, long Unicode cohort labels, latest-identity changes, timestamp ties, all
30 shifted buckets, a captured prefix with a late old-timestamp append, reuse of
the previous publication, and late batch rollback without automatic retry.
Instrumented requests/returned rows stay within the declared budgets.

A 50,001-event PostgreSQL fixture is consumed in bounded steps and includes its
last event in the completed exact summary. It verifies accumulated source progress
of exactly 50,001 and a maximum of 200 source events per step. This is not an
ingestion-throughput benchmark or evidence for every provider/report family.

Job-store tests additionally cover malformed state/output, source/checkpoint
transitions and a 50,001-future-job claim plan without a sequential scan, sort or
filtered history traversal. Real PostgreSQL 15 tests exercise 20 simultaneous
polls, eight competing claims, a locked candidate, epoch fencing and publication
expiry while waiting for a head lock.
