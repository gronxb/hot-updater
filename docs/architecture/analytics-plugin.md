# Analytics plugin boundary

Analytics is an optional first-party server plugin built on the generic server
kernel and universal component data contract. Analytics owns its event domain,
universal schema and adoption policy, persistence translation, reporting, and
routes. Core database models remain limited to `bundles` and
`bundle_patches`.

Database providers do not implement an Analytics capability. They expose a
feature-neutral universal component data adapter that can bind any declared
component schema.

## Runtime contract

`analytics()` declares `analyticsComponentSchema` and, during server
composition, receives the `UniversalComponentDataSource` bound to that exact
schema. Analytics translates the generic source into its own
`AnalyticsPersistence` contract:

- append one complete event row to `bundle_events`; and
- scan rows in ascending `(received_at_ms, id)` order, with an exclusive
  cursor, a strict upper timestamp bound, and at most the requested limit.

The shared bounded `AnalyticsProvider` implements reporting over that ordered
scan and rejects reports that would materialize more than 50,000 matching
rows. Analytics also translates universal component readiness failures into
Analytics readiness errors without hiding operational backend failures.

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

## Analytics-owned schema and policy

`analyticsComponentSchema` is the canonical source for the Analytics physical
contract. It declares:

- component id `analytics` and marker `schema.analytics`;
- versioned `bundle_events` columns, checks, and indexes;
- the `bundle_events_by_received_at` ordered access pattern used by
  `AnalyticsPersistence`;
- adjacent version transitions; and
- the allowed interpretation of an unmarked legacy installation.

Analytics schema 1 is the transition-only event shape introduced with legacy
global schema `0.37.0`. Analytics schema 2 is the latest shape: it adds
`UNCHANGED` and permits `from_bundle_id` and `update_strategy` to be null only
for that event type.

The schema's unmarked policy uses the legacy global `version` value only as a
discriminator. A provider-neutral adapter may create, adopt, or migrate a
physical shape only when both the inspected shape and that declared policy
permit it. Unknown legacy values, unknown physical versions, marker/shape
contradictions, malformed rows, drift, and future component markers fail
closed. Analytics never rewrites or downgrades `schema.core` or the legacy
global `version` setting.

Migration validates the declared physical shape and stored rows, applies only
declared adjacent transitions, and writes `schema.analytics = "2"` last.
Transactional adapters include those operations in one transaction where the
backend permits it. Other adapters use provider-appropriate idempotent phases
without publishing the marker early.

At runtime, a source rejects append and ordered scan operations until the
latest marker, physical schema, required indexes, and stored data are ready.
An adapter may cache a successful full inspection, but it must continue to
detect marker invalidation. Constructing `analytics()` and binding its source
never create or migrate physical state.

## Provider-neutral adapter boundary

Each supported database attaches the same
`UniversalComponentDataAdapter` capability. The adapter receives a component
schema as data; its implementation must not import Analytics types, name
`bundle_events` directly, or define an Analytics-specific migration entry
point.

The contract separates three operations:

- `bind(schema)` synchronously returns a runtime source and has no physical
  side effects;
- `migrate(schema)`, when supported, performs explicit administrative
  migration and readiness validation; and
- `artifacts(schema)`, when supported, generates provider deployment
  artifacts for the declared target version.

The current provider compatibility layers are:

| Database adapter | Runtime source | Runtime migration | Generated artifact |
| ---------------- | -------------- | ----------------- | ------------------ |
| Cloudflare D1    | yes            | yes               | D1 SQL             |
| DynamoDB         | yes            | yes               | no                 |
| Firebase         | yes            | yes               | Firestore indexes  |
| PostgreSQL       | yes            | yes               | PostgreSQL SQL     |
| Supabase         | yes            | no                | Supabase SQL       |

Generated SQL and index fragments may contain Analytics table and marker names
because they are derived from `analyticsComponentSchema`. Their generators are
generic provider code and work from any valid component schema. There are no
checked-in provider-owned Analytics SQL migrations, Analytics persistence
implementations, or Analytics capability attachments.

The server collects component schemas deterministically before plugin setup,
rejects duplicate component ids and physical table or index names, resolves
one neutral adapter from the database carrier, and binds each plugin only to
the schema it declared. Declaring Analytics without a compatible component
adapter is a construction error. The Core database CRUD contract is not
extended with `bundle_events`.

## Explicit custom provider escape hatch

`analytics({ provider })` is the deliberate escape hatch for a dedicated or
custom Analytics backend. In this mode Analytics validates and uses the
high-level `AnalyticsProvider` directly. It does not declare
`analyticsComponentSchema`, require a universal component adapter, or produce
component migration artifacts.

The explicit provider therefore owns its storage readiness, migration, and
operational policy. `createBoundedAnalyticsProvider()` can build that provider
from an `AnalyticsPersistence`; the Analytics package also retains explicit
Kysely, MongoDB, and blob persistence helpers for this use case. These helpers
are not inferred from the Core database or a storage plugin.

## Composition-root ownership

Installing Analytics is a composition decision, not a database-provider
default. A runtime composition root opts in with the equivalent of:

```ts
createHotUpdater({
  database,
  plugins: [analytics()],
});
```

That same composed target exposes the schemas and neutral adapter needed by
administrative tooling. The composition root must choose one of the supported
deployment paths before enabling traffic:

- call `migrateUniversalComponents(hotUpdater)` for an adapter with runtime
  migration support; or
- call `generateUniversalComponentArtifacts(hotUpdater)` and deploy the
  generated artifacts through the provider's normal schema/index workflow.

`hot-updater generate` materializes generated component artifacts alongside
the Core database output. Provider init flows may use the same composed target
to merge Firestore index fragments, add SQL migrations, or run a supported
runtime migration before deploying the application runtime. The init or
deployment composition root decides whether Analytics is present; the neutral
database adapter does not.

Managed authentication, route policy, and provider presets belong to later
integration layers. Those layers may compose `analytics()` and arrange its
administrative migration, but they do not move Analytics schema or persistence
logic into database implementations.

## Rollout

1. Add `analytics()` to the intended deployment composition and configure
   authentication for protected queries.
2. Generate or run the universal component migration from that same composed
   target.
3. Verify `schema.analytics = "2"`, event row preservation, required indexes,
   and unchanged Core and legacy markers.
4. Run the administrative operation again and verify it is a no-op or produces
   identical artifacts.
5. Configure ingress and storage quotas for the public event route.
6. Deploy the composed runtime, then enable client ingestion.

The AWS, Cloudflare, Firebase, and Supabase managed deployment workflows use
the shared managed plugin preset for both their deployment target and runtime.
The deployment target produces provider-neutral component artifacts or
migrations before the runtime is deployed. The workflows provision the raw API
key only in the local `.env.hotupdater` file and persist only its SHA-256
the Better Auth-owned universal component. Database providers do not know that
schema or lifecycle. The runtime never receives the raw key.
The managed client key authorizes OTA selectors and `POST /events`; Analytics
query routes remain unavailable to that client role.

Removing the plugin stops declaring its schema and exposing Analytics routes.
It does not drop event data or remove the Analytics marker.

## Excluded concerns

This boundary does not add Analytics models to Database V2, make database
providers depend on the Analytics contract, make plugin setup migrate storage,
or add retention, deletion, and data-drop behavior.
