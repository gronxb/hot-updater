# PostgreSQL reports and historical installation searches

This implements durable report jobs and bounded accumulation for the four finite
report kinds, all five section-page families and historical contains searches.
It is a building block, not the completed Insights runtime: live installation
pages, retention/expiry tooling, other providers and the required server/Console
contract replacement remain unfinished. The legacy
50,000-row runtime path has not been removed by this change.

## Durable request and publication

`createPostgresInsightsJobs` is an internal request store. It canonicalizes the
query, hashes its semantic/storage revision and retains the complete identity to
detect mismatches. Freshness is a selector, not part of that key. Concurrent polls
reuse one active job; a previous publication remains readable during a refresh.
Future freshness requirements fail validation against the database clock.

Each report job fixes `asOfMs` at reservation. The worker captures and saves the
committed source prefix once after claiming that job. Later commits, even with earlier
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
indexes or metadata primary keys fail explicitly before the corresponding work.

An unavailable source releases the same job back to queued, without inventing a
source generation or retrying within that invocation. A failed batch rolls back
and records terminal failure. Polling does not create a new job to silently retry
poison data. Explicit terminal-failure recovery tooling is still pending.

## Exact accumulation

- Bundle summaries retain distinct `(metric, bundle, installation)` membership.
  Batches do not create unused cohort or bucket memberships.
- Bundle detail counts summary, UTC bucket and cohort memberships independently.
  Applying **to** and recovering **from** a bundle remain separate metrics.
- Installation overview keeps the newest `(event time, ID)` per installation and
  distinct historical installation/user/legacy-username aliases from that same
  captured source and event-time cutoff.
- Active overview keeps the newest row per installation and per rolling bucket.
  The final phase applies the user filter to the newest window identity, then
  counts all stored bucket activity for selected installations, including events
  under an older user identity. Its buckets remain anchored at `asOfMs-duration`.

Private storage keys are fixed-size hashes with complete identities retained and
checked. Arbitrarily long valid cohort labels are not truncated or newly rejected.
No full-label B-tree index is created: a real 1,400-character Unicode label was
shown to exceed PostgreSQL's index tuple limit during review. The separate
ordering phase handles complete labels without building such an index.

Completed summary metadata is bounded to 100 requested bundles (200 counters),
or one overview/detail summary. Output belongs to its immutable job ID; computing
a successor does not alter the previous job's counters.

An empty bundle batch captures a real source generation and completes without
reading events. Its zero result needs no membership scan. Query and publication
JSON also preserve valid zero-match NUL/surrogate strings rather than failing on
PostgreSQL JSONB conversion; raw event fields are not changed to accommodate them.

## Historical identity preparation

The global installation overview now prepares an immutable alias set alongside
its latest-installation records. Each raw event contributes at most three
identities: `(kind, JS-lowercase value, original install ID)`. Null values are
omitted; empty strings, whitespace and Unicode normalization forms are preserved.
An activity event with unchanged identities does not create more alias records
or update their existing versions. Identity payloads use JSON, with fixed-size
hash keys and full identity checks; long valid values are not placed in a B-tree.

Alias writes, latest metadata and source checkpoints commit in the same leased
transaction. A failed alias insert rolls back the latest record and checkpoint.
Aliases at or after the event-time cutoff and late commits outside the captured
source prefix do not enter that publication. Refreshing produces another set;
it never changes the old set or its latest metadata.

An internal alias page reads at most 200 rows through `(job_id, alias_key)`.
Matched installations resolve through at most 200 hash points in the same
publication's whole-period latest records. Duplicate matches are collapsed and
missing/corrupt latest records fail rather than shortening the result. Neither
read accesses raw events. Index readiness is checked before either data query.

`getSearch` now reserves one private contains job for the complete JS-lowercased
query and current storage revision. Page size, requested freshness and base ID
are excluded from that semantic key. Search and global-overview reservations,
including the base foreign-key reference, commit together. Existing searches
return before reserving another base. The public report-query union stays at
four report kinds; this is not a new general-purpose job or query API.

A search waits for its pinned base, then copies that publication's actual
`asOfMs/sourceGeneration` once. It never labels old data with the search request's
arrival time or silently switches to a new base. A higher freshness request
reuses a running generation; if its eventual publication is too old, the next
poll reserves the next generation and retains the old one as `previous`.
Failed bases fail their dependent searches visibly, without an implicit retry.

The worker scans alias pages, applies literal substring matching, validates all
matched alias-to-installation identities, and stores one `installationIds` set
entry per installation. Its value must remain exactly one. Repeated aliases or
replayed batches cannot inflate the count. A page without matches still advances
by its final alias; the worker never refills it in the same step. It validates
frozen latest metadata before committing matches and progress together.

After the complete alias set is consumed, the existing fixed-size merge stages
sort full installation IDs with JS string comparison. Only a complete ordered
set can publish an exact total. Internal `pageContains` then returns at most 100
installation rows through ordinal ranges and frozen latest points in one
read-only, repeatable-read transaction. Cursors bind normalized query, snapshot
mode, publication and ordinal while allowing page-size changes. A pinned request
never creates work; a conflicting freshness requirement is an input error.

The base reference uses `ON DELETE RESTRICT` and a referencing index. Cleanup
must delete derived rows and their job in the same transaction so a live search
reference rolls the whole deletion back. It does not protect arbitrary manual
deletion of individual derived rows. `FOR NO KEY UPDATE` preserves job fencing
while allowing foreign-key pins without a head/job lock-order deadlock.

These internal helpers are not yet connected to the required public provider,
HTTP/RPC or Console ports. Live all/exact installation browsing is separate and
still unfinished.

## Ordered preparation and immutable pages

Each cohort/distribution/installation-ID section first copies at most 32 records
through a `(job_id, section, metric, count_key)` index. It sorts that small run using
JavaScript string comparison. Subsequent steps merge two persisted runs, reading
at most 32 rows from each and emitting at most 32. Checkpoints advance only by
consumed input; unused candidates are read again next time. Run rows and merge
positions commit under the existing job lease. No read request sorts all labels,
uses SQL OFFSET, or scans raw history. Distribution ranks use count descending,
then the full label ascending; cohorts use label ascending.

The UTC bucket index covers only movement-series counters; the sort-input index
covers only the four ordered sections. A generic bucket index was shown to make
PostgreSQL read 137 cohort counters and sort them to return 32. Conversely, the
generic sort-input index introduced an unnecessary sort for a movement bucket.
Restricting both indexes removes these unrelated competing access paths;
readiness verifies their exact partial predicates. Native plan checks also
exercise the count-key input seek and final ordinal seek with more than 50,000
rows.

The worker requires every ordered section to be ready before publishing. Active
reports prepare both current bundle distribution and total bundle observations;
these rankings are different. Missing final run positions fail as invalid output
rather than silently ending the list. Intermediate passes remain stored until
bounded retention tooling is implemented; this slice does not delete them.

`createPostgresInsightsReportPages` remains an internal provider building block.
One read-only, repeatable-read transaction resolves the immutable publication,
its section metadata, and its requested rows. A missing publication returns
`expired`; a known unpublished job fails explicitly as not ready. Refreshing the
query never changes a cursor's publication. The ordinal bookmark is a native
indexed position, not a count of records to skip. Cursors bind publication,
section, metric and optional bundle filter, while allowing a different page size.

- Movement series fill ascending UTC buckets with zeros. All-time starts at that
  metric's first nonempty bucket, using a native first-row index lookup; an empty
  metric contains the current UTC day with zero. Only the requested buckets are
  generated, even for decades of history.
- Movement cohorts and bundle distribution read contiguous final-run positions.
- Active series preserve the rolling buckets anchored at `asOfMs-duration`.
- Active bundle series flatten total-observation rank and bucket position. All
  cursor multiplication/division uses BigInt with checked signed-bigint bounds.
  A known exact bundle filter includes its zero buckets; an unknown filter is
  empty. Filtered cursors use local bucket positions and cannot be reused for
  another bundle or for the unfiltered series.

Sparse counter point reads compare complete stored identities with their hashes.
Zero-match query IDs containing NUL or unpaired surrogates are hashed before SQL
binding and are not silently changed or rejected by the PostgreSQL text format.

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

The current private job storage revision is 2. Older draft schema/jobs must be
deliberately recreated and prepared again; current readers do not decode old
query keys or reuse alias-free overviews. Readiness requires the base reference,
its native index and the nullable pre-binding cutoff. There is no compatibility
marker, automatic table replacement or raw-event rewrite.

For an unreleased draft installation only, stop workers/readers and explicitly
drop these derived tables together before applying the current report migration:

```sql
DROP TABLE IF EXISTS
  private_hot_updater_insights_report_aliases,
  private_hot_updater_insights_report_order_rows,
  private_hot_updater_insights_report_order_states,
  private_hot_updater_insights_report_counts,
  private_hot_updater_insights_report_latest,
  private_hot_updater_insights_report_members,
  private_hot_updater_insights_report_heads,
  private_hot_updater_insights_report_jobs;
```

This invalidates draft report/search publications. Keep `bundle_events` and every
`private_hot_updater_insights_source_*` table intact. Run
`migratePostgresInsightsReports(db)` afterwards, then resume preparation. No
schema DDL or manual derived-row mutation may race running readers/workers.

The budgets count returned database rows and SQL requests, including transaction
boundaries and control reads. This provider requires at least 256 items and 128
requests: one indivisible final installation may require its latest row, 30 bucket
rows and 92 counter results. The worker reserves 32 requests/rows for control and
caps source/finalization pages by the remaining worst-case budget. Each source
page is also capped at 200 events. Larger budgets do not remove that cap. A failed
transaction may consume its original budget before recording failure; that final
control write is included in the reserved overhead.

An alias write uses at most two SQL requests and three returned identity rows,
within the existing source-step budget. An alias page or frozen-latest lookup
uses two SQL requests and at most 201 returned rows including index readiness.
Latest lookup accepts at most 200 input keys before deduplication; empty input
performs no SQL. These helpers do not perform hidden refills or raw-history reads.

A contains alias step reads N aliases, M distinct matching latest rows and M
stored match identities (M ≤ N). Its six data statements return at most 3N+2
rows. Including the control reserve, it chooses
`min(200, floor((maxItems - 34) / 3))` aliases. The 256-item minimum allows 74;
the full 200-alias page requires at least 634 items. A zero-match page skips
latest and membership queries. Sorting retains the same 32-row output budget.

An ordering step uses at most eight SQL requests and 67 returned rows, excluding
the caller's reserved lease/transaction overhead. It emits at most 32 rows.
Section pages return at most 100 user rows. Native ordinal and sparse-counter
queries read only the relevant ranks/keys; zero filling uses the immutable total,
without a lookahead refill. These are row/request limits, not byte-size limits
for arbitrarily long labels.

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
