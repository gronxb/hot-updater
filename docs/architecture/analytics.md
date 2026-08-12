# Built-in Analytics

Analytics is a first-party server domain backed by the official
`database.analytics` port. It is not a server plugin and does not declare its
own provider, schema lifecycle, or universal component adapter.

```ts
createHotUpdater({
  database,
  features: {
    analytics: true,
  },
});
```

When `features.analytics` is enabled, `createHotUpdater` mounts the public
event ingestion route and the Analytics query routes. Queries are protected by
default and fail closed. `features.analytics: { queryAccess: "public" }` is
intended only for explicitly public deployments and local test fixtures.

`features.updateCheck` and `features.bundles` control the two core route groups;
Analytics owns its event and query routes and is enabled only by
`features.analytics`.

The database plugin owns physical storage and migration for `bundle_events`.
The server owns event input validation, bounded scans, aggregation, installation
search, and HTTP responses. Every database provider therefore exposes the same
logical persistence contract:

```ts
analytics: {
  append(row): Promise<void>;
  scan({ beforeReceivedAtMs, after, limit }): Promise<readonly BundleEventRow[]>;
}
```

Scans are ordered by `(received_at_ms, id)` and are capped at 50,000 matching
rows to keep built-in aggregation bounded. The Console reads the same server
domain and no longer binds a separate Analytics package or provider.
