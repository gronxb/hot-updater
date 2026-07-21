---
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"@hot-updater/test-utils": minor
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/mock": minor
"@hot-updater/postgres": minor
"@hot-updater/standalone": minor
"@hot-updater/supabase": minor
"@hot-updater/cli-tools": minor
"@hot-updater/console": minor
"@hot-updater/react-native": minor
"hot-updater": minor
---

Replace the legacy database plugin API with the fixed-model plugin API for
`bundles`, `bundle_patches`, and `bundle_events`. Database providers now return
a direct plugin object, aggregate bundle behavior is provided by the shared
database client, callback transactions and optimized update checks are optional
capabilities, and the v1 staged mutation API has been removed. Provider
functions now receive their configuration directly and close over it inside
`createDatabasePlugin({ name, plugin })`.

Database plugin operations no longer receive request context. Providers close
over their configured database client or binding, while request context remains
available to server handlers and storage plugins for request-scoped URL and
authorization behavior.

Keep channel names directly on `bundles.channel` without introducing a channel
model, table, collection, or foreign key. Plugins may expose an optimized
`getChannels` aggregate, while the shared database client falls back to paging
bundle channel values and returning their sorted distinct set.

Publish `@hot-updater/test-utils` with reusable low-plugin and aggregate-client
conformance suites for custom database plugin authors.

Expose app-ready Analytics for record plugins and proxy event ingestion,
active-installation overview, bundle outcomes, installation search, and
installation history through the standalone repository. React Native reports
unchanged launches as well as applied/recovered transitions through the
existing best-effort `notifyAppReady` boundary. The Console aggregates active
installations by install ID, supports exact user-ID alias filtering, and keeps
received-report activity, transition outcomes, and configured rollout
semantically separate.

The shared CRUD aggregation is cutoff-bounded and deduplicated across stable
pages, with eventual consistency for pre-cutoff rows committed during a scan.

Client event ingestion is closed by default and is mounted only when
`createHotUpdater({ eventIngestion: { authorize } })` supplies an explicit
authorization and throttling policy. Event payloads remain untrusted telemetry;
deployments are responsible for user-scoped authentication or attestation,
quotas, logging, and retention.

Snapshot-backed plugins created with `createBlobDatabasePlugin`, including
`s3Database`, deliberately leave Analytics disabled because concurrent event
writes can conflict. The Console hides Analytics based only on capability
presence, without provider-name branching.

The Analytics addition requires no changes to existing consumer configuration
or call sites. In particular, `standaloneRepository` has no public
`supportsAnalytics` option; it discovers the remote database capability through
the server's version response.
