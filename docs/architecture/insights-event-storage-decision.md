# Insights storage decision

Updated: 2026-09-10. Implements the
[PRD](./insights-event-storage-prd.md) while preserving the public database
specification at `dfee6cb63e6cf6d79a03453284d2417f2c1600db`.
The original #1289 baseline is
`ef1a071e83fc870038a591b7b83d91a6a738f96c`.

## Decision

Keep one canonical event model and the existing five Insights methods. Add small,
provider-private indexes where latest-state queries otherwise read retained
history or unrelated installations. `recordEvent` still receives one immutable
event; latest queries still return canonical events or counts using the same
predicates. No public installation model, new helper, lifecycle reducer, or
storage-mode option is introduced.

SQL, D1, Supabase, and MongoDB use a private `bundle_event_heads` table/collection
with nine fields copied from the winning event:

| Fields | Access requirement |
| --- | --- |
| `install_id` | One head per installation; exact lookup and stable page order |
| `id`, `received_at_ms` | Canonical event identity and monotonic receipt-tuple ordering |
| `user_id` | Current-user lookup |
| `platform`, `channel` | Scoped counts |
| `type`, `from_bundle_id`, `to_bundle_id` | Existing explicit bundle-count predicates |

Metadata, app version, release IDs, and derived running/pending fields are absent.
Four secondary indexes serve current-user pages and scope/from-bundle/to-bundle
counts. The bundle indexes use `(type, platform, channel, from_bundle_id,
received_at_ms)` and the equivalent `to_bundle_id` tuple. Latest pages hydrate
at most 101 canonical events; counts read heads without fetching event payloads.
A pointer-only table has fewer columns but cannot filter a user or scope before fetching events
from unrelated installations. Full event copies would duplicate metadata without
helping these SQL/MongoDB access paths.

Event acceptance and a winning head update are atomic. Ordering is the global
maximum `(received_at_ms, id)` for the installation, before any user/scope/bundle
filter. Duplicate IDs preserve the first accepted event and do not advance state;
older events enter history without replacing the head. User changes, logout,
and scope changes replace the same canonical access fields, with no lifecycle
interpretation in the provider.

| Provider | Private storage and latest-query decision | Cost boundary |
| --- | --- | --- |
| PostgreSQL; supported Drizzle/Kysely/Prisma SQL dialects | Atomic append and monotonic head update; indexed head pages/counts | Latest reads depend on current installations, not history depth; native dialect behavior requires integration coverage |
| Supabase | Atomic append/head update through PostgreSQL; PostgREST selects bounded head IDs then fetches canonical events; counts use heads | PostgREST continuation must complete before returning a short page; no history anti-join |
| D1 | Atomic batch append/head update; indexed head pages/counts | Local workerd rows read/written are measured below; production billing and network latency are separate |
| MongoDB | Transactional event/head write; indexed head match, sort and limit, then canonical event lookup; count heads | At most one head per installation; no global history grouping for current-user or scope reads |
| DynamoDB | Retain full canonical latest/user items; add compact scope-count items in the existing table | Count reads only the selected scope's compact installation items, including those outside the window; no new table or GSI |
| Firestore Core API | Retain atomic private latest-event documents and native user/scoped count queries | Native indexes count current documents; no event replay or added projection |
| Mock/reference | Derive latest from the event map | Semantic reference, not a production scaling strategy |

DynamoDB scope items have a scope partition key and stable installation-ID sort
key. Their payload contains only receipt time, type, and from/to bundle IDs.
Winning writes update the item and remove the previous scope membership in the
same transaction. Stable keys prevent a last-report update from moving an
already-counted installation past the cursor. Full latest/user items still serve
canonical-event responses without pointer fetches. Firestore keeps its existing
native latest collection; this correction adds no collection or indexing burden.

## Production observation and comparison limits

The 2026-09-10 investigation of the E2E D1 database reported approximately
2.49 million rows read by 771 latest-installation counts and 1.40 million rows by
1,025 current-user pages: about 3,230 and 1,366 rows per query. The two query types
accounted for roughly 3.89 million reads. Repeated E2E verification and
history-dependent latest queries both contributed. Release Catalog HTTP caching
does not cover the direct database reads used by those checks.

The separate relay database read about 28,000 rows in that period. Comparing its
total with the E2E database's 4.87–5 million yields 174–179 times the volume,
**not** the design's read multiplier: their data and request mixes differ. A
matched dataset and query is required to attribute a change to storage strategy.
The historical SQLite latency measurements below likewise cannot be converted
into rows-read ratios.

## Historical SQLite comparison: rejected read trade-off

These results were recorded by
`6fa7ba442cc6c4912148dc986274ecee28b4343e` against #1289 at
`ef1a071e83fc870038a591b7b83d91a6a738f96c`. The unchanged artifact preserves the
original experiment; it does not measure the current private-head implementation.
Reproduce with `python3 scripts/bench-insights-storage.py`. The script now pins
the original snapshot schema and the event-only schema at
`dfee6cb63e6cf6d79a03453284d2417f2c1600db`, whose event-only schema matches the
recorded experiment, so current provider-schema edits cannot alter the comparison.

[Raw results and query plans](./measurements/insights-event-storage-sqlite.json)
record SQLite 3.50.4 on macOS 26.3 arm64. One process, serial warm reads, seven
samples after warmup; reported p95 is the maximum of seven samples. Each strategy
loads its real initial schema into a temporary database. The baseline stores
flat events and the #1289 running/pending installation snapshot. The replacement
stores events with metadata and two additional latest/user event indexes.
All completed query results are asserted equal. Each query attempt has a
10-second measurement cap; an interrupted measurement reports a lower bound
rather than a partial count. This cap is a benchmark limit, not a product SLO.

Datasets have 1,000 or 10,000 installations and 10 or 100 events per installation.
Ten hot installations have twice that history. They include anonymous installs,
user changes, shared users, multiple scopes, repeated downloads, apply, and
recovery. Low-level conformance tests additionally cover equal timestamps,
case-sensitive IDs, logout, delayed receipt order and concurrent writes.

Values below are p50 / p95 milliseconds, baseline → event-only:

| Installations × history | Exact lookup | Current-user first page | Scope count | Running-bundle count |
| --- | --- | --- | --- | --- |
| 1,000 × 10 | 0.005/0.012 → 0.007/0.010 | 0.035/0.104 → 0.136/0.150 | 0.019/0.020 → 6.822/7.753 | 0.022/0.024 → 4.206/4.396 |
| 1,000 × 100 | 0.004/0.008 → 0.033/0.039 | 0.014/0.016 → 3.007/3.349 | 0.018/0.022 → 149.461/155.343 | 0.023/0.024 → 74.999/77.266 |
| 10,000 × 10 | 0.005/0.007 → 0.009/0.014 | 0.031/0.038 → 0.634/0.910 | 0.144/0.152 → 110.662/125.389 | 0.188/0.274 → 59.490/69.073 |
| 10,000 × 100 | 0.005/0.009 → 0.035/0.091 | 0.032/0.124 → 10.593/43.710 | 0.141/0.175 → ≥10,000 (cap) | 0.177/0.272 → 1419.541/4784.698 |

Later user-page results are in the raw artifact; the largest dataset measured
.033/.047 → 9.809/13.525 ms. The event latest index serves the correlated newer-event
check; the user index serves user pages. Scope counts examine history candidates
from the receipt index and check whether each has a newer event. They therefore
remain much more expensive than counting installation rows.

| Installations × history | Bulk load ms, baseline → event-only | DB bytes, baseline → event-only |
| --- | --- | --- |
| 1,000 × 10 | 208 → 164 | 5,570,560 → 7,266,304 |
| 1,000 × 100 | 3,692 → 3,365 | 52,740,096 → 72,335,360 |
| 10,000 × 10 | 2,173 → 1,823 | 53,768,192 → 70,656,000 |
| 10,000 × 100 | 41,321 → 50,501 | 516,444,160 → 711,180,288 |

Bulk load uses one transaction and includes row preparation; it does not measure
per-event durable commits. At the largest size, sampled append work inside that
transaction was .034/.061 → .032/.077 ms. The database grew about 38% because
metadata keys repeat in every event and two history indexes replace four much
smaller installation indexes. Removing a table alone is not a space optimization.
The system SQLite build does not expose `dbstat`, so separate index-byte totals
are unavailable; total database bytes and index names are recorded instead.

The previous decision explicitly accepted this regression for schema and authoring
simplicity. That acceptance was mistaken: the benchmark already showed a scope
count reaching the 10-second cap and a bundle count with a 4.785-second p95.
A missing latency SLO did not justify shipping history-dependent work for common
dashboard reads. Removing a public snapshot model remains useful, but does not
require removing private database indexes. The new decision below supersedes
event-only SQL and MongoDB latest-state queries.

## Matched local D1 read comparison

Run from the repository root:

```sh
node scripts/bench-insights-reads.mjs > /tmp/insights-reads.json
```

The benchmark pins the #1289 snapshot schema at
`ef1a071e83fc870038a591b7b83d91a6a738f96c` and the event-only schema at
`dfee6cb63e6cf6d79a03453284d2417f2c1600db`. It compares the original anti-join,
a tuple-comparison/scope-index improvement, a two-field pointer table, and the
nine-field heads with user/scope indexes and with the two bundle indexes selected
for the implementation. All strategies must return identical canonical IDs and counts.
It varies retained history and unrelated installations independently.

The [raw results and query plans](./measurements/insights-reads-d1-local.json)
record Miniflare 4.20260609.0. The selected strategy uses the current D1 migration
verbatim and records its SHA-256 plus a checked column/index manifest. Queries
use the provider's `json_extract` parameter binding and OR predicate shape.
Bundle IDs use valid UUIDv7 values. All answers are checked against the same
expected canonical IDs and counts. The table uses one common bundle on 999
installations and one rare bundle on the remaining installation.

| Query; 1,000 scoped installations | #1289 snapshot reads | Event-only reads | Selected heads reads | Event-only / heads |
| --- | --- | --- | --- | --- |
| Scope count; 10 events/install | 1,000 | 63,999 | 1,000 | 64.0× |
| Scope count; 100 events/install | 1,000 | 186,000 | 1,000 | 186.0× |
| First 101-row user page; 10 events/install | 101 | 7,541 | 202 | 37.3× |
| First 101-row user page; 100 events/install | 101 | 20,181 | 202 | 99.9× |
| Rare bundle count; 10 events/install | 1 | 68 | 8 | 8.5× |
| Rare bundle count; 100 events/install | 1 | 177 | 8 | 22.1× |

Against the original snapshot, the event-only scope count reads 64–186 times as
many rows and the first user page reads 74.7–199.8 times as many in these fixtures.
Snapshot pages return stored installation payloads; the new public contract
returns full canonical events. The selected 101-row page therefore reads 101
heads and 101 event rows. Exact lookup reads two rows. Neither hydration cost
grows with retained history.

Adding 9,000 installations outside the target scope increases event-only scope
reads to 154,000 while selected heads remain at 1,000. The two-field pointer
alternative reads 20,000 rows for that count. A tuple-comparison/index change
alone still reads history and is not consistently cheaper as history grows.
Planner choices vary with data: these are measured fixture ratios, not a linear
extrapolation or the causal multiplier of the quota incident.

Without bundle indexes, the runtime-shaped OR count reads 2,000 rows even for a
single rare installation. The selected indexes reduce that to eight. Counts for
bundles present on 999 and 100 installations read 1,005 and 107 rows respectively.
The D1 OR form uses the indexes; a UNION alternative adds work, so D1 keeps
its existing predicates. Native MySQL uses the separate access plan below.

These `rows_read` and `rows_written` values are local Miniflare/workerd D1 engine
observations, not production charges, cloud-network timings, or another SQL
engine's performance. Reads are measured once after `ANALYZE`; elapsed time
includes local proxy work and is not a latency SLO. Fixture construction bulk-loads
history and final heads, so its write total is not an ingestion benchmark.
Separate atomic receipt samples measure winning, duplicate, and delayed events.
For a new winning event on an existing installation, the snapshot writes 11 rows,
event-only writes eight, and the selected schema writes 12: 50% more than
event-only and one more than the snapshot. A duplicate writes zero; a delayed
event writes seven without changing the head. Moving user lookup from the event
index to the much smaller head index removes one index write from event append.

At 1,000 installations with 100 events each, fixture storage changes from
85,315,584 to 82,444,288 bytes, a 3.37% reduction. With ten events each it changes
from 8,634,368 to 8,761,344 bytes, a 1.47% increase. These `meta.size_after` values
show the trade-off between an index per historical event and compact current
entries; they do not establish a universal storage reduction. Native provider
integration and query-shape tests separately establish supported behavior and
bounded access paths.

## Native SQL access and concurrency checks

PostgreSQL, D1, and SQLite retain the OR count. Native MySQL instead uses one SQL
statement containing two disjoint scalar counts:
`COUNT(g1) + COUNT(g2 AND (g1) IS NOT TRUE)`. This denotes counts over the matching
head rows, not SQL's `COUNT(boolean_expression)`. The second branch excludes
matches already counted by the first, while retaining rows where `g1` is null.
Both branches share one statement's read view; the public OR semantics and
single-observation requirement are unchanged. Drizzle, Kysely, and Prisma apply
this optimization only to MySQL's two-predicate bundle counts.

In a native MySQL fixture, the rare-bundle OR plan examined 251 heads to return
one installation; the disjoint branches examined zero and one. For a common
bundle returning 999 installations, the examined rows changed from 1,000 to
250 plus 1,000. This accepts extra work for a common bundle to avoid scanning
unrelated current bundles for selective queries. Both plans stay independent of
retained event history. These native plan observations are separate from D1's
`rows_read` measurements and do not imply the same optimizer behavior elsewhere.

Prisma Insights recording uses the configured provider/client default transaction
isolation for PostgreSQL, MySQL, and SQLite. Atomic event insertion and the
conditional monotonic head update preserve the storage contract without forcing
Serializable for this operation. A PostgreSQL probe of 16 concurrent writes to
the same installation produced 15 SQLSTATE `40001` aborts when Serializable was
forced. CockroachDB retains Serializable with bounded retries for recognized
serialization conflicts, including the exact SQLSTATE `40001`; unrelated raw
query errors are not treated as retryable conflicts. This decision concerns
Insights recording and does not change other transaction domains' isolation.

## Native NoSQL access checks

The [MongoDB integration scenarios](../../packages/server/src/adapters/mongodb.integration.spec.ts)
capture the model's actual driver pipeline and explain it on a MongoDB 7 replica
set. Holding 24 current installations constant, adding 2,400 older events and then
240 installations in another scope leaves these measured reads unchanged:

| Query | Keys examined | Documents examined |
| --- | --- | --- |
| Ten-row user page, including canonical event lookup | 20 | 20 |
| Scope count returning 24 | 25 | 0 |
| Bundle count returning one | 2 | 0 |

A separate 1,000-installation scope verifies selectivity: the rare bundle count
examines two keys and no documents, and an absent bundle examines one key and no
documents. A bundle present on 999 installations examines 1,000 keys and 1,000
documents. Overlapping OR predicates still count each installation once; the
999-installation overlap reads 1,999 keys and 1,000 documents. Counts remain
proportional to relevant current entries rather than becoming constant-time.

The [DynamoDB integration scenario](../../plugins/aws/src/dynamoDB.integration.spec.ts)
uses LocalStack with 24 target installations, adds 240 historical events and 96
installations in other scopes, and records `ScannedCount = 24` in one count query
throughout. The previous global-latest partition query examines 120 items on the
same final dataset, versus 24 for the scoped items: five times as many items.
This is a matched native item-count comparison, not an AWS charge estimate.
Firestore's existing latest-document/scoped-count implementation is unchanged.

## Plugin-author agreement

The adversarial review included an operator, a SQL author, a NoSQL author, and
maintainers. The agreement preserves the supplied plain-data specification while
moving storage research and bundled optimizations to maintainers. An author
implements native I/O and atomicity; they are not required to select a core
helper, learn pending/apply rules, or build a synchronization service.

| Author obligation | #1289 | Current public contract |
| --- | --- | --- |
| Required logical methods | Five | Five; latest reads return events |
| Required Insights storage models | Event + installation | Event only; private physical indexes permitted |
| Ingestion input | Event + prepared installation | One canonical event |
| Lifecycle fields to maintain | Separate running/pending shape | None; core derives response fields |
| Required helper calls | Snapshot helper documented | Zero |
| Ancillary attributes | Five provider columns/fields | Typed JSON metadata using existing conventions |
| Setup/test framework | Native prerequisites + conformance | Same; no background service or public repair API |

The fixed count input accepts one or two OR predicates with `field`, `value`,
and `types`. Evaluate them in one native query or stable installation traversal
so overlapping predicates do not double-count an installation. Authors do not
need Downloaded-versus-Applied domain logic. A third-party provider may use a
native full event copy, a compact index, or another implementation satisfying
these semantics; `bundle_event_heads` is not a required public table.

The write/read trade-off remains explicit. SQL and MongoDB add one small current
row per installation and transactional write work. DynamoDB adds one compact
current-scope item and removes its old membership on a scope move. These structures
bound common latest-state reads without duplicating historical metadata. They do
not make exact counts constant-time, accelerate historical graphs, or establish
a cross-request snapshot. Existing secondary-index visibility limitations remain.

## Release scope

Update only the existing unreleased `1.0.0` initialization and generated provider
artifacts. Keep the public database model and canonical event schema unchanged;
do not add a second RC migration or a runtime conversion path. One-off cleanup of
development databases remains a private operator task, not a conversion API or
public package setup procedure. Initialized databases are not repaired by replaying
duplicate IDs: duplicate acceptance is a no-op. Rebuild evidence uses a fresh
target and the same event contract, without exposing a new plugin method.
