# Built-in Insights

Insights is a first-party server domain backed by the official
`database.models.insights` port. It is part of every database plugin rather
than a separate provider or optional capability.

```ts
createHotUpdater({
  database,
  clientAccess: { type: "api-key" },
});
```

`createHotUpdater` mounts event ingestion on `handlers.client` and Insights
queries on `handlers.admin`. React Native clients send automatic lifecycle
reports by default and can opt out with `HotUpdater.init({ insights: false })`.
API keys authenticate event ingestion, Release Catalog, and artifact requests,
but they do not grant access to Insights queries.

The admin handler does not authenticate itself. Mount it only behind framework
authentication, or use the database-backed Insights model from an authenticated
server surface, as the Console does. `clientAccess` remains the explicit policy
for the public client handler.

The database plugin owns raw event storage, provider-native indexes, and durable
projections. The shared server owns input and response validation, HTTP mapping,
and read-state handling. Every official provider implements the same public
contract:

```ts
models: {
  insights: {
    append(row): Promise<void>;
    pageEvents(input): Promise<InsightsPageEventsResult>;
    pageInstallations(input): Promise<InsightsInstallationPage>;
    getReport(input): Promise<InsightsReportResult>;
    pageReport(input): Promise<InsightsReportPage>;
  },
}
```

Reads use opaque, query-bound cursors and provider-native seek pagination.
Event and installation pages return at most 100 rows and at most 1 MiB. Report
sections are paged separately. These are per-request bounds rather than a
retention or total-record limit, so an installation with more than 50,000 MAU
or events remains queryable without loading the whole history into memory.

Published projections expose preparing, ready, stale, expired, and failed
states explicitly. Cursors pin the publication and query identity so a refresh
cannot mix generations within one traversal. Raw events remain the source of
truth; invalid source data does not advance a projection checkpoint.

Official providers own a fixed internal storage identity, so existing database
configuration does not need an Insights-specific setting. Custom database
plugins must provide a stable storage identity to fence cursors and projections.
