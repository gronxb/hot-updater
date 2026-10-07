# Built-in Insights

Insights is the `insights()` server plugin. It stores immutable reports, keeps
each installation's latest event, and maintains the counters, gauges, and
sketches its reads come from; the server assembles operational views and
selected-bundle deployment evidence.

```ts
createHotUpdater({
  database,
  plugins: [insights(), apiKeys()],
});
```

`insights()` mounts ingestion on `handlers.client` and queries on
`handlers.admin`. The admin handler does not authenticate itself: mount it
behind framework authentication, or call the Insights provider from an
authenticated server surface, as the Console does. API keys authorize client
requests and ingestion, not admin queries. React Native sends lifecycle reports
through the `insights()` client plugin, which `@hot-updater/react-native`
exports; an app without it sends none.

## Where Insights runs

The plugin (`@hot-updater/plugin-insights`, in `plugins/insights`) declares its tables and
aggregates, and the storage engine runs them on every database adapter, so a
custom database implements the adapter contract, not Insights methods. Its API,
validated at the boundary as `InsightsModel` from `@hot-updater/plugin-core`,
is what the Insights routes, the Console, and the e2e harness read through:

| Method                                                                 | What the plugin does                                                                                                                                                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recordEvent({ event })`                                               | One transaction: store the event (an `UNCHANGED` only when it changes what its installation runs), move the installation's head when the event is newer and not late (an update failure moves none), and update counters, gauges, and sketches. A repeated ID changes nothing, whichever installation sends it |
| `listEvents({ filter, sinceMs, beforeReceivedAtMs, after, limit })`    | Newest-first global, installation-movement, or bundle-outcome history                                                                                                                             |
| `findLatestEvents({ installId } or { userId, afterInstallId, limit })` | An installation's head, or a user's installations in install ID order                                                                                                                             |
| `countLatestEvents({ platform, channel, sinceMs, bundle })`            | Heads in the window: gauges for whole hours, heads for a partial first hour                                                                                                                       |
| `countEvents({ filter, sinceMs, beforeReceivedAtMs })`                 | Reports of one bundle outcome: hourly counters, raw events for partial hours at either edge                                                                                                       |
| `countEventSeries({ filter, timeRange, intervalMs })`                  | Reports of one bundle outcome in each interval of whole hours, over at most 90 days: the hourly counters `countEvents` reads, every interval present                                              |
| `getReleaseActivity({ releases })`                                     | Each release's downloads, launches (`applies`), and failed launches since its first report, from its lifetime counters                                                                                         |
| `getAppUsage(...)`                                                     | Active installations from sketches, per interval and in total; the latest-report distribution from gauges                                                                                         |
| `getUpdateFailures(...)`                                               | A release's or a channel's update failures from counters, failed installations from sketches, and over a time range the breakdown by stage, reason, and detail                                  |

The server sets each report's receipt time and metadata. The report ID is the
client's `eventId`, a UUIDv7, when it sends one, so a retried report counts
once; otherwise the server creates the ID. `POST /events` ignores fields it
does not know and answers `503` with `Retry-After: 5` while the database is
busy: a transaction out of retries (`DatabaseConflictError`) or a throttled
read. Core owns
movement semantics, scope/window selection, opaque cursors, and UI labels.

Sketches are HyperLogLog registers (1,024 per sketch), so unique counts are
estimates with a standard error of about 3%; the Console marks them with ≈.
The overview, App usage, and release health all end their periods with the
current UTC hour, so a report counts in each as soon as it is recorded.

## Product views

The Console provides:

- scoped reporting-installation counts over 24 hours, 7 days, or 30 days;
- selected-bundle reporting installations plus applied, recovered-from, and
  downloaded and unchanged report counts;
- outcome drill-down using exactly the same scope and receipt interval;
- all-event browsing and exact installation/current-user lookup;
- bundle movement history for a selected installation.

`getReportingOverview({ platform, channel, window, bundleId? })` returns one
scope measurement and, when a bundle is selected, five bundle measurements.
Each scalar has `count` and `measuredAtMs`. The response also includes `sinceMs`
and `beforeReceivedAtMs`, which bind outcome drill-down pages. The admin HTTP
route is `GET /overview` relative to the admin handler mount. The global event
method is `listEvents`; exact installation lookup takes `{ installId }`.

Recovery from B to A contributes a recovered-from report to B, while the latest
installation response names A. Selecting another Release for the same running
files is `UNCHANGED`, kept as a release adoption; it launches no bundle.

### What All Events records

All Events is the log of what changed for each installation, not the source
of every count. Each count names where it comes from:

| Count | Source |
| --- | --- |
| Downloads, launches, crashes of a release | Lifetime counters, written with each event |
| Events per bundle and interval (Release health) | Hourly outcome counters, written with each stored event |
| What an installation runs now, and when it last reported | Its head, kept 400 days after its last report |
| Active installations (DAU, WAU, MAU) | HyperLogLog sketches, about 3% error |
| Distribution by app version, Release, built-in bundle | Gauges over heads |

`recordEvent` stores every download, apply, recovery, and update failure. It
stores an `UNCHANGED` report only when it changes what its installation runs,
compared with the head's running state (a download head still runs `from_*`):
the installation's first report (`first_seen`), another bundle, another
Release, another app version or native build (`min_bundle_id`, when both name
one), or another channel. A user switch moves only the head. A report older
than the head changes nothing. `metadata.change` names what changed and the
head's values before it.

A launch (`isLaunch`) is an `UPDATE_APPLIED`, or a kept `UNCHANGED` that moved
the installation to another bundle under a non-null Release. One rule counts
it everywhere: the Release's lifetime `applies`, the `on:<bundle>` outcome key,
and the bundle filter `{ type: "UNCHANGED", toBundleId }`. The `on:` key is
new, so `UNCHANGED` rows that older servers kept for every launch count as
no launch. A first report, a Release change of the running bundle, and a move
under no Release are not launches.

A reload can deliver one runtime's report after the next runtime's. A download
or apply whose target the head already runs, a download that repeats the
head's pending one (same source and target), and an `UNCHANGED` the client made
(by its UUIDv7) before the head's report, even after a later report replaced
the apply it preceded, are late: a download or apply is stored with
`metadata.late` and moves and counts nothing; such an `UNCHANGED` keeps no row.
Report IDs are made on the device, so a device whose clock jumps back has its
launch reports judged late until its clock passes its latest report. A launch or crash whose head shows
neither the target's download nor the target running counts that download too,
with `metadata.implied_download`, unless the target is the native build's
built-in bundle. A launch or crash with no head implies nothing, since the
server knows nothing of that installation's past; an installation's first
report is almost always an `UNCHANGED` (`first_seen`), which creates its head.
So for installations with a head, a release's downloads cover their launches
and crashes: Downloaded ≥ Launched + Crashed. The difference is the downloads
not launched yet, waiting for a restart or passed over for a newer bundle.

A launch that changes nothing keeps no row: an event row and its outcome
counters for every daily launch would nearly double a launch's writes on
DynamoDB and D1, add billed TTL deletes on Firestore, and fill a 10 GB D1
database with 90 days of launches at around 140,000 daily active
installations. Heads, sketches, and gauges already count those launches.

Counts describe reports received by the server, not all devices or unique
update attempts. Offline devices and failed sends are absent. Independent live
counts do not establish an exact share, success rate, or deployment completion.
The UI displays them independently and does not clamp them into a ratio.

Event pages sort descending by `(received_at_ms, id)`, apply filters before a
limit of at most 101, and use an exclusive keyset cursor. Receipt intervals are
`[sinceMs, beforeReceivedAtMs)`. Native continuation pages must be exhausted
before returning a short result. As in other analytics products, the global
and bundle lists show raw events only inside a fixed range of at most 90 days,
a duration of 90 × 24 hours however many UTC days it touches: without
`sinceMs`, the 90 days before `beforeReceivedAtMs`; a longer range is a `400`.
The cursor carries that range and the page's last row, and only a full page
returns one, so pages run newest first and stop at the range start.
Installation history is one index range and has no such limit.

The global and bundle lists read one query per UTC day that holds a matching
event. Each event also increments a per-day counter: an `insights_outcomes`
row whose platform is `*` and whose bucket is a UTC day, not an hour. After a
day reads empty, one outcome read names the newest day below it that holds
events: that per-day row for the global list, the filter's own hourly outcome
rows for a bundle list. A gap of any length costs one empty day and one
outcome read, and dense days read nothing extra. Core does not aggregate raw
history. The Console keeps previous cursors in session memory; only the
current cursor and filter bounds appear in its URL.

Latest-state counts use provider-private current entries. SQL and MongoDB count
compact heads; Firestore uses native latest-document counts. DynamoDB traverses
stable installation IDs in the selected scope's compact count partition, so a
last-report update cannot move an already-counted installation past the cursor.
Its work includes current scope entries outside the selected window, but not
other scopes or retained event history. Returning one scalar does not imply
constant work or latency.

## Initial storage setup

Schema `1.0.0` includes atomic storage and every Insights access path from the
first initialization. Standalone SQL tooling initializes empty storage and
leaves an initialized `1.0.0` database unchanged. Generate ORM schema artifacts
before deployment. Prisma PostgreSQL/MySQL require the emitted companion
collation SQL. MongoDB requires version 5 or later on a replica set or sharded
cluster for its transactions and snapshot event counts. Insights append and
advancing its private event head run in one transaction.

Secondary indexes may lag. Exact installation reads use canonical state;
current-user queries validate index candidates against that state so an old
association is not returned. Newly assigned users can briefly have missing
results. Counts and pages become complete once writes and indexes converge;
a fixed receipt cutoff is not a commit watermark or a cross-request snapshot.

## SQL Server limitation

The Prisma SQL Server adapter retains its other models, but its five Insights
methods reject before database I/O. SQL Server's padded string equality can
merge IDs that differ by trailing spaces; its default Unicode/UUID ordering
also differs from this contract. There is no silent fallback to weaker identity
or pagination semantics. Use a supported Insights provider for these views.

## Download state

`UPDATE_DOWNLOADED` is emitted by the SDK after native staging succeeds, before
reload. Its `from_bundle_id` / `from_release_id` identify the running bundle;
`to_bundle_id` / `to_release_id` identify the downloaded selection. It requires
`from_bundle_id` and `metadata.update_strategy`, like an applied report. It is included
in installation movement history and can be selected with the `downloaded`
bundle outcome filter.

Core derives running and pending response fields from the latest event. For a
download, the running file is `from_bundle_id` and the pending selection is
`to_bundle_id` / `to_release_id`. Apply/recovery/no-change clear pending response
fields. The provider returns the original event; it does not calculate lifecycle
state or maintain shared pending columns.

There is no shared `bundle_installations` model. SQL adapters, D1, Supabase, and
MongoDB keep private `bundle_event_heads` with nine canonical access fields:
`install_id`, `id`, `received_at_ms`, `user_id`, `platform`, `channel`, `type`,
`from_bundle_id`, and `to_bundle_id`. Atomic writes choose the globally latest
receipt tuple. User, scope, and two bundle indexes filter heads; queries hydrate
at most 101 canonical events for a page and count heads directly. Metadata, app version, release IDs, and calculated
pending fields are not duplicated there.

DynamoDB and Firestore retain their native full latest-event copies for responses;
DynamoDB also maintains compact count items in the existing table. These are
private access paths, not additional public database models or author-facing
helpers. Event `cohort`, `update_strategy`,
`fingerprint_hash`, and `sdk_version` live in typed `metadata`, using the existing
Bundle JSON conventions. SDK request and Console response formats are unchanged.

The single unreleased 1.0.0 initialization defines the physical layout. This
optimization changes neither the canonical event schema nor the public database
specification.
