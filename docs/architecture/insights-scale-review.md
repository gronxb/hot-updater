# Insights scalability implementation evidence

Date: 2026-09-01. Full target: [scale plan](./insights-scale-plan.md).
This is a staged rollout, separate from the mobile Console work in PR #1233.

**Design revision:** the user clarified that this is pre-release and backward API
compatibility is unnecessary. The additive implementation below records commit
`658329812`; its optional query surface, separate v1 route and retained offset API
are being replaced. Passing tests for that commit do not approve the revised
contract or the full provider/operation goal.

## Plugin-developer adversarial review

A separate reviewer explicitly adopted the persona of an external database plugin
author. They rejected the additive design under the clarified requirements and
agreed to direct replacement only under these conditions:

- One required query contract, with event pages, historical installation search
  and finite typed reports covering all eight operations; no old-plugin shim.
- Provider-owned lookahead/continuation and measured physical queries on each DB.
- Runtime read dependencies do not contain raw `scan`; maintenance owns backfill.
- Existing HTTP/RPC/Console consumers change together, with no `.eventPages`,
  `/insights/v1/events`, offset adapter or legacy response serializer left behind.
- Preserve raw events, cursor format validation, schema/layout versions and report
  generations; those are data-safety requirements, not API compatibility support.
- All providers, report result bounds, readiness/reuse, and migrations need code
  and execution evidence before final approval. An unsupported official provider
  is not an acceptable finished implementation.

The follow-up review agreed on append plus four required read ports:
`pageEvents`, `pageInstallations`, `getReport`, `pageReport`. Report sections are
bounded, single summaries reuse batch, and report cache keys exclude wall-clock
request time/page state. The plan records their responsibilities and remaining
storage correctness gates.

This is agreement on the contract and responsibilities, **not approval of a
rewritten implementation**. Commit boundaries, lease/replay/publication atomicity,
historical snapshot construction, section ordering and each provider's physical
read budget still need implementation evidence.

## Implemented subset

### Current validation

The current PostgreSQL installation additions passed the full workspace build
(26 projects), type checks (34 projects), root lint, changeset validation and all
2,678 unit tests in 299 files. A standard PostgreSQL integration run passed all
41 source, job, report, alias, search, exact-installation and movement-page tests
across nine files. The prior preparation
slice at `35e0e81d6` also passed 28 MongoDB preparation/native-reader integration
tests; those are historical results, not another MongoDB run for this update.

The [MongoDB committed-source plan](./insights-mongodb-source-plan.md) now records
the required atomic writer, one-ID ledger/markers, bounded preparation and causal
source consumption. It is unimplemented architecture rather than validation.
It also keeps near-16 MiB command acceptance, the current event-ID domain mismatch,
legacy EJSON checkpoints and real lag/stepdown proof as explicit release gates.

Built PostgreSQL DB tooling additionally loads and repeats the two concurrent
installation index statements and serves a native movement page under both ESM
and CommonJS. It also loads the shipped search/reference/order schema, retries
report migration and runs an idle worker. Executing
the documented derived-state reset preserves an actual raw event and its source
generation in both formats. Independent review approved only the internal
PostgreSQL report, identity, contains and installation-detail implementation. The
final all-provider implementation and standalone E2E remain pending. The
[current validation record](./insights-scale-evidence/installations-validation.json)
includes current source/test hashes, 52 actual native plans, fixture sizes and
explicit limits. The [contains record](./insights-scale-evidence/contains-validation.json), [identity record](./insights-scale-evidence/identity-validation.json),
[report-page record](./insights-scale-evidence/report-pages-validation.json) and
[preparation record](./insights-scale-evidence/report-preparation-validation.json)
retain their preceding verification without relabeling it as current.

### Immutable historical contains searches

A private contains job pins one global overview and waits for that actual base
publication. It copies the base's cutoff and source generation once; it cannot
silently rebind or label an old result with a newer request time. Search and base
reservations commit together. Concurrent and repeated polls reuse their work;
higher freshness leaves a running generation intact and can reserve a successor
after it finishes. Failed bases fail their dependent searches visibly.

Bounded alias pages apply literal substring matching to whole JS-lowercased
strings. Matching former users and legacy usernames returns the pinned base's
latest installation metadata. One immutable set entry per installation prevents
duplicate aliases and replay from inflating totals. The existing 32-row merge
stages sort complete installation IDs with JS comparison before publication.
Pages read at most 100 results through ordinal ranges and latest hash points in
one read-only snapshot. Cursors bind the normalized query and publication, allow
page-size changes, and never refresh or reserve work when explicitly pinned.

At the minimum 256-item worker budget, an alias step reads at most 74 aliases,
74 frozen latest records and 74 set-validation rows, plus two readiness rows and
reserved control work. There is no hidden refill for an alias page with no
matches. A 50,001-alias fixture whose only match is last proves full traversal
without raw reads or OFFSET. That fixture prebuilds consistent base projections;
it is not a benchmark of preparing 50,001 raw events. Separate worker tests cover
the raw-to-base transaction and source cutoff.

Twelve search-job tests, six search scenarios and four set-storage tests cover
actual freshness, historical matching, literal wildcards, Unicode normalization,
lowercase expansion, long queries, cursor boundaries and failed output rollback.
Native PostgreSQL tests additionally cover concurrent reservation, a new base
pin while its publisher holds a lease, read-only write rejection, refresh/cleanup
isolation, missing indexes and custom/generic plans over 50,001 matching rows.
One combined-run failure exposed a fixture's one-second priority assumption;
the fixture now gives only its requested job deterministic priority. Production
claim ordering and the actual concurrent pin/publication proof are unchanged.

The external plugin-developer review approved this scope after checking query
identity, source binding, exact set semantics, bounded reads and snapshot safety.
The base foreign key prevents deleting a referenced job. Cleanup must delete
derived rows and the job in the same transaction for that protection to cover
the complete base; arbitrary direct derived-row deletion is unsupported.
The job lock uses `FOR NO KEY UPDATE` to permit foreign-key pins while preserving
lease fencing, avoiding a head/job lock-order deadlock.

Private storage revision 2 directly replaces the unreleased draft layout, with
an explicit derived-only reset and no old-format decoder. This is still internal
PostgreSQL code: public provider/HTTP/RPC/Console wiring, live all/exact browsing,
other providers and bounded retention remain release gates.

### Native PostgreSQL installation detail

Exact installation lookup now uses the existing three-key installation index to
read one latest event across all four types. It samples the database clock during
readiness and excludes future-dated events with a strict upper bound. Results
retain empty, long, case-sensitive and normalization-distinct IDs. NUL and lone
surrogate requests safely return no row instead of being changed by the driver.

A first actual PostgreSQL plan exposed a correctness-of-budget problem rather
than a semantic mismatch. After statistics described one busy installation,
50,003 newer unrelated events arrived without a new `ANALYZE`. Scalar equality
let PostgreSQL discard the installation key from ordering, choose the global time
index and filter all 50,003 rows. A singleton array predicate plus complete
three-key ordering keeps the native installation path. Final PostgreSQL 15 and
17 custom/generic plans read zero or one row with no filter, sort, bitmap or
sequential scan. The original global index remains present and scan-method
settings are not forced.

Installation movement pages merge only `UPDATE_APPLIED` and `RECOVERED`. Two
type-specific partial indexes keep the old three-key width; a four-key replacement
could newly reject a long identity that already fits. The native executor fixes
event types as SQL literals and binds all caller values. The same statistics-lag
case initially made one movement stream filter 50,003 global rows; retaining the
complete installation-key order fixed its custom and generic plans too.

The explicit online migration creates these two indexes outside a transaction.
Its first blocking advisory-lock design deadlocked: its lock query held an old
snapshot that concurrent index creation needed to drain. Preparation now uses a
fail-fast session lock. Native concurrency verifies one winner, one visible busy
result and a successful explicit retry. Missing, wrong-predicate or mismatched
collation indexes stop before raw reads.

Shared, server and route cursor validators now accept the stored installation ID
domain, including empty and long values, and use one bound that accounts for the
scope's outer JSON escaping. Bundle and event-ID validation remain separately
bounded; this slice does not claim to resolve their broader legacy-domain gates.
The [deployment and semantic details](./insights-postgres-installations.md) record
the explicit preparation and current limits.

These helpers are still behind the prototype event-page path or internal-only.
The required public installation port, live all-installation enumeration and the
coordinated provider/HTTP/RPC/Console cutover remain unfinished.

### Immutable historical aliases and latest installation lookup

The global installation overview now saves distinct installation/user/legacy
username aliases alongside latest metadata under the same source prefix, event
cutoff and leased checkpoint. Matching a former user can therefore resolve the
latest installation state without reading raw history or mixing publications.
Repeated activities do not add duplicate aliases or update existing alias rows.
This supplies the internal contains worker above; public search wiring is pending.

Alias preparation uses at most two SQL statements and three returned identity
rows per event. Alias pages read at most 200 entries; frozen latest lookup reads
at most 200 distinct hash points. Each read also checks index readiness. Full
identity/hash validation rejects corruption and missing latest rows. An empty
match batch performs no SQL. JavaScript lowercase behavior, whitespace, empty
strings, Unicode forms and long values remain intact.

The external plugin-developer reviewer found that sparse input arrays could
bypass `.some()` validation and reach storage. Validation now uses `Array.from`,
and a regression checks rejection before I/O. They approved this implementation
slice after reviewing alias/source atomicity and its worst-case budget.

Ten alias tests, four latest-point tests and two added worker scenarios passed.
The worker scenarios preserve former identities, exclude cutoff and late
backdated events, keep previous generations unchanged, and roll back both latest
metadata and source progress on an injected alias failure. Real PostgreSQL tests
use 50,001 aliases and 50,001 latest installations, plus other buckets and
publications. Both ordinary and prepared generic plans push publication, bucket
and all 200 requested hashes into the native index, returning exactly 200 rows
without a full scan, sort or post-filter. The separate alias seek tests include
deep pages and full JSON identities longer than 6 KB.

The contains implementation above now supplies base references, match accumulation,
exact ordering/totals and cursors. Its freshness comes from the base publication,
and the single current storage revision rejects old alias-free overviews. Live
all/exact installation browsing is still unfinished.

### Immutable PostgreSQL section pages

All five section families now read immutable derived data: movement series,
movement cohorts, bundle distribution, active series and flat active-bundle
series. Cursors bind publication, section, metric and exact bundle filter while
allowing page-size changes. Series generate only the requested zero-filled
buckets; active bundle ranking uses total observations, not current distribution.

Ordering copies at most 32 counters, then merges persisted runs in bounded steps.
Long labels remain intact and use JavaScript string comparison. Publication waits
for every required ordered section. Missing ordinal rows are invalid output;
missing publications expire rather than silently switching to the newest result.

Adversarial review reproduced a metadata join scanning 50,001 rows after a primary
key was lost, and a competing bucket index reading 137 cohort rows to sort 32.
Metadata keys now have readiness guards; bucket and sort-input indexes cover only
their actual section families, with exact predicate checks. Actual PostgreSQL
plans verify bounded input/range seeks, including prepared generic plans and
50,001 matching counters. The generic-plan test does not force scan methods.

Six page tests cover semantics, cursor changes, long Unicode labels, numeric
boundaries, immutable refresh and missing output. Twelve ordering tests cover
multiple passes, replay, corrupt rows/state and incompatible index predicates.
Five real PostgreSQL page tests additionally verify read-only/RR settings, write
rejection, concurrent refresh/cleanup, earliest-metric seeks and missing metadata
keys. Retention of intermediate passes and public/runtime integration remain
unfinished; this is not approval of the complete scale plan.

### Durable PostgreSQL report accumulation

The [report implementation](./insights-postgres-reports.md) now reserves and
reuses actual jobs, captures one committed source prefix, resumes bounded
projection batches and atomically publishes small exact summaries. A previous
publication remains immutable while its successor prepares. A database-clock
lease/epoch fences both writes and publication; poison data fails visibly rather
than creating an endless series of retry jobs.

Worker regressions cover independent distinct dimensions, long old cohort labels,
latest-user filtering after window reduction, all 30 rolling buckets, timestamp
ties, late old-timestamp commits, previous-result reuse and atomic batch rollback.
A 50,001-event fixture finishes with exactly 50,001 processed source rows, at most
200 per step. Instrumentation checks SQL request and returned-row budgets.

Independent review reproduced three issues before acceptance: full Unicode label
keys exceeded PostgreSQL's B-tree limit, a volatile claim cutoff examined 50,001
future leases, and colliding summary request identities could overwrite one
another before validation. The label index was removed without restricting old
raw data, claim selection now has an indexable fixed boundary and one locked
candidate, and every hashed identity is checked in full. Real PostgreSQL tests
verify concurrent reservation/claims and publication rollback after a head-lock
wait exceeds the lease.

This is accumulator/job-store evidence only; the later sections above record
ordered pages and historical search. Terminal-failure recovery, retention/expiry,
public provider wiring and other-provider report engines remain release gates. Existing runtime
methods still have the old cap until the required contract and consumers change.

### Window-bound event pages and report request identity

Event requests now accept an inclusive `sinceReceivedAtMs` boundary (zero when
omitted) alongside the exclusive `beforeReceivedAtMs` cutoff. Both bounds are
encoded in the cursor. Reusing a cursor with a different start time fails before
storage reads. Generic SQL, Firebase, and each Supabase RPC stream push the lower
bound into their native predicate; the server rejects out-of-window provider rows
rather than silently dropping them. This supports the selected period in bundle
detail without reading its older history. Consumers still await direct migration.
The unreleased Supabase RPC signature and cursor shape changed directly; no old
signature or cursor decoder is retained for compatibility.

Finite installation/report/publication types are defined in plugin-core. The
report query reader canonicalizes bounded bundle batches and constructs a stable
semantic key, excluding freshness requests. It preserves exact user identity and
separates query kinds and windows. Unknown fields and oversized batches fail;
they cannot silently resolve to another report. Providers must combine the key
with their storage revision, reserve an actual durable job, and implement its
publication lifecycle. Types and key validation alone do not implement reports.

Focused validation: 37 event-boundary tests passed across six Mock, PostgreSQL,
Supabase, migration, and server suites. The PostgreSQL test executes real captured
queries over 50,104 rows and checks that exhausting the window neither sorts nor
sequentially scans nor post-filters older rows. Three report-key tests cover
freshness reuse, identity collisions, unsupported filters and oversized batches.
Firebase native-page integration and real PostgreSQL/PostgREST RPC integration
passed together (12 tests), including the inclusive lower bound among 50,104
Firestore events. Four affected package type checks and targeted lint passed.
The independent plugin-author reviewer found no blocker in the lower-bound
queries after rerunning the relevant Mock/PGlite/server scenarios. This remains
a scoped review, not approval of the unfinished required-port implementation.

### Native event readers and ordered SQL

MongoDB now has [explicit preparation tooling](./insights-mongodb-preparation.md)
for its internal reader: persisted audit state, strict writer/database guards,
preserved existing validators and bounded `_id_` traversal across BSON types.
A 50,001-row audit and a large-public-string response-cap regression verify that
neither a type boundary nor a short batch silently finishes the audit. Native
source capture and public provider wiring are still separate unfinished work.

These are implementation building blocks, not the completed required runtime
contract. Supabase and Firebase page executors remain internal until that direct
replacement. Firebase's existing `scan` now uses an ordered native query with a
maximum batch of 1,000 instead of loading the event collection.

| Operation                                |        Event queries | Maximum returned candidates |
| ---------------------------------------- | -------------------: | --------------------------: |
| Firebase global page                     |                    1 |                       N + 1 |
| Firebase installation or bundle movement |                    2 |                 2 × (N + 1) |
| Firebase backfill initialization         |                    2 |                           2 |
| Firebase backfill step                   |                    1 |                         200 |
| Supabase global page                     |  1 active SQL stream |                       N + 1 |
| Supabase installation or bundle movement | 2 active SQL streams |                 2 × (N + 1) |

Firebase also checks its persisted index-preparation state; backfill transactions
read one checkpoint document. Supabase also checks index metadata. Those metadata
reads are separate from the event counts. These are query/result bounds, not
unconditional disk-I/O or Firestore billing guarantees.

Firebase hashes exact UTF-8 scope values for indexing and checks the original
value on every match. This preserves long identities without normalizing case,
whitespace, or Unicode; hash mismatches fail instead of silently filtering a
page. Canonical lowercase UUIDs keep timestamp/ID ordering identical across
Firestore and JavaScript. Lone-surrogate identities are rejected rather than
silently replaced during UTF-8 encoding. Direct append rejects them before reads;
mixed commits preserve atomic rollback but still read the existing catalog.

The internal backfill helper requires old writers to be drained first. It saves a
fixed upper ID, applies only derived key fields, and commits each bounded batch
together with its checkpoint. Source update-time preconditions and a transactional
checkpoint prevent partial advancement. It does not remove or rewrite raw fields.
Initialization uses the descending `id` field index, then an ascending document-key
probe in the same transaction to detect missing or mismatched IDs beyond that
bound. A pure descending document-key query failed in the real emulator and was
removed. Invalid source records stop preparation, including records inside the
captured range. Deployment readiness and public maintenance tooling remain part
of the unfinished provider rollout.

The Supabase RPC returns one JSON value containing the bounded page, avoiding
PostgREST's table-row cap. Anonymous/authenticated roles cannot execute it. Missing
RPC/index preparation maps to not-ready; permission errors and unrelated SQL
failures retain their original operational classification. There is no scan
fallback. The migration generator includes the RPC and its installation/type
index without changing the original event data.

Kysely and Drizzle now omit computed null-sort expressions only for the two
non-null event ordering columns. Actual SQLite execution and query-plan tests
cover 50,001 unrelated events, equal-time cursors, and preserved nullable-field
sorting. Other columns and models retain their existing ordering behavior.

Validation performed after pulling `73e73b0cf` (which already contains `next`):

- Full build: 26 projects; type checks: 34 projects; root lint passed.
- Root unit suite: 2,525 tests, including the RPC-readiness regression.
- Firebase event reads/writes: 64 tests passed on the emulator, including 50,104
  events, asymmetric movement directions, a fixed cutoff, and long Unicode scopes.
- Firebase backfill: 11 tests passed after fixing the descending-key query,
  including missing IDs before/after the boundary, durable resume, raw extension
  preservation, invalid-row rollback, and an injected stale write precondition
  rejected by a real Firestore commit. The latter is not a timing-based race test.
- Standard repository integration setup also passed the backfill and scalar-RPC
  suites together: 13 tests, with its emulator cleaned up after completion.
- Supabase scalar RPC: 2 real PostgreSQL 15/PostgREST 14.6 tests passed in each of
  three fresh-container runs with `PGRST_DB_MAX_ROWS=1`. TCP readiness avoids the
  image's temporary initialization-server race. CI prepares both required images.
- Independent Supabase generic-plan review: six executions of the actual SQL
  body on 50,104 rows. With `limit=1`, active index scans examined at most 2 rows
  globally and 4 for movement; inactive branches executed zero times. The
  [recorded plans](./insights-scale-evidence/supabase-generic-plan.jsonl) include
  the SQL source hash, engine version, fixture size, and executed statements.
  This artifact records the SQL before the inclusive lower-bound addition; it
  is historical evidence for its recorded hash, not a plan capture of later SQL.

The independent reviewer approved these implementation slices after checking
cursor boundaries, exact scope semantics, error classification and backfill
atomicity. Full-provider/report implementation approval is still outstanding.
The review also reproduced a pre-existing PostgreSQL/Supabase raw-text index
limit: some 1,024-character multibyte identities exceed a B-tree entry's byte
limit. This is an existing storage prerequisite, not a page-executor regression;
do not claim uniform long-identity support across all providers yet.

### PostgreSQL committed-source storage

The direct PostgreSQL plugin now writes an event and advances its source counter
in one SQL statement. Mixed commits acquire the affected shard locks in sorted
order before applying catalog/event changes. Duplicate inserts and later errors
roll back both data and counter allocations. A source capture records a persisted
layout identity and the committed per-shard prefixes; it cannot include an earlier
allocation still waiting to commit. Late event timestamps do not change this rule.

Explicit `@hot-updater/postgres/db` tooling installs the source schema and fences
old writers, then backfills fixed primary-key pages of at most 200 raw rows.
New writers can append during backfill. Existing raw fields are preserved, and
source assignments, counters and the checkpoint commit atomically. Source reads
require contiguous sequences and the correct layout identity. Private source
columns are excluded from public event results.

The plugin-author review found that removing the source index made a two-row
query scan 50,001 rows and sort. Capture, reads, backfill and migration retries now
check the index definition and readiness before proceeding, with no scan fallback.
Concurrent manual DDL remains outside this guarantee.

- Focused PostgreSQL suites: 54 tests passed, including rollback, bigint values,
  missing source rows, fixed-range backfill, preserved extension fields and index
  removal/replacement on an existing instance.
- Actual queries over 50,001 rows: primary-key and source index plans had no sort
  or sequential scan, with at most two examined rows in the tested leaf nodes.
- Actual PostgreSQL 15, two fresh-container runs: the mixed adapter commit pauses
  after allocation, another shard commits, and a same-shard writer waits. Capture
  excludes the pending events; the next prefix contains their contiguous records.
- PostgreSQL type checks passed. These tests do not measure production throughput
  or implement the report engine, leases, publications or shared runner.

[Deployment instructions](./insights-postgres-source.md) require a maintenance
window for the initial DDL/index scan. This is data-preserving migration with
bounded backfill, not a claim of zero-downtime schema installation.

### MongoDB native event reader

The internal MongoDB reader uses explicit simple collation, named index hints,
and disjoint equal-time/older ranges. It returns at most N + 1 candidates globally
or 2 × (N + 1) across movement streams, with no whole-history `toArray`, offsets,
or automatic refill. Each page checks index keys, uniqueness, completeness and
collation. Its public projection excludes internal fields while preserving the
underlying raw document.

Nineteen unit tests and eight real MongoDB integration tests passed. The latter
use 50,104 rows and a locale-aware collection default; the native reader still
uses exact simple-collation scopes. Global, movement and deep-cursor plans use
IXSCAN without SORT/COLLSCAN, examining at most the requested candidate limit in
documents and one additional terminating index key per query. Long-Unicode
scope tests verify exact returned rows and request/getMore budgets separately
from the short-scope physical plan assertions described below.

This reader is not wired into the public provider yet. A mandatory preparation
callback must certify canonical UUID IDs, safe integer timestamps, old-data audit
and writer guards. The existing Mongo schema/version shortcut does not provide
that certification; bounded preparation and direct API integration are still
required. Index presence alone cannot make arbitrary BSON string ordering match
JavaScript ordering.

An isolated MongoDB 7.0.31 diagnostic found that a long Unicode identity round
tripped correctly through native `find`, but `explain` returned malformed UTF-8 in
truncated index-bound display strings. The [diagnostic artifact](./insights-scale-evidence/mongodb-long-scope-explain.json)
records this distinction. Relaxed decoding was used only in the temporary
diagnostic to identify those fields. Production BSON validation is unchanged;
this artifact is not a performance benchmark of the production reader.

### Verification of the combined source/readers changes

The combined worktree passed the full build (26 projects), type checks (34
projects), root lint, and 2,559 unit tests in 287 files. Firebase/Supabase window
integration passed 12 tests; MongoDB standard integration passed eight; actual
PostgreSQL concurrency passed in two fresh-container runs. Both ESM and CommonJS
imports of the built PostgreSQL `/db` entry resolved the shipped migration SQL.
Changeset validation passed. These checks are not the standalone OTA E2E series,
which remains pending the completed implementation and runner prerequisites.

### Firebase write isolation

An independent adversarial reviewer approved the implementation plan, then the
external plugin-developer persona reviewed the actual three-file diff and the
emulator/type-check results, then approved this slice. This
slice changes storage access without adding a compatibility API:

- Direct event append uses immutable document creation after the existing input
  validation and schema check. It does not load event history or catalog rows.
- Catalog reads and mutations no longer load event history. Mixed commits stage
  only new events and use `transaction.create` in the same transaction as catalog
  writes; an existing event ID aborts the entire commit.
- An explicit internal event query still reads history separately and sees staged
  inserts. Queried history never enters the write maps or gets rewritten.

Firebase emulator integration: **54 tests passed**, including four new scenarios
covering unrelated malformed records/read-call isolation, duplicate event rollback
of a bundle update, same-batch duplicates, and concurrent append versus a mixed
commit for the same ID. Existing event extensions remain unchanged. Before the
fix, the first two scenarios failed while parsing unrelated collections.
Package type checks, root lint, and all 2,489 root unit tests also passed.

At that commit, explicit `findMany`/`scan` still read the event collection. The
native reader work above replaces `scan`; private generic event `findMany` and
the six-collection catalog snapshot remain. Required read ports, source counters,
report computation and the complete migration/tooling rollout are unfinished.

### Historical PostgreSQL/additive API slice

- Optional version 1 native event-page capability in plugin-core and the typed
  server API. Existing append/scan plugins and bounded aggregate methods retain
  their behavior. No raw events are removed or sampled.
- Additive admin `GET /insights/v1/events` with a strict query parser and versioned
  errors. It is not registered on the client handler. Mount it behind the same
  host-owned authentication as other admin routes; `handlers.admin` does not
  perform authentication by itself.
- PostgreSQL opts in for global events and bundle movement events. Installation
  movement is deliberately not enabled until its type/time index is migrated.
- The provider receives the final page size (1–100), performs lookahead and
  bounded merging, and resumes from the final emitted event tuple. Server pages
  have no mandatory total count, offset traversal, or automatic refill loop.
- Each PostgreSQL page checks the relevant existing indexes before querying
  events. Missing, invalid, partial, expression, mixed-direction, or nondefault
  operator-class indexes do not enable the native path. Readiness is checked
  again on warm instances; failed readiness does not fall back to scanning.

For example, `hotUpdater.insights.eventPages?.getPage({ scope: { kind: "all" },
limit: 50, beforeReceivedAtMs: Date.now() })` returns a live page. Send the same
scope/cutoff and the returned cursor for the next page. A fixed cutoff prevents
newer reports pushing the boundary, but late commits do not form a snapshot.
Refresh to begin a new view. A non-null cursor can accompany a short or empty
page on future capped providers; consumers must offer an explicit next action.

## Read budgets and limits

| Native scope    | Data queries per page        | Candidate rows returned to the adapter |
| --------------- | ---------------------------- | -------------------------------------- |
| Global          | At most 2                    | At most N + 1 total                    |
| Bundle movement | At most 4 across two streams | At most 2 × (N + 1) total              |

PostgreSQL also performs one catalog query per logical page, plus the existing
schema readiness wrapper. The limits above describe data query/candidate budgets,
not an absolute bound on physical disk I/O. The fixture's actual PostgreSQL plans
use the intended B-tree indexes without sorting or scanning unrelated events.
Optimizer settings/statistics can change plans. Concurrent manual index DDL is
outside this measured guarantee; migrations must mark affected scopes preparing
before index replacement to close the check/query race.

## Adversarial review

An independent read-only reviewer challenged the implementation before approval:

1. Moved lookahead ownership into the provider; rejected server-side truncation.
2. Split equal-time and older queries while sharing one candidate budget.
3. Preserved explicit continuation for capped providers instead of inferring
   exhaustion from a short page or recursively filling it.
4. Rejected blanket opt-in through generic `findMany`. Supabase response caps,
   SQL computed null ordering, MSSQL UUID ordering, and MongoDB expression plans
   require provider-specific verification before activation.
5. Found mixed-direction indexes passing a column-name-only readiness check.
   The catalog check now verifies ordering and operator classes as well.
6. Found indefinite readiness caching could allow a warm provider to scan after
   an index drop. The check now runs once per logical page.
7. Added public server input, query-version, row identity/type/order/scope, size,
   and continuation validation independently of adapter implementation.

The reviewer approved only this PostgreSQL global/bundle typed API slice after
re-running its tests, then separately reviewed and approved the additive admin
HTTP path. Other providers, Console integration, and the full eight-operation
matrix are not covered by those approvals.

## HTTP usage

For a host that mounts protected admin routes at `/hot-updater/admin`, request
`GET /hot-updater/admin/insights/v1/events?limit=50`. The first response supplies
`pagination.beforeReceivedAtMs`; send it with the returned `cursor` to continue.
The optional `scope=bundle&bundleId=<canonical-lowercase-uuid>` selects bundle
movement. Unknown/duplicate fields, `offset`, conflicting scope IDs, malformed
bookmarks and missing continuation cutoffs fail before data queries.

Errors use `{ "error": { "code": "..." } }`: invalid page input is 400,
unsupported native scope/provider is 501, missing indexes or schema is 503, and
unexpected storage/adapter failures are a sanitized 500. No error triggers a
legacy scan fallback. Existing HTTP routes retain their response shapes.

## Reproducible verification

Run with the repository's configured Node version:

```sh
pnpm exec vitest run --project='unit:default' plugins/mock/src/test/insightsEventQueries.spec.ts plugins/postgres/src/postgresInsights.spec.ts packages/server/src/insights/eventPages.spec.ts
pnpm --filter @hot-updater/plugin-core --filter @hot-updater/server --filter @hot-updater/postgres test:type
```

- Mock fixtures: 50,001 old events, 103 equal-time events, one-row interleaved
  stream pagination, cutoff changes, malformed bookmarks and executor results.
  These measure query count and transferred rows, not physical storage cost.
- PGlite runs the shipped PostgreSQL schema with 50,001 unrelated events and 103
  equal-time movements. Captured real queries are checked with `EXPLAIN ANALYZE`:
  expected indexes, no sort/sequential scan, and bounded examined result rows.
  Tests go through `createHotUpdater`, forbid the legacy scanner/count, and
  exercise index removal, mixed ordering, and recovery on the same warm instance.
- Server boundary tests cover short/empty continuation without automatic refill,
  invalid inputs/version, malformed results, and nonadvancing continuation.
- HTTP tests cover a Hono bearer-auth admin mount (missing credentials and valid
  client API keys cannot read admin events), client-route isolation, input
  validation before reads, unsupported providers/scopes without fallback, fixed
  cutoff continuation and sanitized structured errors. PostgreSQL additionally
  rejects noncanonical UUID scope/bookmark input before even the catalog query.

## Remaining release gates

The 50,000-row ceiling still applies to legacy methods and aggregates. This slice
does not remove that ceiling across Insights. Next stages must implement the
Console path, installation browsing/index migrations, remaining
official providers, exact reports/search and durable maintenance, existing-data
backfill, and the full provider/operation correctness and cost matrix. The
standalone E2E series checks OTA integration; it does not replace large-scale
Insights benchmarks. Its exact PR commit and task results will be recorded here.

The first full `standalone-dynamodb` attempt on `658329812`, job
`job-20260831160856-sjc1g3`, failed the runner's disk preflight (7.3 GiB available,
20 GiB required). This is not a successful scenario run. Remaining profiles were
not submitted; re-run the series after the contract replacement and disk preflight
are ready. No disk-space safety threshold is bypassed.
