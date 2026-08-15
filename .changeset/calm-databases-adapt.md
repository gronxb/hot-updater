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
    channels,
    analytics,
    clientAccessKeys,
  },
  queries: { getUpdateInfo },
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
Unicode code points. Bundle rows retain `channel` for compatibility and add the
required `channel_id`; new writes validate both values against the same Channel.
Channel listing reads the Channel model directly instead of scanning or applying
`DISTINCT` to bundles. Channels remain after their last bundle is removed and
can be deleted explicitly only when no bundle references them.

Core schema `0.38.0` creates Channel storage, backfills one Channel for each
legacy bundle channel, fills `bundles.channel_id`, validates the dual values,
and applies the non-null, uniqueness, and reference constraints before recording
the new version. Kysely, Drizzle, Prisma, MongoDB, Cloudflare D1, PostgreSQL,
Supabase, Firebase, and Mock implement the same logical contract and migration
semantics.

Add canonical Channel management routes: `GET /api/channels`,
`POST /api/channels`, and empty-only `DELETE /api/channels/:id`. Remove the
legacy `/api/bundles/channels` route. Standalone remains a narrower remote
`BundleRepository`, while self-hosted `createHotUpdater` owns the full database
contract. The Console can create Channels and request safe deletion; a concurrent
bundle reference is reported as `not_empty` without losing data.

The shared database client resolves the canonical Channel row before bundle
writes, keeps `channel` and `channel_id` synchronized on moves, and uses the
optional `queries.getUpdateInfo` optimization without exposing provider query
languages. `@hot-updater/test-utils` now publishes conformance coverage for
all-model commits, rollback, Channel persistence, canonical concurrent inserts,
safe deletion, and the absence of bundle-scan channel reads.
