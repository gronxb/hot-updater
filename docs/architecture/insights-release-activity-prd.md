# PRD: Aggregated Release Activity Without Over-fetching

- Status: **Implemented and validated** on
  `feature/insights-release-activity` in a pull request based on `next`.
- Written: 2026-09-15.
- Baseline: `origin/next` at `ec78756926cac3b23ca32c1d3acefe28d2ebb7ab`.
- Migration policy: this feature is pre-GA, so update the existing `1.0.0`
  schemas and migrations directly. Do not add a follow-up schema version solely
  for this change.
- Priority: P1. Size: L. Risk: high because the change affects atomic Insights
  ingestion across every built-in database provider.
- This document is the implementation source of truth for API semantics,
  correctness, database cost, provider responsibilities, rollout, and
  acceptance criteria.

## Product Goal

The Bundles list must show, for every visible release:

- installations whose latest observed state is active on that release;
- installations waiting to apply that release;
- unique installations that downloaded that release during collected history;
  and
- unique installations that recovered from that release during collected
  history.

Insights must show the same summary together with report activity for a selected
time range. Database reads for these views must not grow with accumulated raw
event history.

## Definition of Done

1. `{ releases }` reads only materialized summaries for those releases. It does
   not read raw events, hourly buckets, every installation state, or every
   lifetime marker.
2. `{ releases, timeRange }` additionally reads only hourly buckets for the
   requested releases and interval. The summary keeps its current/lifetime
   meaning.
3. Bundle statistics no longer use the 100-event pagination loop or the
   50,000-event scan ceiling. Missing aggregation support never falls back to a
   full scan.
4. Native atomic writes preserve current attribution, lifetime uniqueness,
   idempotency, and late or out-of-order ingestion.
5. Every built-in provider, the Console, shared conformance tests, and the final
   pre-GA `1.0.0` schemas are updated in a pull request whose base is `next`.

## Out of Scope

- Redesigning App Usage DAU/WAU/MAU computation or event-explorer pagination.
- Removing `listEvents`, `findLatestEvents`, or the existing public raw overview.
- Globally changing unrelated list pagination or a shared `PAGE_SIZE`.
- Requiring an SDK upgrade, adding lifetime Active, or estimating success and
  failure rates.
- Online rebuilds, CDC, queues, Redis, speculative counter sharding, or raw-event
  TTL.
- Applying production migrations, deploying, or merging the pull request.

App Usage still uses the legacy raw-history reader. Its 100-event pagination and
50,000-event ceiling therefore remain in that out-of-scope path. They are absent
from Bundle rows and Bundle Activity release statistics.

## 1. Product and API Decision

The primary requirement is bounded reads. For the same requested releases and
time range, adding raw history or unrelated releases must not increase the data
read. Changing page size or adding a frontend cache does not satisfy this
requirement. Verification uses database rows/items examined and request counts.

Keep the five existing public Insights methods and add one method:
`getReleaseActivity`. Do not add `getReleaseStats`.

`releases` identifies the releases to query. Omitting `timeRange` returns only
current state and collected lifetime totals. Providing `timeRange` adds the
series for that interval. The range applies only to the series. Omission never
means “return a lifetime series.”

## 2. Plugin Authoring Constraint

The release-activity feature must not introduce an `InsightsStorage`,
`InsightsStorageAdapter`, prepared-event protocol, projection transaction API,
or equivalent storage abstraction into the public plugin-author contract.

The public ingestion method remains:

```ts
recordEvent(input: { readonly event: BundleEventRow }): Promise<void>;
```

Its argument and calling convention do not change. At the lower-level database
implementation boundary, `recordInsights({ event })` also retains its existing
input.

The only new feature capability visible at that boundary is the optional
`getReleaseActivity` read. `createDatabasePluginAdapter` exposes the method on
the resulting model and returns `InsightsAggregationUnsupportedError` when a
legacy implementation does not support it.

Built-in provider projection state, CAS retries, native transactions, key
encoding, and materialized counters are Hot Updater implementation details.
They may use private modules inside this repository, but they are not exported
from `@hot-updater/plugin-core` as a plugin-author API.

Providing a shared/public projection helper is **not** considered a solution to
plugin complexity. A helper that still requires plugin authors to understand
and wire revision state, lifetime markers, current deltas, hourly counters, and
transaction ordering merely relocates the complexity. Projection orchestration
helpers and their prepared-write types remain internal and unsupported.

Custom/legacy plugins retain their existing `recordEvent` implementation and do
not need to adopt a new storage adapter. If they do not implement bounded release
activity, that capability fails explicitly; core must not synthesize it by
scanning their raw events.

## 3. Metrics and Identity

Aggregation keys use `(platform, channel, releaseId)`. Installation identity is
the existing `install_id`; it is not a user count or a physical-device count.
`bundle_id` identifies a file, so releases referencing the same file remain
separate.

| Field | Meaning |
| --- | --- |
| `activeInstallations` | Installations whose latest observed running state is attributed to the release |
| `pendingInstallations` | Installations whose latest observation downloaded the release and is waiting to apply it |
| `downloadedInstallations` | Unique installations that reported `UPDATE_DOWNLOADED` for the release during collected history |
| `recoveredInstallations` | Unique installations that reported `RECOVERED` from the release during collected history |

Current state first selects an installation’s globally latest receipt tuple and
then applies platform/channel scope. A scope change must not revive an older
state from the previous scope. Active has no 30-day expiry because inactivity or
app deletion cannot be inferred without another report. The UI labels it as the
latest observed state.

Do not infer lifetime Downloaded from APPLIED. Attribute lifetime Recovered to
the source release. Repeated reports from the same installation contribute once
to a lifetime count. If a report has no release ID and valid current-state
inheritance is impossible, do not guess a release.

The following are not invariants: `active <= downloaded`,
`recovered <= downloaded`, or the sum of lifetime counts across releases equals
all unique installations. The API exposes no success/failure rate.

## 4. Public Read Contract

```ts
type ReleaseReference = {
  readonly releaseId: string;
  readonly platform: "ios" | "android";
  readonly channel: string;
};

type ReleaseActivityTimeRange = {
  /** Inclusive UTC Unix timestamp in milliseconds, aligned to an hour. */
  readonly start: number;
  /** Exclusive UTC Unix timestamp in milliseconds, aligned to an hour. */
  readonly end: number;
};

type InsightsHistoryCoverage =
  | { readonly kind: "complete"; readonly sinceMs: number }
  | { readonly kind: "partial"; readonly sinceMs: number | null };

type ReleaseActivity = {
  readonly release: ReleaseReference;
  readonly summary: {
    readonly activeInstallations: number;
    readonly pendingInstallations: number;
    readonly downloadedInstallations: number;
    readonly recoveredInstallations: number;
  };
  readonly series?: readonly {
    readonly startMs: number;
    readonly downloadedReports: number;
    readonly appliedReports: number;
    readonly recoveredReports: number;
  }[];
  readonly measuredAtMs: number;
};

interface InsightsModel {
  // Existing signatures and semantics remain unchanged.
  recordEvent(input: InsightsRecordEventInput): Promise<void>;
  listEvents(
    input: InsightsListEventsInput,
  ): Promise<readonly BundleEventRow[]>;
  findLatestEvents(
    input: InsightsFindLatestEventsInput,
  ): Promise<readonly BundleEventRow[]>;
  countLatestEvents(input: InsightsCountLatestEventsInput): Promise<number>;
  countEvents(input: InsightsCountEventsInput): Promise<number>;

  getReleaseActivity(input: {
    readonly releases: readonly ReleaseReference[];
    readonly timeRange?: ReleaseActivityTimeRange;
  }): Promise<{
    readonly coverage: InsightsHistoryCoverage;
    readonly data: readonly ReleaseActivity[];
  }>;
}
```

### Arguments and Summary Semantics

- `releases` contains 1 to 20 unique tuples. Reject invalid or duplicate values
  and return one result per input in input order.
- Without `timeRange`, read only summaries and omit `series`. Do not access raw
  events or hourly buckets.
- A range requires both `start` and `end`. Both are non-negative safe-integer UTC
  Unix milliseconds on exact hour boundaries. Reject null, one-sided bounds,
  Date objects, and date strings.
- Do not accept `appVersion`, arbitrary dimensions, sorting, or page cursors.
- The four summary values for one release form one coherent native observation.
  The API does not promise one snapshot across every release, across summary and
  series, or across separate calls.
- `measuredAtMs` is the read time for that release. It is not a historical cutoff
  or processing watermark.
- The releases model validates existence. A prepared aggregation store returns a
  zero summary for a valid key with no observations.

```ts
// Bundles: current state and lifetime totals for visible releases.
await insights.getReleaseActivity({ releases });

// Insights: the same summary plus reports in the selected interval.
await insights.getReleaseActivity({
  releases: [selectedRelease],
  timeRange: {
    start: Date.UTC(2026, 8, 14, 0),
    end: Date.UTC(2026, 8, 15, 0),
  },
});
```

The grouped `timeRange` makes the paired bounds explicit. Existing APIs that use
`fromMs`/`toMs` are not renamed by this change.

### Time Series

- Use fixed one-hour UTC buckets with `[start, end)` semantics.
- Allow 1 to 720 hours per release. The largest logical response is
  `releases.length × hours`, capped at 14,400 buckets.
- Return sparse ascending buckets without duplicate timestamps. No reports
  produces an empty array, which does not imply that no lifetime history exists.
- UI ranges 24h, 7d, and 30d represent 24, 168, and 720 hourly buckets.
- Series values count accepted event IDs, not unique installations. Repeated
  reports from an installation are additive across time.
- Re-recording the same event ID does not increment a bucket. Different IDs for
  HTTP retries or one logical update attempt remain distinct reports.
- Late events can correct older buckets. Do not treat a closed bucket as
  permanently immutable.

### Coverage

- `complete/sinceMs` means aggregation is gap-free from the first guaranteed
  collection point. It does not claim knowledge before instrumentation.
- A non-null `partial/sinceMs` means a verified continuous interval begins there
  while earlier history is incomplete. Use null when continuity cannot be
  proven.
- Never infer `sinceMs` solely from the oldest retained event.
- Fill a sparse missing bucket with zero only when its entire interval is inside
  verified continuous coverage. Boundary buckets remain partial; uncovered empty
  buckets are unknown.
- Unsupported aggregation throws `InsightsAggregationUnsupportedError`.
  Unprepared schema throws `InsightsAggregationNotReadyError`. Neither condition
  may fall back to raw events.
- Counts are non-negative safe integers and fail explicitly on overflow.

## 5. Internal Ingestion and Atomicity

Core owns the release-attribution reducer and prepared projection calculation.
Built-in providers own only their private native persistence code. These private
parts must not become public plugin requirements.

For each accepted event, the built-in implementation atomically commits:

- first-write-wins insertion of the canonical event;
- existing latest-event/user/scope index updates;
- expected installation revision validation and next bounded state;
- current Active/Pending deltas;
- first insertion of a lifetime marker and its counter increment; and
- one hourly report counter increment.

A duplicate event ID is a complete no-op. A conflict writes nothing. On a CAS
conflict, core retries with the same event ID and receipt tuple after re-reading
state. Retries are bounded. If a timeout makes commit status ambiguous, the same
canonical ID is retried.

The existing public `recordEvent({ event })` signature is preserved throughout
this flow. Call sites do not construct prepared events, revisions, markers,
deltas, or transaction objects.

## 6. Bounded Release Inheritance State

Core keeps this logical state per installation:

- **H:** the greatest `(received_at_ms, id)` tuple with its running key and
  pending target.
- **Running key:** `(platform, channel, currentBundleId)`.
- **A:** the latest explicit release assignment among events with H’s running
  key. Explicit null on APPLIED/RECOVERED is an assignment; null on
  UNCHANGED/DOWNLOADED inherits.
- **B:** the greatest tuple among events whose running key differs from H’s key.

The running release is A’s value when `A.tuple > B.tuple`; otherwise it is
unknown. When a new H uses a different key, the old H becomes the barrier. Older
anchors cannot affect attribution for the new key and can be discarded.

The state remains constant in size and avoids replaying installation history.
It does not infer release-less lifetime download or recovery outcomes.

Independent exhaustive and randomized checks compared this reducer with a
sorted reference fold over hundreds of thousands of prefixes. Native provider
transactions and performance still require separate integration evidence.

## 7. Physical Storage and Read Bounds

Each built-in provider needs indexed private storage for:

- raw events and canonical latest-event records;
- bounded attribution state and revision per installation;
- unique `(scope, release, install, metric)` lifetime markers;
- current/lifetime summaries per release; and
- report buckets keyed by `(scope, release, hour)`.

Lifetime totals are materialized counters. They are never recomputed by counting
all markers/states or summing all historical buckets during a read.

| Request | Allowed reads | Growth behavior |
| --- | --- | --- |
| `{ releases }` | Requested release summaries plus constant-size readiness/coverage metadata | `O(releases)`, independent of events and history length |
| `{ releases, timeRange }` | The same summaries plus requested hourly buckets | `O(releases × requested hours)` |

Bundle statistics must not replace the old 100-event page with another raw-event
page size. The Console sends visible releases in one API call. Providers use
native batch/key lookups or indexed scope/release queries.

A provider may paginate aggregate buckets when a native response limit requires
it, but only inside the requested range. There is no common `pageSize = 100`
rule. This bounded aggregate pagination differs from traversing accumulated raw
events.

One API call does not promise one physical query. Native batch limits, readiness
checks, and CAS retries are allowed, but actual rows/items read and round trips
must stay within the stated bounds. A native `COUNT` over an unbounded set is
still unbounded.

## 8. Console Behavior

- Bundle rows call `getReleaseActivity({ releases })` once for visible releases.
- Bundle detail uses the same summary query.
- Insights calls the method with one selected release and `timeRange`.
- Active/Pending are latest-observed state; Downloaded/Recovered are collected
  lifetime installation counts.
- The range selector affects only the Reports graph. Summary values remain stable
  when the range changes.
- `appVersion` remains an App Usage filter and is not added to release activity.
- Do not issue one request per release, prefetch off-screen releases, or traverse
  every release-list page to calculate statistics.
- Keep App Usage and the public raw overview on their existing semantics.

## 9. Schema and Rollout

1. Modify the existing pre-GA `1.0.0` schemas and migrations directly.
2. Keep generated schemas, provider scaffolds, readiness checks, fixtures, and
   infrastructure documentation aligned with the final schema.
3. Development databases that applied an earlier RC migration are not upgraded
   automatically by editing the old file. Recreate disposable local databases;
   preserved data needs a separate operational migration.
4. Do not delete or reset user data during implementation.
5. A missing projection schema fails readiness explicitly and never triggers a
   raw scan.

Fresh schema initialization can establish complete coverage from that point.
Migrated or partially populated stores must report partial coverage unless a
gap-free rebuild is proven.

## 10. Required Verification

Shared and native tests cover:

- summary-only reads that fail if raw events, hourly buckets, installation
  states, or all lifetime markers are queried;
- ranged reads limited to requested release keys and UTC-hour bounds;
- duplicate IDs as complete no-ops;
- repeated lifetime outcomes from one installation counting once while distinct
  event IDs still increment report buckets;
- APPLIED, RECOVERED, UNCHANGED, and DOWNLOADED attribution, including null
  inheritance;
- same-file releases, scope changes, late/out-of-order tuples, and deterministic
  tuple ties;
- concurrent installation and hot release/hour writes without lost increments;
- ambiguous commit retry using the same event ID;
- complete/partial coverage and zero/partial/unknown buckets;
- invalid input, unsupported implementations, overflow, and missing schemas;
- one Console request for visible releases and no release-level N+1; and
- App Usage and public raw-overview regressions.

Meaningful reducer tests compare results with an independent reference fold.
Native integration tests exercise actual transaction paths where available.

## 11. Adversarial Review Conclusions

- A read-only API cannot preserve current/lifetime correctness, so built-in
  ingestion maintains bounded materialized state.
- A 50,000 cap only limits damage; release activity removes raw scans instead of
  increasing the cap.
- One HTTP request can still over-fetch in the database, so acceptance measures
  native rows/items and key/range bounds.
- Lifetime summary fields count unique installations, while series fields count
  accepted reports.
- Omitting `timeRange` is summary-only, avoiding an unbounded “all-time series.”
- Coverage prevents partial stores from displaying false zeroes.
- Atomic conditional writes prevent lost hot-counter updates.
- Editing a pre-GA migration requires an explicit note for already initialized
  RC development databases.
- A new public storage adapter or shared helper would delegate internal
  projection complexity to plugin authors and is therefore rejected.

## 12. Implementation Areas

| Area | Responsibility |
| --- | --- |
| Plugin core | Public release-activity types and validation; private reducer/orchestration |
| D1, DynamoDB, Firebase, Supabase | Native private projection persistence and bounded reads |
| Server adapters | Kysely, Drizzle, Prisma, MongoDB private persistence and reads |
| Mock/test utilities | Independent conformance state and fixtures |
| Console | Batched Bundle summaries and selected-release Insights activity |
| Schema/tooling | Final `1.0.0` schema, generators, readiness, infrastructure guidance |
| Documentation/release | This PRD, Insights guide, changeset, measurements |

Provider-private implementation modules may share repository-internal code.
They must not expose projection storage types or orchestration helpers from the
public package entry point.

## 13. Performance Acceptance

Let `R` be requested releases, `H` requested hourly buckets, and `E` stored raw
events. Summary reads are `O(R)` and series reads are `O(R × H)`. Constant-size
readiness/coverage metadata is allowed.

| Experiment | Condition | Pass condition |
| --- | --- | --- |
| History growth | Same R and summary, 10× E | Zero raw/hourly summary reads and no E-proportional work |
| Installation growth | Same R, more installations | No full state/marker count; stable summary-key reads |
| Unrelated growth | Add other scopes/releases/hours | No scan or filter-after-read outside requested keys/range |
| Range growth | H from 24 to 168 to 720 | Read only matching aggregate buckets |
| Visible batch | One and multiple visible releases | One Console API request and no per-release raw query |
| Maximum request | R=20, H=720 | Correct result within 14,400 logical buckets |
| Counter contention | Concurrent writes to one release/hour | No lost or duplicate increments |
| Null UNCHANGED | Current attribution remains unchanged | No unnecessary release-summary counter write |

D1 records `result.meta.rows_read`. Other providers use query counts and native
evidence such as examined rows/documents/items, scan count, consumed capacity, or
execution plans. Mock call counts alone do not prove native read bounds. Record
unavailable measurements as unavailable, never zero.

## 14. Completion Checklist

- [x] Add `getReleaseActivity({ releases, timeRange? })` and retain the existing
  five public methods.
- [x] Preserve the `recordEvent({ event })` and `recordInsights({ event })`
  inputs.
- [x] Keep projection backend/protocol types and orchestration helpers out of the
  public plugin-author API.
- [x] Avoid raw/hourly/installation/marker scans in summary-only reads.
- [x] Restrict ranged reads to requested releases and hours.
- [x] Remove bundle-statistics 100-event pagination, the 50,000-event ceiling,
  and raw-scan fallback.
- [x] Implement native atomic materialization for every built-in provider.
- [x] Cover duplicates, ordering, concurrency, inheritance, scope, and coverage.
- [x] Update final fresh-install `1.0.0` migrations and RC limitations.
- [x] Migrate Bundles and Insights while preserving App Usage/raw overview.
- [x] Pass required build, type, lint, unit, and integration checks.
- [x] Push a `next`-based branch and open a `next`-based pull request.

Completion requires implementation, validation, and a reviewable PR. If a native
guarantee proves impossible or data loss is found, report the counterexample and
impact rather than weakening correctness silently.

## References

- [AWS DynamoDB transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)
- [Cloudflare D1 batch statements](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [Firestore transactions and batched writes](https://firebase.google.com/docs/firestore/manage-data/transactions)
- [MongoDB transactions](https://www.mongodb.com/docs/manual/core/transactions/)
- [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [Google AIP-190: Naming conventions](https://google.aip.dev/190)
- [Google AIP-145: Ranges](https://google.aip.dev/145)
