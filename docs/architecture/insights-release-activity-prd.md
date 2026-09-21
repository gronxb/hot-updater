# PRD: Release Insights

Updated: 2026-09-20. This document records the agreed requirements. Implementation
and provider performance still require validation.

## 1. Objective

Provide EAS Update-style release metrics while keeping event collection,
provider implementation, and storage simple. Bundle rows show accumulated
release activity; Insights supports period-based analysis and retains App usage.
All dashboard metrics must avoid reconstructing results from raw event pages.

The core write path is one provider-native DB transaction that appends the
event and updates its summaries together. The event log preserves reported
facts; the overview serves aggregate reads. Provider simplicity and this
transaction boundary are requirements, not optional implementation preferences.

## 2. Console

### Bundle rows

Use the column heading **Insights**, with these three values:

| Field          | Meaning                                                         |
| -------------- | --------------------------------------------------------------- |
| Downloads      | Accepted download, verification, and staging completion reports |
| Known launches | Accepted successful-launch reports                              |
| Known crashes  | Accepted OTA launch-failure reports, shown as count and rate    |

Example: **Downloads 107 · Known launches 789 · Known crashes 2 (0.25%)**.

- All three values and the rate cover the release's entire collected history.
  Identify a row by release ID, platform, and channel, not artifact ID alone.
- Show no All time/All-time/Lifetime caption, badge, or time-range suffix.
- Replace the row's Active, Pending, Downloaded, and Recovered presentation
  with the three fields above. Do not add Unique users or per-row charts.
- Read the maintained summaries for visible rows in one Console request.
  Do not scan events or sum every historical date to calculate these values.
- Metric help explains reported OTA launch failures and the rate denominator.
  Support hover, keyboard focus, and touch. Opening Insights carries the
  release, platform, and channel into the release-health view.

### Insights: release health

- Show **Unique users**, **Launches**, **Failed launches**, and **Crash rate**.
- Default to the last seven days. Provide period, channel, and platform
  filters with an optional release drilldown, preserving selections in the URL.
- Without a release selection, show the selected channel/platform's complete
  scope. Do not derive it from the currently loaded release page.
- Show daily Launches / Failed launches and a link to existing event history.
  Summary values and charts use the same period and scope.

### Insights: App usage

Preserve App usage, its existing default period, filters, charts, and distribution
views. Its period remains independent of release health and release drilldown.

| Selected period | Metric | Chart interval |
| --------------- | ------ | -------------- |
| Last 24 hours   | DAU    | Hour           |
| Last 7 days     | WAU    | Six hours      |
| Last 30 days    | MAU    | Day            |

- Retain channel, platform, and app-version filtering.
- Count distinct installations reporting activity in the selected rolling
  window, including no-change and download reports. Reports without a known
  OTA release, including embedded installations, remain eligible.
- Preserve distribution's existing latest-matching-report meaning. Do not
  replace it with a sum of per-day or per-release unique counts.
- Replace the raw-history calculation with aggregate queries. Keeping MAU
  does not permit retaining the 100-event paging loop or 50,000-event ceiling.

### Numeric and data-state presentation

Show distinct-user metrics as ordinary rounded numbers. Do not display
approximation badges, tilde prefixes, notices, precision details, error bars,
or accuracy settings. Accuracy is an internal validation requirement.

Keep empty, unavailable, and partial collection distinct: valid empty counts
are zero; failed or unavailable reads show **—**; partial coverage shows
**Partial**. With no reported launch attempts, show **— / No launch reports**
for Crash rate. Supply measurement and coverage information. Metric help
describes installation identity and collection scope, without claiming complete
telemetry or guaranteed exact distinct-user counts.

## 3. Metric definitions

| Metric                          | Definition                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Downloads                       | Accepted `UPDATE_DOWNLOADED` reports after successful verification and staging                                           |
| Launches / Known launches       | Accepted successful-startup reports for the actual running release                                                       |
| Failed launches / Known crashes | Accepted recovery reports identifying an unverified staged OTA that failed to launch                                     |
| Crash rate                      | `failedLaunches / (launches + failedLaunches) * 100`                                                                     |
| Unique users                    | Approximate distinct `install_id` count from attributed successful launches within the selected release/scope and period |
| DAU / WAU / MAU                 | Approximate distinct `install_id` count from activity reports in the selected App usage window and filters               |

Download, launch, and failure counts are exact for accepted event IDs. The
distinct-user metrics use mergeable approximate summaries. App usage's reporting
population and release health's successful-launch population remain separate.
Use the persisted `install_id`, not optional `user_id`, as installation identity.

Use server `received_at_ms` for periods and buckets. Delayed reports belong to
their receipt period. Derive rates from counts for the same scope and period;
do not average daily rates or use unique users as the denominator. The API may
return a zero rate for a zero denominator; the Console uses the empty state above.

## 4. Event collection

Reuse the existing SDK initialization, native lifecycle hooks, event types,
payload fields, and `/events` endpoint.

| Existing event      | Release contribution                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `UPDATE_DOWNLOADED` | Destination Downloads +1                                                                                               |
| `UNCHANGED`         | Actual running release Launches +1 and successful installation observation                                             |
| `UPDATE_APPLIED`    | Actual running release Launches +1 and successful installation observation                                             |
| `RECOVERED`         | Failed source Failed launches +1; successfully started destination Launches +1 and successful installation observation |

All eligible activity reports also contribute their installation identity to
App usage under its filters. Repeated launches add launch reports but no new
distinct identity for the same installation.

### Successful launch and attribution

- Native content appearance is the success boundary for ordinary, updated,
  and fallback launches. Module loading, initialization, an animation frame,
  or an update-check result alone does not establish success.
- Report successful startup independently of whether an update is found,
  downloaded, or the update check fails. Reuse the existing native observer.
- Capture release, bundle, and channel when the native outcome is known.
  A later staged selection, including another release sharing the same
  artifact, must not change that report's identity.
- For failed B and successful fallback A, count B's failure and A's success.
  Selecting A alone is not success. If recovery runs the embedded bundle
  instead, do not attribute it to an unavailable stored fallback release.
- Handle known source and destination IDs independently. Leave unknown
  attribution unknown; do not reconstruct it from historical events.

### Failed launch

Count an unverified staged OTA that could not launch, triggered native fallback,
and produced an accepted `RECOVERED` report. This includes eligible startup
crashes and missing/invalid local staged launch files. The row label
**Known crashes** uses this same OTA launch-failure definition in metric help.

Do not count update-check/network errors, download/hash/unpack failures before
staging, a pending restart, manual rollback or release administration, ordinary
post-success errors, or force quits/OS termination without qualifying recovery.
Neither elapsed time nor the absence of a successful report proves failure.
Keep the existing native recovery policy; do not add a general crash collector.

### Delivery and duplicate handling

- Attempt at most one automatic startup report per JS runtime. Suppress
  repeated init/remount reports and duplicate callbacks for the same staged
  download. Preserve ordering of startup and subsequent download reports.
- Insights disabled means no automatic reports. Telemetry failure must not
  block update checking or turn a successful update into a failed update.
  One failed send must not prevent later reports.
- Keep the existing transport and timeout behavior. Do not add automatic HTTP
  retries, a durable outbox, a heartbeat, or a background upload service.
- Assign the server event ID and receipt time once per accepted request.
  Provider retries reuse them and contribute only once. Independent HTTP
  requests receive separate IDs; this is not end-to-end exactly-once delivery.
- Offline or undelivered reports are not counted or reconstructed. Native
  recovery state survives restart for recovery reporting, not as a telemetry
  delivery guarantee.

## 5. Plugin and read contract

Require `getReleaseActivity` for every Insights provider. Do not add
`getReleaseStats`. Keep ingestion arguments unchanged:

```ts
recordEvent(input: { readonly event: BundleEventRow }): Promise<void>;
recordInsights(input: { readonly event: BundleEventRow }): Promise<void>;
```

Use these release-health queries:

```ts
getReleaseActivity({ releases });
getReleaseActivity({ releases, timeRange: { start, end } });
getReleaseActivity({ scope: { channel, platform }, timeRange: { start, end } });
```

- `releases` without `timeRange` returns maintained lifetime report counters
  only: no unique-user calculation or chart payload.
- With `timeRange`, return period totals, Unique users, and daily activity.
  A scope query requires a period and reads scope aggregates directly.
  Supply either `releases` or `scope`, never both.
- `start` is inclusive and `end` exclusive, in UTC Unix milliseconds. Resolve
  default ranges before the provider call; keep all results within the same
  requested bounds. Do not silently change rolling windows or widen ranges.
- App usage retains its aggregate-report interface and behavior, backed by
  aggregate access supporting its existing filters, windows, and intervals.
- Return numeric metrics and coverage information. Keep summary serialization,
  merging, and precision controls out of the public plugin contract.

## 6. Storage and performance constraints

### One overview store

Retain the original event log and add at most one overview table/collection.
Keep existing latest-event records for their existing query role. DynamoDB
retains its existing physical table.

The overview holds release lifetime counters, period summaries for release
health and channel/platform scope, and the summaries needed by App usage.
Maintain only the dimensions and time buckets needed by the agreed screens.
Do not add separate stores per metric, release, or period.

### Logical schema and integrity

Use `insights_overview` as the overview's logical name, following existing
provider naming prefixes. It replaces the superseded feature's overview; it is
not an additional store alongside it. Keep raw-event and latest-event names.

| Data                          | Identity and stored fields                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Event log                     | Existing unique event ID and immutable event payload                                                                   |
| Existing latest-event records | Existing installation key and fields needed by existing access paths                                                   |
| Overview                      | Unique scope/period identity, typed download/launch/failure counters, and bounded distinct-user summaries where needed |

- Make release versus channel/app scope, platform, app-version filtering, and
  lifetime versus time-bucket aggregation explicit. A missing release identity
  and an all-releases scope must not share an ambiguous key. Likewise, distinguish
  an all-versions filter from a specific version.
- Enforce one row/document per logical scope and period through a deterministic
  non-null primary key or equivalent unique constraint. Do not depend on
  provider-specific NULL uniqueness behavior or unchecked delimiter concatenation.
  Preserve the event fields' identity and case-sensitivity rules.
- Use explicit period kind and bucket boundaries. Do not encode lifetime rows
  as a negative timestamp. Time-bucket rows must identify their granularity and
  valid UTC start; lifetime rows have no actual time interval.
- Store counters as non-null, non-negative integers with a zero default. Use
  wide integer storage, such as SQL BIGINT, SQLite INTEGER, or the provider's
  equivalent exact integer representation. Preserve integer precision through
  driver/API conversion; do not silently round counts or store them as floating
  point. Keep existing public event timestamp semantics.
- Store ordinary counters in named fields, not a generic metric-name/value
  table or a JSON document containing all metrics. Keep distinct-user summaries
  compact, bounded, and internally versioned. Lifetime rows need no user summary.
- Derive Crash rate and extracted unique-user values rather than persisting
  redundant values that can disagree with their source counters/summaries.
- Keep historical events and summaries independent of release deletion. Do not
  require a live release row to accept a report or cascade-delete its history.
  Keep aggregate fields out of mutable release deployment metadata.
- Remove fields and indexes introduced solely for the superseded lifetime
  markers or attribution-state reconstruction. Preserve unrelated existing
  schema behavior; do not perform a repository-wide schema cleanup.

### Indexes and provider mapping

Design keys for exact summary lookup and equality-on-scope plus range-on-time
reads. Every added index must serve an agreed query. Reuse primary/unique indexes
instead of duplicating them, and do not index counters or summary payloads.

| Provider family   | Physical access requirement                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL / SQLite / D1 | Typed columns, unique summary identity, and a composite index with equality scope/kind columns before the bucket-time range; native atomic upsert/increment within the write transaction |
| MongoDB           | Deterministic document identity or compound uniqueness, a scope/time compound index, and native transactional counter/summary updates                                                    |
| Firestore         | Deterministic summary document keys, only required query indexes, and indexing exemptions for counters and summary payloads; native transactions                                         |
| DynamoDB          | Overview items in the existing table; scope-aware partition keys and sortable period keys for Get/Query access, with conditional event insertion and transactional updates               |

Do not force identical physical keys or SQL types on every provider. Do not put
every new summary under one global partition key or grow all dates into a single
document. A hot release/scope can still contend: validate that workload rather
than assuming key distribution solves single-summary write contention.

Validate App usage's rolling windows and latest-report distributions against
their actual access plans; a schema containing HLL fields alone does not
establish those query semantics or costs.

### Atomic append and summary update

`recordEvent({ event })` uses one native DB transaction to:

1. Append the original event, enforcing event-ID uniqueness.
2. Only for a newly inserted event, increment the relevant stored counters and
   update the applicable distinct-user summaries.
3. Commit the event and all affected summaries together, then report success.

Any failure rolls back the entire operation. An already accepted event ID is
a no-op for these aggregates. A provider retry reuses the same ID. Concurrent
writes must preserve both counter increments and distinct observations.
Do not commit the append and counters separately or repair a partial write
later through another service. A native atomic batch is acceptable only when
it provides the same all-or-nothing transaction guarantee.

Here, updating a count means incrementing a maintained counter. It does not
mean running `COUNT(*)`, `COUNT(DISTINCT ...)`, or replaying past events after
each append. Touch only the event and directly affected summary/latest-record
keys, with indexed access and bounded summary data. These are two storage
responsibilities, not a promise of exactly two statements per event.

### Bounded distinct-user summaries

Use mergeable HLL-family summaries for distinct-user metrics. Consume every
eligible accepted observation; do not truncate the input or maintain unbounded
ID arrays or per-installation membership rows for these counts.

Merge compatible summaries across the requested period and scope before
extracting the count. The same installation must retain the same identity
across dates and releases. Never sum extracted daily or per-release unique
counts. Keep successful-launch users separate from reporting users.

### No over-fetching

- Bundle row reads scale with visible releases, not release age or event count.
- Period reads use only the requested scope and time aggregates. Scope reads
  must not enumerate releases; distinct-user reads must not enumerate users.
- Apply these rules to the complete Insights page, including App usage,
  distribution, filter requests, and release health.
- Remove raw-history loops and the 100-event/50,000-event limits from these
  metric paths. Do not replace them with another arbitrary scan ceiling or
  silently truncated result. Event-explorer pagination remains separate.
- Native batching/pagination of requested aggregate results is allowed.
  Caching is not a substitute for an efficient underlying read.
- Measure write contention, retries, latency, and data read/written as well
  as read request counts. Cheap summary reads do not make writes free.

### Provider simplicity

Provider implementation itself must remain simple. Do not introduce public
`InsightsStorage`, prepared-event/projection protocols, or another lifecycle
that plugin authors must implement. A shared helper or private orchestration
framework that merely relocates complexity does not satisfy this requirement.

Do not introduce historical attribution reconstruction, lifetime outcome
markers, Redis, queues, background rebuilds, or speculative counter sharding.
Do not require additional application telemetry hooks or a new analytics service.

## 7. Validation and delivery

- Test startup with and without an available update, update-check failure,
  download/apply/recovery, repeated init, staged-versus-running identity,
  fallback validity, Insights disabled, and failed telemetry delivery.
- Test event-ID idempotency and concurrent provider writes. Inject a failure
  between append and summary update and verify that neither is committed.
  Verify a retry increments once, and that a failure updating any affected
  summary rolls back all counters and distinct observations for that event.
- Validate distinct-summary merging and internal accuracy against exact test
  fixtures with repeated users, overlapping periods/releases, and empty data.
  Validate App usage windows, filters, and latest-report distribution semantics.
- Verify the whole Console uses aggregate reads. Increasing event history or
  matching installations must not increase metric reads for a fixed scope and
  period. Review provider-specific write costs and implementation complexity.
- Check SQL/document query plans and provider read/write consumption against
  the declared keys and indexes. Verify unique-key races, integer round trips,
  release deletion, summary size bounds, and same-scope write contention.
- Verify the agreed labels, independent periods, plain numeric presentation,
  missing/partial data states, and absence of bundle-row lifetime captions.
- Update built-in providers, generated schemas/examples, documentation, and
  the changeset. Modify the existing pre-GA `1.0.0` migrations directly.
- Complete code review, build, type checks, lint, unit and integration tests.
  Run `standalone-dynamodb`, `standalone-drizzle`, `standalone-prisma`,
  `standalone-kysely`, and `standalone-mongodb` through `hot-updater-agent`
  against the final implementation. Earlier runs do not validate this redesign.
- Implement on a new branch from updated `next` and open a new PR against
  `next`. Preserve the old branch and uncommitted work as reference; link and
  close PR #1313 after the replacement exists. Include verified results and
  Console screenshots in the new PR.

Research evidence and previously considered alternatives are kept separately
in [the OTA metrics comparison](./insights-ota-metrics-comparison.md).
