# Insights storage decision and RC replay

Date: 2026-09-09. Baseline: #1289 at
`ef1a071e83fc870038a591b7b83d91a6a738f96c`. Implements the
[PRD](./insights-event-storage-prd.md).

## Decision

Remove the shared installation table and row type. A provider receives one
canonical event, including typed `metadata`, and returns canonical latest events.
Core derives installation DTOs and supplies explicit count predicates. This
reduces the required storage model and lifecycle knowledge, **not necessarily
storage bytes or dashboard query cost**.

| Provider | Storage and query decision | Evidence and cost |
| --- | --- | --- |
| PostgreSQL; Drizzle/Kysely PostgreSQL; Prisma PostgreSQL/CockroachDB | One event insert; indexed anti-join for latest reads/counts | Native PostgreSQL/PGlite correctness and generated schemas; SQL semantics covered by shared adapter tests. No production latency measurement; CockroachDB is not independently benchmarked. |
| Supabase | One idempotent event insert; security-invoker, non-materialized latest-event view | PGlite schema/view/RLS checks and PostgREST continuation tests. No stored projection or event-write RPC. Native service pagination is completed before returning lookahead. |
| MySQL through Drizzle/Kysely/Prisma | One event insert; same anti-join with native bindings/collations | Dialect conformance and existing example integration. No inference of MySQL latency from SQLite measurements. |
| SQLite/LibSQL through Drizzle/Kysely/Prisma; D1 | One event insert; indexed anti-join | Local SQLite comparison below; native Bun SQLite and D1 workerd tests. D1 billed rows/network latency are not measured by this local test. |
| MongoDB | One idempotent document insert; index sort, first event per installation, then filters | Native replica-set tests cover concurrent duplicate IDs, rejected inserts, exact IDs, user changes and query plans. The query engine can group; no second collection is required. Aggregation cost remains a deployment consideration. |
| DynamoDB | Retain private latest and user items, copying the canonical event | Query is partition-key/range based. Current-user membership cannot be obtained by filtering old events. Existing atomic ID guard, event, bundle index, latest item and user-membership updates remain; no new reducer or infrastructure. |
| Firestore Core API | Retain private `hot_updater_v1_insights_latest` collection with canonical event documents | Native count queries count matching documents, not latest-per-install groups. One atomic event/latest write plus native user/count queries avoids replaying history in the application. Metadata is excluded from automatic indexing. |
| Mock/reference | Derive latest from the event map | Executable semantic reference; not a scalable production fallback. |

The native APIs used by the bundled Firestore adapter expose
[count/sum/average aggregations](https://firebase.google.com/docs/firestore/query-data/aggregation-queries),
and DynamoDB [Query operates on one partition key](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.html).
Those access paths justify retaining private copies without building a new scan
service first. This is a decision about the APIs this adapter uses, not a claim
about every Firestore edition or every possible third-party database.
MongoDB can optimize
[indexed sort followed by first-per-group](https://www.mongodb.com/docs/manual/core/aggregation-pipeline-optimization/).
Native integration verifies our pipeline; optimizer behavior can vary by version.

## Measured SQLite trade-off

Reproduce from the repository root:

```sh
python3 scripts/bench-insights-storage.py > /tmp/insights-storage.json
```

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

No product latency SLO was supplied. We choose event-only SQL for the requested
schema/authoring simplification and accept this read-cost regression explicitly.
The one-million-event result rules out claiming cheap frequent full-history
counts. Its scope-count measurement reached the 10-second cap, and the bundle
count had a 4.785-second p95. An earlier exploratory scope-count run was about
1.8 seconds; the repeat shows why local timing must not be presented as a stable
service guarantee. Bulk loading is also slower at this size despite having fewer
logical writes. A dashboard issuing these queries every second would add much
more work than one issuing them every minute. No mixed-load throughput result
is inferred from these isolated timings. This change does
not add an automatic storage mode, background worker, retention policy or cache.
No production-network latency, billed-unit, concurrent mixed-load, or universal
cross-provider speedup claim is made.

## NoSQL resource and authoring trade-off

For N installations with H events each, a bounded application-side reference
that folds all retained events reads N×H event documents/items before filtering
current users or scope. With N=10,000 and H=100 this is 1,000,000 candidates;
a private latest representation has 10,000 candidates, and indexed user pages
can read only relevant latest candidates. These are deterministic cardinalities,
not measured cloud billing units. Exact per-install lookup alone would not
justify a projection; current-user and latest-scope queries do.

Firestore accepts a new winning event with two transactional document reads and
two writes; an older event needs only its event write. A duplicate performs no
writes. Latest exact lookup is one document read; user lookup and counts use
native predicates. DynamoDB normally reads the ID guard and latest item, then
writes the ID guard, event and bundle index, plus the latest item and optional
user item; switching users also deletes the old user item. Native retries and
secondary-index work add costs. These are the same private atomic access paths
as #1289, with a canonical event replacing a separately derived installation row.
A full event copy costs more bytes than the former snapshot, but avoids pointer
fetches and another domain shape. Native failure, duplicate, user-switch, and
fresh-storage replay tests cover these choices.

| Author obligation | #1289 | This implementation |
| --- | --- | --- |
| Required logical methods | Five | Five; latest reads return events |
| Required Insights storage models | Event + installation | Event only |
| SQL ingestion | Insert plus conditional installation update/transaction | One idempotent insert |
| NoSQL ingestion | Atomic event + prepared installation/index writes | Same atomic keys/documents; copy event directly |
| Lifecycle fields to maintain | Separate running/pending storage shape | None; core derives response fields |
| Required helper calls | Snapshot helper documented | Zero |
| Ancillary attributes | Five provider columns/fields | One JSON metadata object using existing conventions |
| Setup/test framework | Native prerequisites + shared conformance | Same; no background service or custom repair API |

The fixed count input accepts one or two OR predicates with `field`, `value`,
and `types`. Evaluate them in one native count/traversal so overlapping predicates
or a concurrent lifecycle change cannot double-count an installation. A plugin does not
need Downloaded-versus-Applied domain logic. SQL authors implement a latest query;
NoSQL authors keep their native document/item layouts. Maintainers own strategy
research, native reference implementations, and repair procedures. Third-party
authors implement the supplied plain specification and run conformance tests.

## Offline RC normalization and private-copy rebuild

The existing single `1.0.0` initialization migration is edited because this is
unreleased RC storage. Its version marker cannot distinguish old and new layouts.
**Rerunning initialization does not upgrade an already initialized database.**
No live infrastructure is changed by this PR.

Use a maintenance window with ingestion and admin reads stopped for the entire
export, target preparation, verification and cutover. Do not expose a partial
replay. If downtime cannot be arranged, stop here and design a separate catch-up
procedure; this PR does not implement online replication.

1. Back up the original provider namespace and record runtime/configuration,
   indexes, endpoint, credentials and signing configuration. Export canonical
   `bundle_events` in full using native pagination, not Console chart samples.
   For DynamoDB export `row` from the canonical `bundle_events` partition only;
   do not export duplicate user/bundle-index items as additional events.
2. Initialize a **separate empty target** with the revised initial schema/indexes.
   Copy all non-Insights data faithfully: bundles, patches, channels, releases,
   catalogs, API keys, settings and provider-owned catalog/index records. Keep
   artifact objects and storage/signing configuration. Do not use public model
   inserts to recreate catalog history or generate replacement IDs.
3. Convert the old flat event export (one JSON object per line):

   ```sh
   node --experimental-strip-types scripts/insights-rc-export.ts old-events.ndjson events.ndjson
   ```

   This maintainer tool only transforms a local file. It refuses to overwrite an
   output and rejects missing legacy metadata keys or mixed old/new fields.
   On conversion failure, discard the incomplete output and correct the export.
   It preserves event IDs, receipt times, nulls and transition columns. Already
   normalized events are unchanged. It does not invent missing download telemetry.
4. Load the prepared target plugin in an operator-owned local script and replay
   each parsed event through `target.models.insights.record({ event })`, awaiting
   each call. The normal core boundary validates the event. Do not POST the old
   event to the client endpoint: that would assign a new ID and receipt time.
   Replay order does not affect the winning tuple. Keep the target offline until
   all events succeed. No provider needs to implement another repair method.
5. Verify complete sorted event IDs and payloads against the normalized export;
   paginate to exhaustion. Compare exact installation results, current-user
   pages, scoped/bundle counts and preserved non-Insights rows. Verify native
   indexes are ready and DynamoDB secondary reads have converged. Run authenticated
   client/admin smoke checks against the target before switching the preserved
   endpoint/configuration. Keep the original backup for rollback.
6. Switch storage and matching server code together, then resume traffic. Retain
   old storage until verification and an explicit cleanup decision. A rollback
   after accepting new target writes needs a new frozen export/catch-up plan;
   blindly switching back would lose those reports.

This same procedure repairs missing/corrupt private latest/user state. Replaying
into the damaged original store does **not** repair it because duplicate IDs are
no-ops. Native Firestore and DynamoDB tests deliberately remove a latest copy,
prove duplicate replay cannot fix it, then replay a frozen export into empty
Insights storage, including reverse order and duplicate inputs. They verify
latest/user results and event identity while preserving unrelated data. Unit
coverage verifies old-column normalization before normal validated replay.
