# Insights beyond 50,000 events

Status: pre-release contract replacement in progress, 2026-09-01.
Source baseline: `4fd801be`. The user explicitly requires no backward API
compatibility. The initial additive draft is being replaced, not grandfathered.
This document defines the full target; it is not a claim that every stage ships.
See [implementation evidence](./insights-scale-review.md) for the verified subset.
It is independent of the Console mobile work in PR #1233, which targets `next`.

## Outcome and boundaries

Remove the event-count ceiling from every Insights read operation on every
official database provider. A database with 100,000 active installations and
millions of events must support ordinary browsing without loading its entire
history into application memory. Expensive exact reports must have a durable
completion path, rather than failing permanently at 50,001 records.

Assumptions and recommended decisions:

| Question | Decision for this plan | Consequence |
| --- | --- | --- |
| Is 50,000 a storage limit? | No. Keep raw event ingestion independent of report limits. | Do not drop older events, add a TTL, sample `Activity reported`, or raise the constant as the fix. Provider storage quotas still apply. |
| What does MAU mean here? | Unique **installation IDs** reporting within the rolling 30-day window. | This is not account-level MAU. Multiple installations for one user remain distinct. Do not sum daily counts. |
| Must every request synchronously recompute an exact report? | No. Return a completed exact report with its actual reporting time, or an explicit preparing state. | Freshness and response latency are separate guarantees in the normal API. |
| Can pagination require an exact total? | No for the new page contract. | Return `hasNext` and a cursor immediately; request an exact total separately if needed. |
| Can search quietly become prefix-only? | No. Preserve historical, case-insensitive contains search as an explicit potentially asynchronous operation. | Offer exact ID lookup first; prefix search is a separately named mode, not a substitute for contains. |
| Can active chart buckets silently switch to UTC calendar boundaries? | No. Preserve the current rolling bucket calculation at the report's declared `asOfMs`. | Fixed daily/hourly scalar rollups are not sufficient. Any later calendar-bucket change needs its own contract and release note. |
| Is this a new analytics service? | No mandatory external service. | Keep physical queries, projections, job state, and migrations in the selected database. Ship a bounded maintenance runner. |

Completion means the whole provider/operation matrix below is supported, including
Firebase and DynamoDB. A partial provider rollout is useful, but is not completion
of this plan. Third-party plugins implement the same required contract; there is
no append/scan-only compatibility fallback or permanently capped provider path.

## Current behavior and verified bottlenecks

The [existing architecture](./insights.md) assigns storage and migration to the
database plugin, and event semantics, validation, and HTTP responses to the server.
Keep that ownership. The current
[`InsightsModel`](../../plugins/plugin-core/src/types/databasePlugin.ts) has only
`append` and ascending `scan` operations.

[`bounded/scan.ts`](../../packages/server/src/insights/bounded/scan.ts) reads pages
of 1,000 and materializes up to 50,001 events before throwing
`InsightsScanLimitExceededError`. The bound applies to the scan scope before many
bundle/identity filters. A lookup for one installation can therefore fail because
unrelated history exceeds the cap. Failed aggregation does not mean ingestion
stopped, and the current code does not return a partial total as a complete one.

Commit `3ac7cf876` pushed the common scan cursor into two database predicates:
remaining IDs at the cursor timestamp, then later timestamps. The
[Mock regression](../../plugins/mock/src/test/insightsScan.spec.ts) demonstrates
three returned rows instead of 100,010 for its two-page scenario. It measures
rows crossing the model boundary, **not** storage reads for every provider.

Two additional physical bottlenecks need their own work:

- [Firebase](../../plugins/firebase/src/firebaseDatabase.ts) uses whole-database
  snapshots for generic reads and mutations. The
  [persistence layer](../../plugins/firebase/src/firebaseDatabasePersistence.ts)
  includes `bundleEvents.get()` and `transaction.get(bundleEvents)`. Event append
  and unrelated mutations can read all events even after cursor pushdown.
- [DynamoDB](../../plugins/aws/src/dynamoDB.ts) writes events under one
  `bundle_events` partition, ordered by timestamp and ID. It lacks the scoped
  access patterns and distributed writes needed for this plan. The dedicated
  append path must migrate; Insights is removed from generic CRUD and commit.

## Complete operation matrix

All eight methods currently live in
[`bounded/provider.ts`](../../packages/server/src/insights/bounded/provider.ts).
The replacement must avoid broad raw-event materialization in all of them.

| Operation | Current scope and semantics | Planned read path |
| --- | --- | --- |
| `getBundleEventSummary` | All-time distinct installations applying to or recovering from one bundle | Indexed bundle/type aggregation, or completed exact membership report. |
| `getBundleEventSummaries` | Same counts for a batch of bundles and a window | One logical batch, chunked only for provider parameter limits; aggregate by requested bundle IDs. Do not turn this into N full scans. |
| `getBundleEventInsights` | Summary, time series, cohorts, recent movement events | Independent report sections and native recent-event page. Recent events remain usable while an aggregate is preparing. Page large cohort/series outputs. |
| `getBundleEventOverview` | All-time latest row per installation, tracked count, current bundle distribution | Latest-installation projection plus exact grouped report. No historical event scan on each page load. |
| `getActiveInstallationOverview` | Rolling 24h/7d/30d distinct installations, latest identity filter, bucket activity and bundle distribution | Native exact query within a measured budget; otherwise persisted exact report computation with latest-per-install and latest-per-bucket membership. |
| `searchInstallations` | Case-insensitive contains on any historical install/user/legacy username; returns latest metadata in install-ID order | Identity lookup index plus latest-installation projection. Contains may build a resumable result over historical aliases; never scan raw history synchronously. |
| `getInstallationHistory` | All-time `UPDATE_APPLIED` and `RECOVERED` for one install | Installation/type/time index, keyset page, independent latest metadata. Activity-only installations must still have a detail view. |
| `getEventHistory` | All-time events of all four types | Descending time/ID keyset page over native storage or a finite merge of indexed partitions. No search prerequisite and no aggregate dependency. |

The current [admin HTTP routes](../../packages/server/src/insights/routes.ts)
expose six of these methods. `getEventHistory` currently exists through the
provider/Console RPC only; `getBundleEventSummaries` is also not a standalone HTTP
route. Do not describe them as existing HTTP endpoints. Add the global admin
`GET /events` route explicitly when replacing the page contract; keep
batch summaries available through the typed server API and Console RPC. Ingestion
remains client `POST /events`.

## Semantics that must survive the change

Use small fixtures against the current implementation as a reference oracle.
Freeze the reference clock so query timing cannot disguise a semantic difference.

### Active installations

The [current collector](../../packages/server/src/insights/bounded/activeOverview.ts)
uses `[asOfMs - duration, asOfMs)`. Its buckets also start at
`asOfMs - duration`; they are not fixed UTC calendar buckets. It considers all four
event types, including internal `UNCHANGED`, displayed as `Activity reported`.
Rows exactly at the lower boundary are included; rows exactly at `asOfMs` and
future rows are excluded before latest-identity selection.

For each installation, the maximum `(received_at_ms, id)` in the window selects
the current bundle and identity. A `userId` filter applies to that latest identity,
then includes all bucket activity for the selected installations, even activity
reported under an earlier identity. Each bucket independently selects its latest
row per installation. Window bundle distribution and bucket bundle observations
are different measures; summing them does not produce the window unique count.

The scalable API may return a published report from an earlier `asOfMs`, explicitly
shown as such. It must preserve the formula at that time. Do not silently round
the old request to midnight, sum DAU into MAU, or label HLL estimates as exact.

### Bundle movement and history

Bundle movement uses UTC calendar hour/day ranges, unlike active installations:
the current hour plus the previous 23 hours, or the current UTC day plus the
previous 6/29 days. It counts distinct installations separately for
`UPDATE_APPLIED` **to** a bundle and `RECOVERED` **from** a bundle.
`RELEASE_ADOPTED` and `UNCHANGED` are activity but are not movement events.
The first calendar bucket boundary is inclusive and `asOfMs` is exclusive;
events exactly at `asOfMs` or in the future never enter totals or buckets.

Window totals, bucket counts, and cohort counts each deduplicate independently.
An installation can appear in multiple cohorts, or both applied and recovered
sets. Summing those sets can overcount the total. All-time series currently runs
from the oldest relevant UTC day through the current UTC day, with empty buckets
filled with zero. Pagination/resolution changes must preserve the requested
interval and label any coarser grouping explicitly.

Installation history remains the two movement types; global history remains all
four. Tie ordering uses the event ID after timestamp. Database collation, null
handling, lowercase normalization, and identifier ordering need contract tests,
not assumptions about SQL/Firestore/DynamoDB defaults.

### Identity lookup

The [current search](../../packages/server/src/insights/bounded/installationSearch.ts)
matches any historical alias, then returns the latest installation state even
when its current user ID no longer matches. Preserve legacy username aliases.
The replacement has explicit exact installation ID, exact user ID, all, and
"Contains" selectors. Exact user ID is a case-sensitive whole-string match over
historical user-ID aliases. It publishes membership and each match's latest
metadata at one captured source generation. Contains is nonempty, uses historical
install/user/username aliases with the current JavaScript lowercase behavior,
and freezes the same data. Exact installation ID remains live. `all` replaces
the old empty-query convention. Exact user and contains accept the same optional
publication pin and `minAsOfMs` freshness selector for polling and restart.
Exact installation ID is a single 0/1 lookup; its input has no cursor and its
output continuation is always null.

For stores without an efficient contains index, scan **alias records** in bounded,
resumable work, persist deduplicated matches, then page by the opaque installation
order defined below. Exact totals and membership are published after matching
completes; an unfinished
scan must not produce an apparently empty or complete result.

Alias storage grows with identity changes, not every repeated activity event.
Persist one record per `(normalized alias, alias kind, install ID)`, with the
original value retained where required. No unbounded n-gram/prefix expansion and
no required external search service. A contains request can still be expensive:
budget and expose its completion status rather than pretending it is a cheap
key lookup. This preserves functionality while explicitly changing cold-query
latency in the replacement contract.

Normalization initially means the current JavaScript lowercase behavior, not
locale-sensitive folding or a new Unicode normalization policy. Treat `%`, `_`,
and other query-language characters literally when translating contains to SQL
or another backend; keep the existing validated input length. If a native query
cannot preserve these rules within platform limits, use the alias-job path.

## One query contract, without backward API compatibility

Replace `database.models.insights` query contracts directly. All providers must
implement the required event pages, installation lookup/pages and finite typed
report operations. Keep `append` for ingestion. If a raw `scan` is needed for
backfill, expose it only through maintenance tooling, outside the runtime read
provider's dependencies; a read cannot silently fall back to it. Define
the finite storage request/result types in plugin-core or an existing lower-level
shared boundary. Do not import server domain types into plugin-core or introduce
a general query language. Physical SQL, Firestore, and DynamoDB decisions stay in
their adapters; server validation, metric definitions, and response mapping stay
in the server.

The contract must define explicit typed operations for event pages,
installation lookup/pages, bundle summary batches, bundle detail reports,
installation overview, and active overview. Storage responses use bounded rows
or report references/status, never an unbounded raw array for the server to group.
Maintenance is a separate internal/tooling capability, not an admin-free query
side effect or a public migrator on the root server instance.

The plugin-developer adversarial review agreed to **append plus four required
read ports**, without public capability negotiation:

| Port | Required behavior |
| --- | --- |
| `pageEvents` | One bounded all/installation/bundle event page. Provider owns lookahead and continuation. |
| `pageInstallations` | Explicit all, live exact installation ID, publication-frozen exact historical user ID, or historical contains. Bind live/snapshot choice and search scope into the cursor. |
| `getReport` | A finite query kind: bundle summary batch, bundle detail, installation overview, or active overview. Return a small typed summary/publication, or an actual durable job state with the previous publication. |
| `pageReport` | One bounded section of one immutable publication: series, cohorts, bundle distribution, or flat active bundle-series rows. Never nested unbounded arrays. |

Single bundle summaries use a batch of one; bundle detail recent events use
`pageEvents(bundle)`. Neither needs another storage port. Batch bundle IDs are
deduplicated/sorted and limited to 100. The server maps already aggregated rows;
it never recollects raw history to compute a report. Raw scans, leases, checkpoints
and backfill live behind DB/tooling `runStep({ maxItems, maxRequests })` only.

### Normative storage identity and byte contract

Public event IDs are canonical lowercase UUIDv7 strings matching
`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`.
A nonconforming stored row is migration poison; accepting arbitrary IDs in one
provider would create data that other official providers cannot represent.

Installation ordering is ascending raw-byte order of
`SHA-256(UTF-8(JSON.stringify(fullInstallId)))`. The digest is an opaque order
key, not the identity. Persist the complete installation ID and compare it on
every keyed read and write. A digest paired with a different complete ID is
storage corruption; never merge, overwrite, or return it as the requested
installation. The portable JavaScript string identity domain, including an empty
installation ID but excluding U+0000 as specified below, remains valid. Providers
use the shared
`getInsightsInstallationOrderKey` helper and verify the digest/full-ID pair; they
must recompute stored digests with
`assertInsightsInstallationIdentityDigest` and must not reimplement JSON
escaping, Unicode handling, or normalization.

For byte accounting, canonical JSON recursively sorts object keys, preserves
array order, and uses UTF-8 bytes. Every stored, query, and response string has
at most 1,024 UTF-16 code units and paired surrogates. U+0000 is rejected across
the common contract because PostgreSQL text cannot preserve it; providers must
not create a wider identity or query domain. An opaque cursor is the exception
to the code-unit ceiling and has its own byte ceiling, but still rejects U+0000
and malformed UTF-16.

| Boundary | Maximum |
| --- | ---: |
| Existing public ingestion request body | 16 KiB |
| Canonical complete raw event, including provider extensions | 20 KiB |
| Canonical query JSON, excluding its separately validated cursor | 32 KiB |
| UTF-8 cursor | 8 KiB |
| Serialized public page, including wrapper and cursor | 1 MiB |
| Serialized maintenance job-step input | 4 MiB |

The page default is 50 rows and maximum is 100. A provider may return a short or
empty page with a non-null cursor when a bounded read needs more work; only null
proves exhaustion. A valid row must fit in the page envelope. If persisted data
would make a response invalid, fail with typed storage corruption or migration
poison instead of skipping, truncating, deleting, or normalizing it. Maintenance
also requires explicit `maxItems` and `maxRequests`; each is an integer from 1
through 4,096. The 4 MiB envelope does not replace either work ceiling. DynamoDB
remains subject to its smaller native 400 KiB item ceiling.

Report reuse keys contain the semantic/storage revision and canonical query,
within the database namespace. Never include `Date.now()`, `minAsOfMs`, page size
or cursor in that key. `minAsOfMs` selects freshness, not a new cache entry.
Atomically reuse one active job per query; `preparing` requires that job to exist.
A publication fixes its ID, `asOfMs`, committed source generation and
completion time. Section pages cannot switch publications midway. Expired
publications fail with an explicit restart state.

Report section order is part of the cursor contract. Compare complete labels by
JavaScript UTF-16 code-unit order (`<`/`>`), never `localeCompare` or database
collation. Movement series and active series use ascending bucket time and emit
every bucket in the requested calendar/rolling interval, including zeros.
Movement cohorts use ascending complete cohort label. Bundle distribution uses
count descending then complete bundle ID ascending. Unfiltered active bundle
series ranks bundles by total bucket observations descending then complete bundle
ID ascending, and emits every bucket for each ranked bundle in ascending time;
a bundle-filtered series uses ascending bucket time only.
Every report-page cursor also binds the durable database namespace and an
explicit ordering revision before publication storage is read. Publication IDs
are namespace-local and cannot provide that isolation by themselves.

This is agreement on the port shape and responsibilities, not approval of the
implementation. Before storage changes, settle the provider-specific commit
boundary for source generations, lease/replay/publication atomicity, historical
search snapshots, fixed section ordering and real read budgets. Timestamp cutoffs
alone must not be promoted to committed snapshots to avoid this work.

Readiness is per operation: `ready`, `preparing`, `stale`, or `failed`.
Ready/stale results carry non-null schema, storage, and committed source
generations; projection generation is null only for a raw event read. Preparing
names a real durable job and its non-null reserved source generation. Failed
pre-layout inspection uses explicit null version fields when a generation is
genuinely unknowable; it never substitutes an invented sentinel string. `stale`
carries immutable previous data plus the real successor job. `failed` carries a
typed failure, including migration poison; it is not an endless retry loop.
Published ready/stale versions name that publication's committed source and
projection generations, not the current live head. Missing required plugin
methods are configuration errors, not an optional legacy mode. A missing
index is not evidence that a background preparation job is running.
Completed reports include `asOfMs`, computation completion time, source generation,
and `accuracy: exact`. A previously completed report may be displayed while its
successor runs, with its age visible. Preparing/failed is never converted to zero.
Readiness distinguishes event browsing, identity lookup and aggregates; one
aggregate backfill cannot disable event pages. Public capability-version
negotiation, `mode: bounded`, and `maxMatchingRows` are not part of the new API.
Live event and live all/exact-installation pages never return `stale`.
Historical exact-user/contains and `getReport` may return stale immutable data
while a successor job runs. `pageReport(publicationId)` returns only ready,
typed expired, or failed; it cannot prepare or switch publications.
For historical lookup, an existing pinned publication is read-only. It returns
ready only when its query binding matches and `asOfMs >= minAsOfMs`; a missing,
wrong-query, wrong-namespace, expired, or too-old pin returns typed expired and
requires restart. A pinned request never reserves a successor job.
A new unpinned historical request may prepare or return a stale publication.
A direct publication pin without a cursor returns only ready, expired, or failed.
A historical cursor continuation returns ready, stale, expired, or failed, never
preparing; it retains the original query, namespace, source generation, and
publication. Expiry between pages returns typed expired from the cursor-only
request instead of reserving work or switching publications.

`RequiredInsightsModel` is the internal compile target while providers prepare
these five methods. Replacing the public `InsightsModel` happens once, in the
same final cutover as the server routes, after every official provider passes the
shared conformance suite. Do not publish an interim V2 name, optional method,
legacy adapter, capability version, or version-negotiation window.
At that atomic step, public `InsightsModel` is the five-method contract and the
transitional `RequiredInsightsModel` type is deleted. Provider implementations
expose required `insights: InsightsModel`; `createDatabasePluginAdapter` validates
that model and publishes it as `models.insights`. Delete the temporary top-level
`appendBundleEvent`, public `scan`/optional `events`, their cursor DTOs, and all
generic `bundle_events` create/findMany capability in the same compile-breaking
change.

Propagate this through
[`createHotUpdaterCore.ts`](../../packages/server/src/createHotUpdaterCore.ts),
[`runtime.server.ts`](../../packages/console/src/lib/server/runtime.server.ts),
[`insights-api.ts`](../../packages/console/src/lib/insights-api.ts), and
[`insights-rpc.ts`](../../packages/console/src/lib/insights-rpc.ts). They currently
construct or accept only the bounded provider. Replace that path and retain
schema-readiness wrappers; testing an adapter directly is not enough.

### New page contract

- Default page size 50, maximum 100. Validate the limit and cursor before querying.
- Return `data`, `nextCursor`, `hasNext`, and the declared consistency/cutoff.
  The provider receives the final page size N, owns lookahead/stream merging,
  and returns at most N rows. For strict indexed executors, fetch at most N + 1
  candidates per stream across both timestamp-tie and older-row queries combined.
  Installation/type and bundle/type queries may merge two streams. Never trim
  provider results in the server or automatically refill a short/empty page:
  only a null continuation proves exhaustion; a non-null cursor means more
  bounded work may remain on providers with response/read caps.
- Cursor binds version, database scope, query/filter, ordering, cutoff, and last
  emitted `(received_at_ms, id)`. Installation cursor position uses the opaque
  SHA-256 order key with complete-ID collision verification, never text collation.
  A live bookmark grants no access: validate it against the request's scope and
  cutoff, bound its size, and authorize each request independently. Never accept
  a table, physical partition, or database selected by the cursor. Signing a
  bookmark is optional; snapshot/job references require ownership checks and
  authentication or server-side storage because they reference persisted state.
- For sharded storage retain each stream's last **emitted** position, not a fetched
  `LastEvaluatedKey` that would skip buffered candidates. Use bounded cursor state
  or a server-side cursor record if the partition list cannot fit safely in a URL.
- Total is independently `exact(value, sourceGeneration)`, `pending(jobId)`, or
  `unavailable`. Pending names a real durable total job. Never infer total from
  a full page, and never combine a stale
  total with live items as though both share a snapshot.
- Do not implement pages using a deep `OFFSET`/`skip` traversal or add an offset
  compatibility resolver. Cursor navigation is the only supported list contract.

Choose **live keyset browsing** for ordinary event pages. A fixed event-time
cutoff prevents newer reports from continuously pushing the page boundary, but
does not create a cross-request database snapshot: a delayed commit may arrive
behind an already traversed cursor. Document that refreshing starts a new view.
Guarantee deterministic order and no repeated immutable event IDs while moving
forward; guarantee no omissions for a fixed dataset. Do not claim no omissions
under arbitrary late commits or require a live continuation to retain one source
generation. The event-time cutoff and last emitted key are the fixed cursor state.

Exact reports and exhaustive snapshot enumeration instead use a captured source
generation. If an API promises snapshot pagination, every page must bind that
generation and the adapter must support it; timestamp-only pagination cannot be
relabeled as snapshot-consistent. Expired snapshots return a typed restart state.

Keep list position in browser history and preserve search, selected installation,
source list, and scroll position on return. URLs carry cursors. Do not build an
old-offset resolver, snapshot rank index or compatibility URL reader. Old offset
inputs are rejected with a clear restart action; no preceding-page walk occurs.
Browser Back/Previous uses stored prior cursors for the same view.

### Direct replacement before release

Change the existing `getEventHistory`, `getInstallationHistory` and other query
inputs/results directly. Update HTTP, Console RPC, hooks, DTOs and consumers in
the same change. Use admin `GET /events`; remove the draft's separate
`eventPages` public surface and `/insights/v1/events` route. Do not keep deprecated
offset/total overloads, dual serializers, opt-in switches or old-provider shims.

Cursor format tags, schema/storage layout versions and report source generations
remain: they validate persisted state and data correctness, not old public API
compatibility. Preserve metric semantics and raw data while replacing contracts.
Reference collectors may live in tests as correctness oracles; production code
must not import a bounded compatibility collector.

Replace message regex parsing with structured errors end to end. Currently the
[server error](../../packages/server/src/insights/errors.ts) says
`Insights event scan exceeded ...`, while the
[Console parser](../../packages/console/src/lib/insights-error.ts) expects
`Bundle event scan exceeded ...`. Remove both the old limit error and regex path
when their callers are replaced. Use one structured error contract for invalid
input, readiness, expired cursors, schema and storage failures.

## Exact reports without request-sized memory growth

Start with scoped native queries and three small logical storage concepts. Add
physical projection tables/collections only where the provider needs them:

| Logical data | Key and purpose | Correctness requirement |
| --- | --- | --- |
| Latest installation | Install ID -> latest event tuple and metadata | Conditional replacement by `(received_at_ms, id)`, including identity changes and activity-only events. Snapshot reports must use state from their own source generation. |
| Historical identity alias | Normalized alias/kind/install ID -> identity relationship | Deduplicate repeated reports; retain historical matches; use generation-frozen latest metadata for snapshot queries. |
| Report/job state | Query signature + source generation -> status, checkpoint, paged results and exact membership | Durable, bounded work; unique membership keys prevent duplicate counting; atomic publication after all sections reconcile. |

Raw events remain authoritative. SQL/Mongo can aggregate scoped data in the
database and avoid application materialization, but they still consume storage
reads and execution time. Apply measured time/read budgets; move a cold or large
query to the same report protocol instead of increasing server memory or timeout.

For Firestore/DynamoDB, and expensive SQL/Mongo reports, compute exact memberships
in bounded batches using persistent keys such as
`(report, metric, bundle, cohort-or-bucket, install ID)`. Use only the dimensions
actually requested. Active reports need latest-per-install and latest-per-bucket
state; select installations by final latest identity before publishing bucket
counts. Use a second resumable pass/join where necessary. Never keep a set of all
installations in one document, DynamoDB item, process, or aggregation result array.

For movement, count unique memberships separately for whole-window, bucket, and
cohort results. For active counts, compute distinct union over the window; do not
sum bucket counts. Replays update the same membership, and counts advance only
when a membership is newly created, or are reduced from completed membership
records. Hot counters must be partitioned or reduced after processing.

Persist and page large bundle/cohort outputs and long all-time series. A chart
can request a selected bundle or explicit resolution; its response must state
that scope. An optional "Other" grouping must be defined for that metric, not
computed by subtracting overlapping distinct sets. Grand totals must not silently
become top-N totals.

Recommended first release: reuse completed exact results for the three global
active windows and all-time overview; create scoped bundle/user/contains reports
on demand. Do not precompute every user × bundle × window combination. A report
captures one `asOfMs`, keeping the current rolling bucket math exactly. Incremental
membership reuse is a later optimization within the same semantics, not a reason
to block native history pages.

Fixed-hour/day **scalar counts** are insufficient for arbitrary shifted buckets.
Membership rollups can help for fully covered intervals, but partial intervals
and latest bundle selection require retained event detail. For the 24h chart with
shifted hourly boundaries, raw edge work can cover much of the window. Benchmark
that cost; do not promise constant-time exact arbitrary-window aggregation.

A persisted job makes an expensive query resumable, not cheap. Automatic refresh
must stay within a measured maintenance budget and coalesce identical requests.
Ship progress, retry, cancellation, fair per-database concurrency, and a runner
schedule; do not enqueue a new whole-history report on every refresh. Exact
historical reports can take longer than interactive pages. Prune expired derived
job/results after readers release them; this is not raw-event retention.

## Provider implementation matrix

Reuse existing time/ID, install/time/ID, identity/time/ID, and movement
type/from-or-to-bundle/time/ID indexes from
[`v1_0_0.ts`](../../packages/server/src/schema/v1_0_0.ts) where appropriate.
Add a new schema version; do not edit a deployed schema definition in place.
Actual index order must follow predicates and be confirmed with query plans.

| Provider surface | Native pages and lookup | Exact aggregation / maintenance | Delivery evidence |
| --- | --- | --- | --- |
| `plugins/postgres` | Kysely SQL keyset predicates and scoped indexes | Native grouped/distinct queries and latest-row queries; persistent jobs/projections for expensive reads | PostgreSQL integration, `EXPLAIN (ANALYZE, BUFFERS)`, migration and concurrent ingest |
| `plugins/supabase` | Scoped PostgREST pages where expressible; SQL RPC for unions/complex predicates | Versioned server-side SQL RPC and durable job tables | RPC types/migrations/permissions, PostgREST path integration, query plan |
| Cloudflare D1 REST | Native SQL in shared `d1Implementation.ts` | Chunked SQL/projection jobs under D1 invocation and query limits | Remote D1 integration, rows read/written, response and parameter sizes |
| Cloudflare D1 Worker binding | Same logical SQL contract through the binding | Bounded steps driven by scheduled Worker or explicit runner | Worker-runtime integration and parity with REST; no Node imports |
| Server Drizzle | SQLite, MySQL, PostgreSQL | Dialect-specific aggregate/latest-row SQL, durable projections as needed | Every supported dialect; no CockroachDB/MSSQL/MongoDB claim |
| Server Kysely | SQLite, CockroachDB, MySQL, PostgreSQL | Same semantic queries with dialect-specific execution | Every supported dialect; MSSQL is excluded by the adapter |
| Server Prisma | SQL providers: SQLite, MySQL, PostgreSQL, CockroachDB, MSSQL | Native supported operations or parameterized dialect SQL behind adapter; never `findMany` all events | Every supported SQL dialect, SQL capture/plans; Prisma MongoDB is unsupported |
| Server MongoDB adapter | Compound-index match/sort/cursor/limit | Native pipeline for grouped output, projections/jobs for expensive or high-cardinality reports | Explain plans, docs/keys examined, transaction/replay tests |
| Firebase Firestore | Dedicated native event collection and identity/latest projections | Persisted exact membership and resumable reports; no SQL-style group-by assumption | Emulator correctness plus Standard production read/write/index cost and transaction tests |
| AWS DynamoDB | Scoped keys, time buckets/write shards, finite stream merge | Conditional membership/latest updates and durable jobs; no table Scan in interactive reads | Local correctness plus real consumed capacity, hot-partition and GSI-lag tests |
| Mock | Deterministic implementation of the same native contract | Small reference oracle plus controllable jobs/clock/failures | Semantic conformance; not a substitute for physical-provider benchmarks |
| Third-party plugins | Same required typed query ports | No old-provider shim or scan fallback | Shared conformance tests and a concise implementation guide |

### SQL, Supabase, D1, and MongoDB details

Push bundle/install/type/time filters into indexed reads before pagination or
aggregation. Use explicit timestamp/ID ordering for latest rows; check SQL
collation and query plans on each dialect. SQLite/MSSQL/CockroachDB differences
must be handled behind the existing adapter surface, not exported into Console.
Batch bundle IDs and metadata lookups only at provider limits, preserving one
logical snapshot and complete output.

Supabase aggregate RPCs run on the database rather than collecting all PostgREST
ranges in the server. Restrict function execution to the intended admin database
role. Prefer `security invoker`; if a definer is unavoidable, explicitly fix its
search path and privileges. Do not make analytics available to client API keys or
anonymous roles. See [Supabase database functions](https://supabase.com/docs/guides/database/functions).

D1 requires bounded statements and resumable batches. Its documented limits cover
database size, query duration, bound parameters, and queries per invocation;
removing this application cap does not remove those limits. Record raw-event and
projection bytes at the target volume. Provide a capacity warning and migration
guidance before provider storage exhaustion, without silently deleting events.
Use current [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) when
choosing batch sizes for both REST and Worker implementations.

For MongoDB, put selective `$match` and indexed ordering before grouping; page
grouped output instead of `$push`-ing every event or installation into arrays.
Validate with `IXSCAN`/`DISTINCT_SCAN` where applicable and execution statistics;
aggregation syntax alone is not proof of an indexed plan. See
[MongoDB pipeline optimization](https://www.mongodb.com/docs/manual/core/aggregation-pipeline-optimization/).

### Firebase: isolate events from whole-database snapshots

1. Implement direct immutable document creation for event append, plus an atomic
   processing marker when projections are asynchronous. Read/update only affected
   latest/alias documents if maintaining them in the transaction.
2. Remove event collection loading/diffing from unrelated generic snapshot
   mutations. Remove Insights from generic create and multi-model commit; append
   is its sole mutation. Remove generic interactive event reads as the required
   page ports land; maintenance reads remain explicitly separate.
3. Implement ordered native event queries with composite indexes and cursor
   tuples. Installation movement history can merge the two indexed event types;
   do not filter thousands of unrelated activities after reading them.
4. Ship composite index definitions and index-readiness checks alongside the
   migration. Use targeted installation/latest and alias queries for lookup.
5. Persist exact report membership/results and resumable checkpoints. Bound
   document sizes, transaction writes, contention, and write amplification per
   report. Heavy ingestion must not contend on one global counter document.

Firestore's core aggregation operations return count, sum, or average, not a
general distinct/group-by pipeline. Their cost and latency still depend on scanned
index entries. Counting a deduplicated membership collection can be exact, but
counting raw activity documents is not MAU. See
[Firestore aggregation queries](https://firebase.google.com/docs/firestore/query-data/aggregation-queries).
The existing firebase-admin/Standard provider must work without assuming
Enterprise-only search or pipeline features.

### DynamoDB: model the actual access patterns

Use a versioned key layout, with escaped or hashed variable key parts and explicit
original IDs in records. Candidate access patterns to validate in the provider PR:

| Pattern | Partition / ordering | Notes |
| --- | --- | --- |
| Global event page | Time bucket + deterministic write shard; timestamp/ID sort key | Discover non-empty buckets from a bounded, paged directory. Merge newest candidates across the configured shard count. |
| Installation history | Install ID + event type + time bucket; timestamp/ID sort key | Query the two movement types. Time buckets also bound unusually active installs. |
| Bundle movement | Bundle ID + movement type + time bucket/shard; timestamp/ID sort key | Separate applied-to and recovered-from access paths. |
| Latest install / alias | Hashed install owner or normalized alias owner | Conditional latest tuple; historical alias records deduplicated by install. Prefix/contains result construction may require bounded jobs. |
| Report membership | Report + metric + deterministic shard; dimension/install key | Avoid one giant item or hot counter; reduce shard counts after completion. |

Choose a finite shard count from write-load tests, persist its layout version,
and define how cursors traverse old and new layouts during resharding. Do not
query every empty day since installation or every old layout for each page.
Bound work per request and use a continuation state if bucket discovery cannot
finish within that budget; absence of a result in one partition is not end-of-list.
Keep unconsumed merge candidates recoverable across requests.

`FilterExpression` operates after DynamoDB reads and does not reduce the capacity
consumed; `COUNT` is not a cheap distinct aggregate. Use key conditions for the
access pattern. GSIs are eventually consistent, so a completed report cannot use
an unverified GSI timestamp as a completeness watermark. See
[DynamoDB Query](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Query.html).
Sharded writes require fan-out reads and merging; benchmark that tradeoff rather
than hiding it. See
[DynamoDB write sharding](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-sharding.html).

Use explicit transactionally written access records where strong index readiness
is required, or publish a verified projection generation. Migrate the dedicated
append path from the old global partition; generic commits cannot contain Insights.
Conditional
raw writes, outbox markers, and index/projection retries must agree on event ID;
partial secondary-write success must not lose the raw event or double count it.

## Ingestion, maintenance, and migration safety

Ingestion acknowledges only after the raw event and its durable processing marker
commit together, or after a transaction also commits all required synchronous
projections. A best-effort second write, process-local queue, or fire-and-forget
task is not sufficient. Report-worker failure must not discard accepted events;
report errors and ingestion errors are separate operational signals.

Projection delivery is idempotent by persisted event ID. This is not network
exactly-once ingestion: the current ingestion path generates a new UUID/time for
each accepted request, so an SDK HTTP retry may create a distinct raw event.
Do not introduce SDK request deduplication as an undocumented metric change.

Persist job leases, per-shard checkpoints, retries, failures, and publication
state. A checkpoint advances only with its output writes. Protect against lease
expiry and concurrent workers with fencing/version checks. Apply bounded retry
and expose poison-record failures without skipping them into an "exact" report.

**A timestamp watermark is not a commit watermark.** `received_at_ms` is assigned
before the storage commit; an older timestamp can become visible after a scan
has passed it. New writers must assign a durable processing generation in the
same transaction as the raw row/marker. A provider can close a generation using
a transactional per-partition epoch fence: writers either commit into the old
epoch before closure or retry into the new one. Process all markers in closed
epochs before publishing their generation. A maximum UUID/timestamp alone, or
an eventually consistent index observed once, does not establish completeness.

The plugin-developer follow-up agreed on a concrete minimum: writers atomically
advance a transactional source counter with their event, and a job captures a
committed counter prefix once. All sections process exactly events within that
prefix and the job's event-time cutoff. The counter is not an ordinary SQL
sequence allocated before commit. Its shard count and physical representation
remain provider-owned, behind the opaque `sourceGeneration` value.

Reserve the per-query job/lease first, capture the source with a short consistent
read, then save the capture under that lease. A reservation awaiting capture has
a job ID but no source generation yet. After the capture is saved, retries reuse
it; a displaced lease holder cannot replace it or publish. Capture and reservation
need not share a transaction, and advancing counters do not invalidate the saved
prefix. Do not recheck every source clock when reserving/polling a report. Ordinary
polling reads the query head/job only.

SQLite/D1 can use one transactional counter because their writes are serialized;
do not impose 64 shards on them. SQL can index source sequence on the raw event
instead of duplicating it in an outbox. DynamoDB may need separate strong-readable
source records; eventually consistent GSI pages cannot prove a captured prefix
has been fully consumed. Its atomic commit must group updates to each shard clock
and remain within the native action limit, never split one public commit. MongoDB
multi-document source writes require a transaction-capable deployment; the
current optional/default-off transaction path cannot implement this guarantee.
Provider implementation must resolve that requirement explicitly, without a
non-atomic fallback. Existing event backfill and actual budgets remain gates.

Reports declare both their event-time `asOfMs` and included source generation.
Late commits in a later generation are reconciled into subsequent reports; they
do not mutate an already published snapshot. Old in-flight writers without the
new marker protocol require a cutover barrier and reconciliation before readiness.
Provider PRs must demonstrate this protocol with adversarial commit ordering.
During rolling deployment, route new ingestion to upgraded writers and drain old
in-flight requests before final reconciliation. Keep upgraded writers accepting
events throughout backfill. If any old writer can still append without markers,
do not publish complete coverage; a time-based overlap scan is not a proof that
all such writes were captured.

The server root remains runtime-neutral. Provide bounded maintenance steps through
DB tooling and a CLI/runner, with documented scheduled invocation for each host:
Node/local cron, a scheduled Worker for D1 binding, and an external scheduled
runner or native host scheduler for other deployments. Do not start an in-memory
`setInterval` or require an always-running Node daemon inside serverless handlers.
Schema/migration helpers stay under `@hot-updater/server/db`; `/node` remains HTTP
interop. A request can ensure a job exists, but cannot execute an unbounded backfill.

Schedule rolling expiry even when no events arrive. Last-seen membership eventually
leaves the 24h/7d/30d windows, and chart buckets move with `asOfMs`. A writer-triggered
counter alone would remain wrong during inactivity. If maintenance stops, keep
the old report labeled with its old time; never present it as a current count.

Migration sequence for an existing database larger than the current cap:

1. Install additive, versioned schema/index changes and new writer protocol.
   Do not do data backfill synchronously at startup or on first append.
2. Capture backfill scope and writer generations; persist a checkpoint. Backfill
   ascending native pages with bounded memory and writes. Native `scan` must be
   physically paginated even on Firebase.
3. Process concurrently arriving durable markers, deduplicating events that also
   appeared in backfill. Record progress and source coverage per partition.
4. Close/reconcile the initial source generation, including pre-upgrade in-flight
   writes. Verify source rows and projected memberships with counts/checksums and
   sampled exact report comparisons; replay unfinished batches after crashes.
5. Publish ready generations atomically. Enable event pages independently as soon
   as their native access paths are ready; enable each report family after its
   own validation. Never hide preparation behind an empty chart.
6. Publish each ready read path. Preserve raw data and migration checkpoints for
   recovery; do not retain old application read implementations. Reject writers
   that cannot maintain the new data protocol rather than silently losing markers.
7. Remove obsolete derived indexes/job results only through a data-safe migration.
   There is no API compatibility window. Raw retention changes require a separate
   decision and are not part of this task.

Preparation audits the complete stored raw record, including provider extensions,
unless the provider explicitly projects extensions out of its public row. At the
first invalid UUIDv7, malformed Unicode value, or oversize record, persist a
failed migration-poison state at the checkpoint. Retries resume only after the
row is repaired; they never skip, normalize, truncate, delete, or publish past it.

Authentication remains unchanged: admin Insights reads require the host's admin
authorization; client ingestion keys do not grant read/maintenance access. Scope
cache keys, job ownership, cursors, and generation lookup by database and authorized
context. Keep browser HTTP responses private; do not leak identity queries or
results across users or databases through shared caches.

## Implementation sequence and reviewable work packages

Each implementation PR needs its own meaningful tests and migration/docs notes.
Provider changes may proceed independently after the contracts, but no provider
may advertise a method before its conformance and storage-read checks pass.
`registerRequiredInsightsModelTests` is an internal official-provider suite in
this repository; this plan does not change `@hot-updater/test-utils` package
visibility or make the suite a supported third-party API. Each harness declares
finite per-request candidate-read ceilings for event, installation, and report
pages; the shared ceiling is 4,096 so sharded providers can state their real
fan-out without inheriting SQL-specific N+1 constants. Provider-native plan,
request, and byte evidence remains a separate gate and cannot be replaced by a
generous declaration.

| Package | Changes | Depends on | Exit criterion |
| --- | --- | --- | --- |
| P0: contracts and oracle | Freeze semantics; mandatory physical query ports, pages, reports, structured errors and cursor/live consistency; direct API replacement | This plan | Plugin-developer adversarial agreement on one contract for all eight operations; semantic cases include identity changes and shifted buckets. |
| P1: schema and durable processing | Additive schemas, provider query ports, source-generation protocol, runner/checkpoint primitives and readiness | P0 | Crash/replay/late-commit tests pass; no startup full backfill or runtime entry leakage. |
| P2: native browsing on every provider | Global/install/bundle event pages, latest metadata, exact identity path; Firebase snapshot isolation; Dynamo key/access migration | P0, P1 where migration requires it | 50,001+ history is browsable with bounded application memory and measured indexed storage reads on every official provider. |
| P3: exact reports on every provider | SQL/Mongo scoped aggregates; latest/alias projections; NoSQL exact membership jobs; active/movement/batch/cohort/all-time reports and historical contains semantics | P1, P2 | Full operation/provider matrix produces exact results or durable preparing results that complete at target scale. No official provider remains capped. |
| P4: Console and public adapters | Replace existing contracts; independent page/report loading, cursor URLs/Back and freshness UI; admin GET /events | P0, staged P2/P3 | End-to-end HTTP/RPC/Console states work with no old API/URL path, hidden scan or silently changed metric meaning. |
| P5: existing-data rollout and benchmarks | Backfill/cutover/rollback runbooks, capacity/freshness dashboards, full integration and performance evidence | P1–P4 | Large populated databases migrate online; acceptance matrix below passes; known provider limits and measured cost are published. |

Implement P2 before the expensive report work, but do not publish or merge an
incomplete required plugin contract. P3 and the full provider matrix remain release
gates. Do not merge unrelated mobile design changes into these work packages.

Console also needs to remove the hidden all-catalog reads in `collectBundles` and
`collectReleases` in `insights-rpc.ts`. Resolve metadata only for visible/selected
bundle IDs and page the selector/catalog. Preserve complete counts and deleted or
missing bundle labels without collecting every release on each overview request.

## Validation and release gates

### Scenario matrix

| Scenario | Required result |
| --- | --- |
| 0, 1, 50,000, and 50,001 events | Defined empty state and exact result; no native read fails because of the old cap. |
| 100,000 installations × 30 daily reports = 3,000,000 events | Rolling 30d count is exactly 100,000 at the fixed fixture time. All pages and report families work. |
| Few installations, very frequent activity | Event count is not mistaken for active installation count; ingestion cost and report behavior remain measurable. |
| All four event types, activity-only installs, apply/recover/adopt | Global vs installation history and movement vs activity retain their different meanings. |
| Same timestamps, different IDs; out-of-order commits; replay | Latest tuple and page order are deterministic; projection replay adds no membership twice; delayed commits are handled according to live vs published consistency. |
| User ID changes, old username aliases, null identity, Unicode/case | Historical contains finds the installation; returned latest metadata is frozen at the publication's captured generation; active user filter uses latest identity. Ordering/normalization agree across providers. |
| One install changes cohorts/bundles repeatedly | Whole-window distinct values do not become sums of overlapping cohort/bucket values. Batch summaries equal individual summaries at the same cutoff. |
| Arbitrary `asOfMs`, exact lower/upper boundaries, future rows | Rolling active buckets and UTC calendar movement buckets each match their reference formulas. |
| No new events for more than 24h/7d/30d | Scheduled expiry produces correct new snapshots; a stopped runner surfaces old freshness instead of current zero or current stale counts. |
| Many bundles/cohorts and years of history | Result pagination/resolution prevents huge responses without changing totals or silently omitting dimensions. |
| First, middle, and deep pages with concurrent ingestion | No repeats; complete traversal for fixed data; late-commit behavior follows the documented live contract; snapshot traversal uses captured generation. |
| Back/Previous, rejected offset inputs, expired or wrong-scope cursors | Valid cursor position is retained; invalid input has an explicit restart action. No compatibility offset resolution, cross-scope access or silent reset. |
| Backfill interrupted/retried while ingesting, failed index writes, lease takeover | No loss, double counts, false readiness, or unbounded restart; independent page readiness and rollback remain correct. |

Run the semantic suite through the model, real server wrapper, admin HTTP where
present, and Console RPC. Include runtime-neutral entry tests and all schema
generators. The shared five-method oracle exercises every selector, requested
limits and harness-reported storage reads, cursor namespace/scope/cutoff binding,
typed readiness and migration poison, exact totals, durable job reuse, and atomic
publication. Its harness freezes the report clock and inserts a malformed retained
row through provider-native test controls. It also advances a reserved historical
lookup and report by one bounded step, appends matching post-reservation data,
then requires completion within a bounded number of larger portable steps from
the original source generation. Providers must run that suite against
their own storage harness;
the oracle alone cannot certify physical scalability. Semantic conformance and
physical-plan evidence are separate gates: the provider harness reports actual
native candidate/document reads immediately after each selector, and query-plan
or service metrics prove that the bounded count was not computed after a hidden
full filter or sort.

Build `@hot-updater/plugin-core` before downstream server/provider tests, then
verify the generated `dist/internal` declarations and runtime exports contain the
same required model, constants, and validators as source. A downstream test that
resolves stale package output is not acceptance evidence. A workspace source
alias is acceptable only when its type and runtime paths both use source.

### Performance and cost evidence

Use the 3-million-event/100,000-installation fixture plus skewed workloads on every
official provider. Record versions, region/network path, hardware/service tier,
indexes, data sizes, concurrency, warm/cold state, and sample counts. Compare
the old path where it can complete; label old-path cap failures rather than
fabricating timing comparisons.

Suggested initial acceptance budgets, **not measured guarantees**:

- Native history/exact-ID page: same-region server latency p95 under 1 second at
  20 concurrent reads while ingesting 100 events/second; independently test a
  500 events/second burst. Test capacity/tier must be stated with the result.
- Completed report fetch: p95 under 1 second, excluding report construction.
  Report construction time, maintenance spend, and displayed freshness are
  separately reported. For the common three global active windows, target a
  completed report no more than 15 minutes old at the reference workload. If
  this cannot be maintained within a documented budget, optimize membership
  reuse before declaring the overview production-ready; cold all-time/contains
  jobs have explicit measured completion times rather than this interactive SLA.
- No request or job step retains memory proportional to total raw history or
  unique installations. Start with 1,000-row maintenance batches and reduce per
  provider transaction/response limits. Native pages fetch `limit + 1` per
  stream, not one universal `limit + 1` promise for all sharded queries.
- Increasing history from 50,001 to 3,000,000 records must not cause history-page
  storage reads to grow proportionally to history length. Allow and report
  bounded merge/index traversal cost. Aggregation cost may grow; it must be
  accounted for in the maintenance/freshness budget, not hidden off the chart.
- Append and an unrelated Firebase mutation must perform zero full-event
  snapshot reads. Track append p95 before/after, accepted/error counts, and
  writes per event; no accepted-event loss under worker outage.

Capture PostgreSQL/SQL plans and rows/buffers; D1 rows read/written and storage;
Firestore document/index reads, writes, index footprint and contention; DynamoDB
`ScannedCount`, consumed read/write capacity, partitions and throttling; MongoDB
keys/documents examined, spill, and result size. Measure synchronous ingestion
cost, asynchronous processing cost, catch-up rate, and idle expiry work separately.
If a provider meets latency only through excessive reads/writes, publish the cost
and revise its access pattern before signing off.

Final evidence should include the provider × eight-operation result matrix,
reproducible seed/benchmark commands, fixed-time expected metrics, native query
plans/cost samples, migration interruption/recovery logs, memory measurements,
and Console states/screenshots. Run repository lint, tests, type checks, affected
builds and provider integrations; add appropriate package changesets for runtime
API/schema changes. A docs-only planning commit needs no runtime changeset.

The release is complete only when all official providers have a supported path
for every operation, large existing databases migrate without losing events,
and exactness/freshness/cost claims match the evidence. Raising 50,000, returning
partial totals, leaving NoSQL permanently bounded, or moving a full scan from
the browser to a server request does not meet that gate.
