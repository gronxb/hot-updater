# Built-in Insights

Insights is a server domain backed by `database.models.insights`. The database
stores immutable reports and queries the latest event per installation; the server
assembles operational views and selected-bundle deployment evidence.

```ts
createHotUpdater({
  database,
  clientAccess: { type: "api-key" },
});
```

`createHotUpdater` mounts ingestion on `handlers.client` and queries on
`handlers.admin`. The admin handler does not authenticate itself: mount it
behind framework authentication, or call the Insights provider from an
authenticated server surface, as the Console does. API keys authorize client
requests and ingestion, not admin queries. React Native sends lifecycle reports
by default; `HotUpdater.init({ insights: false })` opts out.

## Provider responsibility

Custom database authors implement five operations, all with object inputs:

| Method                                                                  | Responsibility                                                                |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `recordEvent({ event })`                                       | Store one immutable event; any private latest copy advances atomically      |
| `listEvents({ filter, sinceMs, beforeReceivedAtMs, after, limit })`     | Indexed newest-first global, installation-movement, or bundle-outcome history |
| `findLatestEvents({ installId } or { userId, afterInstallId, limit })` | Exact latest-state lookup or current-user page                                |
| `countLatestEvents({ platform, channel, sinceMs, bundle })`          | Count recent latest rows, optionally naming one bundle                        |
| `countEvents({ filter, sinceMs, beforeReceivedAtMs })`                  | Count accepted reports matching one raw bundle/type/scope filter              |

The [custom database guide](../content/docs/%28latest%29/database-plugins/custom-database.mdx#insights)
specifies ordering, atomicity, idempotency, visibility, pagination, and test
requirements. Public types and boundary validation come from
`@hot-updater/plugin-core`. The internal CRUD adapter is an implementation aid
for bundled providers, not an additional interface that custom providers must
implement.

Core creates the report ID, receipt time, metadata, and explicit query predicates. It
owns movement semantics, scope/window selection, opaque cursors, and UI labels.
Providers translate fixed predicates and persist data; they do not implement
summary objects, outcome classifications, percentages, top-N groups, or charts.

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
files is `UNCHANGED`; it does not count as applying a bundle.

Counts describe reports received by the server, not all devices or unique
update attempts. Offline devices and failed sends are absent. Independent live
counts do not establish an exact share, success rate, or deployment completion.
The UI displays them independently and does not clamp them into a ratio.

Event pages sort descending by `(received_at_ms, id)`, apply filters before a
limit of at most 101, and use an exclusive keyset cursor. Receipt intervals are
`[sinceMs, beforeReceivedAtMs)`. Native continuation pages must be exhausted
before returning a short result. Core does not aggregate raw history. The
Console keeps previous cursors in session memory; only the current cursor and
filter bounds appear in its URL.

Latest-state counts use native event queries or provider-private copies. DynamoDB traverses canonical
installation IDs so an installation cannot be counted twice when its last-report
time advances. Its cost grows with stored installation rows, including rows
outside the selected window. Other providers use native aggregate queries;
returning one scalar does not imply constant work or latency.

## Initial storage setup

Schema `1.0.0` includes atomic storage and every Insights access path from the
first initialization. Standalone SQL tooling initializes empty storage and
leaves an initialized `1.0.0` database unchanged. Generate ORM schema artifacts
before deployment. Prisma PostgreSQL/MySQL require the emitted companion
collation SQL. MongoDB requires version 5 or later on a replica set or sharded
cluster for its catalog transactions and snapshot event counts. Insights append is a single document write.

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

There is no shared `bundle_installations` model. SQL adapters query indexed events;
Supabase exposes a non-materialized latest-event view. MongoDB groups events.
DynamoDB and Firestore retain private atomic latest-event copies for native user
lookup and counting. Event `username`, `cohort`, `update_strategy`,
`fingerprint_hash`, and `sdk_version` live in typed `metadata`, using the existing
Bundle JSON conventions. SDK request and Console response formats are unchanged.

The unreleased 1.0.0 initialization migration contains the new layout. Already
initialized RC stores require an explicit offline export/replay, not rerunning
that migration. See the [storage decision and replay procedure](./insights-event-storage-decision.md).
