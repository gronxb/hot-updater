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

The database plugin owns physical storage and migration for `bundle_events`.
The server owns event input validation, bounded scans, aggregation, installation
search, and HTTP responses. Every database provider therefore exposes the same
logical persistence contract:

```ts
models: {
  insights: {
    append(row): Promise<void>;
    scan({ beforeReceivedAtMs, after, limit }): Promise<readonly BundleEventRow[]>;
  },
}
```

Scans are ordered by `(received_at_ms, id)` and are capped at 50,000 matching
rows to keep built-in aggregation bounded. The Console reads the same server
domain and no longer binds a separate Insights package or provider.
