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

Replace the legacy database adapter API with the fixed-model adapter API for
`bundles`, `bundle_patches`, and `channels`. Database providers now return a
direct adapter object, aggregate bundle behavior is provided by the shared
database client, callback transactions and optimized update checks are
optional capabilities, and the v1 staged mutation API has been removed.
Provider functions now receive their configuration directly and close over it
inside `createDatabaseAdapter({ name, adapter })`.

Normalize physical channel storage as `bundle_channels { id, name }` with
unique names and `bundles.channel_id -> bundle_channels.id`, while preserving
the logical adapter model name `channels` and double-writing the channel name to
the legacy `bundles.channel` field for backwards-compatible readers and
preserving channel names in the public bundle and standalone HTTP APIs.

Publish `@hot-updater/test-utils` with reusable low-adapter and aggregate-client
conformance suites for custom database adapter authors.

Expose app-ready Analytics for record adapters and proxy event ingestion,
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

Snapshot-backed adapters created with `createBlobDatabaseAdapter`, including
`s3Database`, deliberately leave Analytics disabled because concurrent event
writes can conflict. The Console hides Analytics based only on capability
presence, without provider-name branching.
