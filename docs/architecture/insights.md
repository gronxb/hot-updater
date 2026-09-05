# Built-in Insights

Insights is a server domain backed by `database.models.insights`. The database
stores immutable reports and one latest report per installation; the server
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
| `record({ event, installation })`                                       | Atomically store the event and advance latest state; first event ID wins      |
| `listEvents({ filter, sinceMs, beforeReceivedAtMs, after, limit })`     | Indexed newest-first global, installation-movement, or bundle-outcome history |
| `findInstallations({ installId } or { userId, afterInstallId, limit })` | Exact latest-state lookup or current-user page                                |
| `countInstallations({ platform, channel, sinceMs, bundleId })`          | Count recent latest rows, optionally naming one bundle                        |
| `countEvents({ filter, sinceMs, beforeReceivedAtMs })`                  | Count accepted reports matching one raw bundle/type/scope filter              |

The [accepted contract](./insights-contract-proposal.md) specifies ordering,
atomicity, idempotency, visibility, pagination, and test requirements. Public
types and boundary validation come from `@hot-updater/plugin-core`. The internal
CRUD adapter is an implementation aid for bundled providers, not an additional
interface that custom providers must implement.

Core creates the report ID, receipt time, and full installation candidate. It
owns movement semantics, scope/window selection, opaque cursors, and UI labels.
Providers translate fixed predicates and persist data; they do not implement
summary objects, outcome classifications, percentages, top-N groups, or charts.

## Product views

The Console provides:

- scoped reporting-installation counts over 24 hours, 7 days, or 30 days;
- selected-bundle reporting installations plus applied, recovered-from, and
  adopted report counts;
- outcome drill-down using exactly the same scope and receipt interval;
- all-event browsing and exact installation/current-user lookup;
- bundle movement history for a selected installation.

`getReportingOverview({ platform, channel, window, bundleId? })` returns one
scope measurement and, when a bundle is selected, four bundle measurements.
Each scalar has `count` and `measuredAtMs`. The response also includes `sinceMs`
and `beforeReceivedAtMs`, which bind outcome drill-down pages. The admin HTTP
route is `GET /overview` relative to the admin handler mount. The global event
method is `listEvents`; exact installation lookup takes `{ installId }`.

Recovery from B to A contributes a recovered-from report to B, while the latest
installation row names A. Adoption of a Release with the same bundle contributes
an adoption report, not an application. `UNCHANGED` reports update latest state
but do not increment those outcome counters.

Counts describe reports received by the server, not all devices or unique
update attempts. Offline devices and failed sends are absent. Independent live
counts do not establish an exact share, success rate, or deployment completion.
The UI displays them independently and does not clamp them into a ratio.

Event pages sort descending by `(received_at_ms, id)`, apply filters before a
limit of at most 101, and use an exclusive keyset cursor. Receipt intervals are
`[sinceMs, beforeReceivedAtMs)`. Native continuation pages must be exhausted
before returning a short result. There is no 50,000-event cap or raw-history
aggregation in core. The bundled SQL/Firestore adapter reads the two movement
types through separate ordered ranges: two queries on the first page and at
most four for a cursor page, then merges at most twice the requested limit.
Native provider page caps can require continuation within each bounded range.
The Console keeps previous cursors in session memory;
only the current cursor and filter bounds appear in its URL.

Latest-state counts never read event history. DynamoDB traverses canonical
installation IDs so an installation cannot be counted twice when its last-report
time advances. Its cost grows with stored installation rows, including rows
outside the selected window. Other providers use native aggregate queries;
returning one scalar does not imply constant work or latency.

## Storage upgrades

The new contract requires atomic native storage and bundle-outcome access paths.
Preserve existing data and stop older writers while applying an upgrade.

- PostgreSQL, Supabase, and D1 add version 1.0.1 migrations for indexes and the
  relevant native writer. Supabase installs the service-role record RPC.
- Standalone SQL tooling upgrades 1.0.0 to 1.0.1 without resetting reports.
  Regenerate ORM schema artifacts. Prisma PostgreSQL/MySQL require the emitted
  companion collation SQL because Prisma's schema DSL cannot express it.
- DynamoDB reuses its existing index and backfills outcome keys plus event-ID
  markers. Managed preparation runs the migration; standalone operators call
  `migrateDynamoDBInsights(config)`. See [AWS Insights](../../plugins/aws/INSIGHTS.md).
- Firebase upgrades the schema marker to 5 and copies latest rows to canonical
  encoded installation document IDs via `migrateFirebaseInsights(config)`.
  Existing rows remain intact; populated older deployments fail readiness with
  migration instructions instead of starting a history copy in a request.
- MongoDB records through a native transaction even when optional generic
  transactions are disabled. MongoDB 5 or later on a replica set or sharded cluster is required; counts
  use snapshot read concern to avoid duplicate traversal of mutable index keys.

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
