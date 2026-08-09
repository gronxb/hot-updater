# Analytics plugin boundary

Analytics is an optional first-party server plugin built on the generic server
kernel. It owns its event model, persistence contract, routes, provider
capability, and schema lifecycle. Core database models remain limited to
`bundles` and `bundle_patches`.

## Runtime contract

`AnalyticsPersistence` is the provider boundary. It supports appending one
complete event and scanning events in ascending `(received_at_ms, id)` order.
The scan cursor is exclusive, the upper timestamp bound is strict, and the
returned row count cannot exceed the requested limit.

The shared bounded `AnalyticsProvider` implements reporting over this ordered
scan and rejects reports that would materialize more than 50,000 matching rows.
A dedicated provider may implement the same high-level contract directly.

Providers make the high-level provider available through the Analytics-owned
capability. `analytics()` may also receive an explicit provider. It never
constructs a provider from the Core database runtime.

The plugin contributes these routes:

| Method | Path                                   | Default access |
| ------ | -------------------------------------- | -------------- |
| `POST` | `/events`                              | public         |
| `GET`  | `/api/bundles/:id/events/summary`      | protected      |
| `GET`  | `/api/bundles/:id/events/analytics`    | protected      |
| `GET`  | `/api/installations/overview`          | protected      |
| `GET`  | `/api/installations/active`            | protected      |
| `GET`  | `/api/installations`                   | protected      |
| `GET`  | `/api/installations/:installId/events` | protected      |

Query access may be made public explicitly. Analytics does not install or
select an authentication provider.

Public event ingestion is a deployment trust boundary. Internet-facing
deployments must enforce distributed ingress and storage quotas outside this
plugin. The bounded provider deliberately rejects reports above 50,000 rows
and does not implement replay deduplication or retention; move sustained
high-volume workloads to a dedicated provider.

## Schema ownership

Analytics readiness is recorded independently as `schema.analytics = "2"`.
It never changes `schema.core` or the legacy global `version` setting.

- Analytics schema 1 is the transition-only `bundle_events` shape introduced
  with legacy global schema `0.37.0`.
- Analytics schema 2 is the `0.38.0` shape that adds `UNCHANGED` and permits
  null transition fields only for that event type.
- Legacy global versions are immutable evidence. They may help classify a
  known physical shape, but Analytics never rewrites or downgrades them.

Provider migration and adoption are explicit administrative operations, not
plugin setup side effects. Each provider validates its physical table,
collection, indexes, constraints, marker, and persisted rows before mutation.
Unknown shapes, malformed markers, and future versions fail closed.

| Marker and physical state               | Result                                           |
| --------------------------------------- | ------------------------------------------------ |
| absent and storage absent               | create schema 2, validate, then write marker     |
| absent or 1 with exact schema 1         | migrate to schema 2, validate, then write marker |
| absent or 1 with exact schema 2         | recover or adopt, then write marker              |
| 2 with exact schema 2                   | no-op                                            |
| marker/shape contradiction              | reject without changing marker or data           |
| drift, corrupt marker, or future marker | reject without mutation                          |

The marker is the final operation. Transactional providers include physical
changes, validation, and the marker in one transaction. Non-transactional
providers use resumable, idempotent phases and expose the marker only after the
data and required indexes are ready.

Runtime adapters cache one successful provider-specific readiness inspection,
then reread the component marker before every operation. A non-v2 marker
invalidates the cached inspection. Migration and adoption remain responsible
for complete persisted-row validation before publishing the marker; the
Supabase runtime uses that SQL migration as its validation authority. Operators
must change the marker before privileged schema mutation because continuously
rescanning every row while an unchanged v2 marker remains present would make
public ingestion grow linearly with stored events.

## Provider entry points

Provider migration is always an administrator action. Constructing the server
or handling a request never performs it.

| Provider             | Administrative entry point                                 | Runtime connection                                                                                 |
| -------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Cloudflare D1 REST   | `migrateD1Analytics(config)`                               | `d1Database(config)` attaches the capability                                                       |
| Cloudflare Worker D1 | `migrateAnalytics()` from `@hot-updater/cloudflare/worker` | `d1Database()` attaches the capability                                                             |
| Firebase             | `migrateFirebaseAnalytics(firestore)`                      | `firebaseDatabase(config)` attaches the capability                                                 |
| PostgreSQL           | execute `@hot-updater/postgres/sql/analytics.sql`          | `postgres(config)` attaches the capability                                                         |
| Supabase             | apply `20260805000000_hot-updater_analytics_2.sql`         | `supabaseDatabase(config)` attaches the capability                                                 |
| Kysely SQL           | `migrateKyselyAnalyticsSchema(config)`                     | pass `createBoundedAnalyticsProvider(createKyselyAnalyticsPersistence(config))` to `analytics()`   |
| MongoDB              | `migrateMongoAnalyticsSchema(config)`                      | pass `createBoundedAnalyticsProvider(createMongoAnalyticsPersistence(config))` to `analytics()`    |
| Blob storage         | `migrateLegacyAnalyticsBlob(operations)`                   | pass `createBoundedAnalyticsProvider(createBlobAnalyticsPersistence(operations))` to `analytics()` |

The Kysely and MongoDB adapters are public subpaths of
`@hot-updater/analytics`. Blob primitives are exported from
`@hot-updater/analytics/provider`. They require explicit provider composition;
they are not inferred from a Core database or storage plugin.

The Kysely adapter supports PostgreSQL, MySQL, and SQLite. CockroachDB and
MSSQL are not declared compatible without provider-specific catalog validation
and runtime coverage.

The PostgreSQL and Supabase migrations accept only the exact historical
`double precision` event timestamp shape. Supabase additionally requires row
level security on an adopted legacy table and preserves existing policies.
Generic PostgreSQL does not enable or own row level security.

## Rollout

1. Configure ingress and storage quotas for the public event route.
2. Deploy the provider-specific Analytics migration or adoption operation.
3. Verify `schema.analytics = "2"`, event row preservation, required indexes,
   and unchanged Core and legacy markers.
4. Run the operation again and verify it is a no-op.
5. Add `analytics()` to server composition and configure authentication for
   protected queries when needed.
6. Enable client ingestion only after the provider is ready.

The Cloudflare, Firebase, and Supabase managed deployment workflows perform
the provider migration before deploying a runtime that directly composes
`managedBetterAuthPlugin()` and `analytics()`. They provision the raw API key
only in the local `.env.hotupdater` file and place only its SHA-256 projection
in the runtime. OTA selectors and `POST /events` remain public; the six query
routes require the managed key.

Removing the plugin stops exposing Analytics routes. It does not drop event
data or remove the Analytics marker.

## Excluded concerns

This boundary does not add Analytics models to Database V2, modify the generic
kernel, change the Console or React Native SDK, enable AWS Analytics, or add
retention and deletion behavior.
