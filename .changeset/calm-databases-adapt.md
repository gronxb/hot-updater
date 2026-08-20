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
"@hot-updater/core": minor
"hot-updater": minor
---

Replace the legacy database plugin API with the fixed official-domain contract:

```ts
createDatabasePlugin({
  name,
  models: {
    bundles,
    bundlePatches,
    releases,
    releaseCatalogs,
    channels,
    analytics,
    clientAccessKeys,
  },
  commit,
  dispose,
});
```

Provider callback transactions, generic CRUD, factories, runtime contexts,
capability registries, `commitBatch`, and the former top-level model and query
members are no longer public. `commit({ changes })` is now a declarative,
ordered, atomic write boundary across every official model. Expected missing-row
and live-reference conflicts identify the original change index; failed commits
roll back all earlier changes. Providers without a suitable atomic primitive
reject a multi-change commit before its first write.

Add Channels as a normalized, persistent model with opaque `id` and exact,
case-sensitive `name`. Channel IDs and names are non-empty and limited to 255
Unicode code points. Releases reference `channel_id`; immutable Bundle rows do
not carry Channel or delivery-policy fields. Channel listing reads the Channel
model directly instead of scanning Bundles. Channels remain after their last
Release is removed and can be deleted explicitly only when no Release references
them.

Schema `1.0.0` creates Channel, Bundle, Bundle patch, Release, Release Catalog,
Analytics, and client-access-key storage on an empty database. It rejects v0
schema markers and does not backfill Bundle policy. Kysely, Drizzle, Prisma,
MongoDB, Cloudflare D1, PostgreSQL, Supabase, Firebase, DynamoDB, and Mock
implement the same logical contract.

Add mount-relative Channel admin routes: `GET /channels`, `POST /channels`, and
empty-only `DELETE /channels/:id`. With the recommended mount these are exposed
under `/hot-updater/admin/channels`. Remove the legacy
`/api/bundles/channels` route. Standalone remains a narrower remote
`BundleRepository`, while self-hosted `createHotUpdater` owns the full database
contract. The Console can create Channels and request safe deletion; a concurrent
Release reference is reported as `not_empty` without losing data.

Official providers implement the fixed access patterns used by the shared
client: exact domain filters, id ordering, bounded pagination, row counts,
patch lookup by owner IDs, exact Catalog reads, strongly consistent Release
scope reads, and atomic ordered changes across official models. Provider-owned
update selection and arbitrary distinct, projection, connector, and
string-comparison query DSL operations are no longer part of the public
database plugin contract. Cloudflare D1 rejects malformed count results instead
of returning zero.

The shared database client resolves the canonical Channel row before Release
writes and compiles affected Catalogs in the same atomic commit. The v0
`queries.getUpdateInfo` optimization and combined Bundle-policy writes are
removed. `@hot-updater/test-utils` publishes conformance coverage for all-model
commits, rollback, Channel persistence, canonical concurrent inserts, safe
deletion, and the absence of bundle-scan Channel reads.

Runtime-specific composition entrypoints keep the same provider names behind
explicit package subpaths. `@hot-updater/cloudflare/worker` accepts a native D1
binding through `d1Database(database)`, while `@hot-updater/supabase/edge`
exports the Edge-compatible `supabaseDatabase` and `supabaseStorage`. Root
entrypoints remain the configuration-time providers.

Self-hosted runtimes configure optional behavior through the top-level
`analytics` and `clientAccessKeys` booleans on `createHotUpdater`; both default
to `false`. `analytics` mounts Analytics ingestion and query routes backed by
`database.models.analytics`, while `clientAccessKeys` protects update checks
and Analytics ingestion through `database.models.clientAccessKeys`. Client
update routes are always available on `handlers.client`, while admin routes are
exposed only by explicitly mounting `handlers.admin`. The CLI-only
`standaloneRepository` stays a bundle repository; the physical database passed
to the self-hosted `createHotUpdater` instance owns the full official contract.
