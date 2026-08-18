# Built-in Analytics

Analytics is a first-party server domain backed by the official
`database.models.analytics` port. It is not a server plugin and does not declare its
own provider, schema lifecycle, or universal component adapter.

```ts
createHotUpdater({
  database,
  features: {
    analytics: {
      queryAccess: "protected",
    },
  },
});
```

When `features.analytics` is enabled, `createHotUpdater` mounts the event
ingestion route and the Analytics query routes. `queryAccess` defaults to
`"protected"`; in this mode every HTTP query route returns `401` by design.
Client access keys authenticate event ingestion, Release Catalog, and artifact
requests, but they do not grant Analytics query access.

To read Analytics without making the built-in query routes public, use the
database-backed Analytics provider directly from an authenticated server
surface, as the Console does, or expose your own authenticated API. Set
`queryAccess: "public"` only for an intentionally public deployment or a local
test fixture.

`features.updateCheck`, `features.bundles`, `features.analytics`, and
`features.clientAccessKeys` are configured through the same feature boundary.
Analytics owns its event and query routes and is enabled only by
`features.analytics`.

The database plugin owns physical storage and migration for `bundle_events`.
The server owns event input validation, bounded scans, aggregation, installation
search, and HTTP responses. Every database provider therefore exposes the same
logical persistence contract:

```ts
models: {
  analytics: {
    append(row): Promise<void>;
    scan({ beforeReceivedAtMs, after, limit }): Promise<readonly BundleEventRow[]>;
  },
}
```

Scans are ordered by `(received_at_ms, id)` and are capped at 50,000 matching
rows to keep built-in aggregation bounded. The Console constructs this provider
server-side from the database model; it does not rely on the protected HTTP
query routes or bind a separate Analytics package.
