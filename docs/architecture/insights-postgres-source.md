# PostgreSQL Insights source preparation

This is the committed-source building block for exact Insights reports. It does
not implement reports or replace the existing runtime query APIs yet. Raw events
remain in `bundle_events`; the added fields identify the committed source prefix
that a report can safely consume.

## Deployment order

1. Schedule a maintenance window and drain old writers. Apply the ordinary base
   schema first on a fresh database.
2. Apply `migratePostgresInsightsSource(db)` from `@hot-updater/postgres/db`.
   This is explicit DDL, never an append/startup backfill. The transaction adds
   source fields, counters, state and a partial index. Creating the index scans
   the existing table and holds a write-blocking lock. Its duration depends on
   the database size; this migration is not a zero-downtime operation.
3. Deploy the new writer. Every accepted event and its source counter commit in
   the same transaction, including mixed catalog/event commits. Old writers are
   fenced by a `NOT VALID` check constraint: they cannot insert unmarked events.
   Do not restore an old writer while leaving this source protocol enabled.
4. Run bounded backfill steps through maintenance tooling. New writers can
   continue accepting events during backfill. Captures remain unavailable until
   every legacy row in the fixed primary-key range has been processed.

For an existing root `Kysely` connection:

```ts
import {
  createPostgresInsightsSourceTools,
  migratePostgresInsightsSource,
} from "@hot-updater/postgres/db";

// Run during the explicit schema-maintenance window, before deploying writers.
await migratePostgresInsightsSource(db);

// One bounded maintenance invocation; schedule further steps until ready.
const source = createPostgresInsightsSourceTools(db);
const progress = await source.backfillStep(200);
```

`backfillStep` accepts 1–200 rows. Its first invocation captures the upper raw ID;
subsequent calls read at most the requested number of raw rows, including rows
already assigned by new writers. It never scans until it fills a batch of only
unassigned rows. Source assignments, counters and checkpoint advance in one
transaction. A failed step can be retried without replacing raw event fields.
The shared `runStep({ maxItems, maxRequests })` runner is still a later integration
step; this provider method must not be presented as that completed runner.

## Captures and source pages

Once backfill is ready, `capture()` returns an opaque generation containing the
persisted source identity and the committed counter prefix for each provider
shard. It does not use the largest event timestamp or a nontransactional SQL
sequence. A later commit with an older timestamp belongs to a later prefix.

Call `readPage({ sourceGeneration, shard, afterSequence, limit })` from maintenance
code to consume a captured prefix. Pages contain at most 200 events and preserve
bigint sequence values as strings. Consumers persist progress together with their
derived output; this source helper alone does not implement report leases or
atomic publication. Missing sequence rows and a mismatched source identity fail
explicitly instead of certifying incomplete output.

The sixteen-shard layout belongs to this PostgreSQL storage revision, not to the
public plugin contract. Mixed commits acquire shard locks in ascending order.
The throughput of this layout still needs a concurrent ingest benchmark; its
existence alone does not prove a particular MAU or writes-per-second capacity.

Raw-event retention is unchanged. After capture, event content, IDs and source
assignments must remain immutable. Out-of-band UPDATE, DELETE or TRUNCATE of raw
events is unsupported; the ordinary event API is append-only. Do not delete
counters, change the source identity or rewrite assignments to recover a failed
report job. The prefix certifies committed ingestion, not arbitrary later edits.

The [report accumulator](./insights-postgres-reports.md) now consumes these pages
with durable leases/checkpoints. Its summary publications are implemented as an
internal building block; section pages and runtime query replacement remain open.

Capture, source pages, backfill and migration retries check the required source
index. A missing or incompatible index produces a preparation error before raw
queries; these operations do not automatically repair indexes or fall back to
scanning. Concurrent manual schema changes are outside the migration contract.
