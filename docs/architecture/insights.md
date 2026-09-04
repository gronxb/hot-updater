# Built-in Insights

Insights is a first-party server domain backed by the official
`database.models.insights` port. It is not a server plugin and does not declare its
own provider, schema lifecycle, or universal component adapter.

```ts
createHotUpdater({
  database,
  clientAccess: { type: "api-key" },
});
```

`createHotUpdater` always mounts event ingestion on `handlers.client` and
Insights queries on `handlers.admin`. React Native clients send automatic
lifecycle reports by default and can opt out with
`HotUpdater.init({ insights: false })`.
API keys authenticate event ingestion, Release Catalog, and artifact
requests, but they do not grant Insights query access.

The admin handler does not authenticate itself. Mount it only behind framework
authentication, or use the database-backed Insights provider directly from an
authenticated server surface, as the Console does.

`clientAccess` is a required, explicit authentication policy.
Client update and Insights ingestion routes are always present on
`handlers.client`, while mounting `handlers.admin` is the explicit opt-in for
admin HTTP routes.

The database plugin stores the immutable event log and a compact row containing
the latest report for each installation. The server owns input validation,
cursor encoding, page boundaries, and HTTP responses. Every database provider
therefore exposes the same small persistence contract:

```ts
models: {
  insights: {
    append(row): Promise<void>;
    pageEvents({ selector, beforeReceivedAtMs, after, limit }): Promise<readonly BundleEventRow[]>;
    getInstallation(installId): Promise<InsightsInstallationRow | null>;
    pageInstallationsByCurrentUserId({ userId, afterInstallId, limit }): Promise<readonly InsightsInstallationRow[]>;
    countActiveInstallations({ sinceMs }): Promise<number>;
  },
}
```

Event pages are ordered newest first by `(received_at_ms, id)`. The server asks
for at most 101 rows at a time and returns an opaque keyset cursor, so browsing
does not scan or materialize the preceding history. Installation history applies
its movement filter in the database before the page limit.

The Console keeps only the current cursor and fixed cutoff in the URL. Previous
cursors live in route memory for the current browsing session, so moving through
deep history does not make the URL grow with the number of pages.

The latest-installation row is updated only when `(received_at_ms, id)` advances.
It makes exact installation lookup, exact current user ID lookup, and active
installation counts independent of the size of the raw event log. Generic
adapters use a bounded best-effort event-plus-projection update; providers may
make that write atomic when their native data model supports it without an
unbounded read. A projection failure fails the request, and a subsequent
successful report advances the row. There is no report job, checkpoint,
publication, repair lifecycle, or 50,000-row application limit.

The active count is a live measurement, not a cross-provider snapshot. It is
exact once writes are quiescent; concurrent reports can affect a multi-page
provider query while it is running.

The Console intentionally presents only data with a clear operational use:

- reporting installations over 24 hours, 7 days, or 30 days;
- the filter-free event history;
- exact installation or current user ID lookup;
- bundle movement history for a selected installation.

Bundle adoption charts, historical alias search, exact page totals, and
historical time-series aggregation are outside the built-in Insights scope. They
require different semantics or analytics infrastructure and are not inferred
from partial event data.
