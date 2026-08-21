# @hot-updater/test-utils

## 1.0.0-rc.0

### Minor Changes

- b424d47: Replace the legacy database plugin API with the fixed official-domain contract:

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

  Official providers implement the fixed bundle access patterns used by the
  shared client: exact domain filters, id ordering, bounded pagination, row
  counts, patch lookup by owner ids, and atomic ordered changes across official
  models. Arbitrary
  distinct, projection, connector, and string-comparison query DSL operations are
  no longer part of the public database plugin contract. Cloudflare D1 rejects
  malformed count results instead of returning zero.

  The shared database client resolves the canonical Channel row before bundle
  writes, keeps `channel` and `channel_id` synchronized on moves, and uses the
  optional `queries.getUpdateInfo` optimization without exposing provider query
  languages. `@hot-updater/test-utils` now publishes conformance coverage for
  all-model commits, rollback, Channel persistence, canonical concurrent inserts,
  safe deletion, and the absence of bundle-scan channel reads.

  Runtime-specific composition entrypoints keep the same provider names behind
  explicit package subpaths. `@hot-updater/cloudflare/worker` accepts a native D1
  binding through `d1Database(database)`, while `@hot-updater/supabase/edge`
  exports the Edge-compatible `supabaseDatabase` and `supabaseStorage`. Root
  entrypoints remain the configuration-time providers.

  Self-hosted runtimes configure all route groups and optional behavior through
  `createHotUpdater({ features })`. `features.analytics` mounts Analytics
  ingestion and query routes backed by `database.models.analytics`, while
  `features.clientAccessKeys` protects update checks and Analytics ingestion
  through `database.models.clientAccessKeys`. `features.updateCheck` and
  `features.bundles` control the core route groups in the same object. The
  CLI-only `standaloneRepository` stays a bundle repository; the physical
  database passed to the self-hosted `createHotUpdater` instance owns the full
  official contract.

- 5a2e1cd: Separate immutable Bundle artifacts from mutable Release policy and compile
  policy changes ahead of time into deterministic Release catalogs.
  Database plugins now expose Release and catalog models plus atomic Release
  revision/catalog generation expectations, and no longer expose provider update
  decision queries.

  Add canonical v2 Release-catalog and Bundle-artifact routes, short-lived
  authenticated shared caching, a v1-only device protocol boundary, Release
  management commands, catalog preflight/rebuild tooling, and a familiar Bundle
  management view backed by Releases. The Console keeps Bundle content, delivery settings,
  promote, and download actions in one workflow while Release identity stays
  secondary. Deploy and promote create Releases; rollback disables the current
  Release so clients select the previous compatible enabled Release or the
  built-in app. Rollout, targeting, enablement, and messages mutate Releases
  while patch, manifest, signing, and storage behavior remain Bundle-keyed.
  Release IDs are canonical UUIDv7 values. Console shadcn primitives now use Base
  UI instead of Radix while preserving the existing management flow and visual
  density.

  React Native clients select desired Releases locally, persist authority/scope
  generation high-water and full Release/Bundle receipts, support same-Bundle
  adoption and authenticated BUILTIN fallback, and use generation/context CAS so
  stale artifact work cannot commit. New catalogs retain an 11-artifact update
  frontier plus the complete compatible enabled rollback spine, so rollback keeps
  v0 predecessor semantics even for old active clients. The 256 KiB catalog cap
  remains atomic: an oversized history rejects the Release mutation instead of
  silently truncating rollback candidates. Analytics events now carry directional
  Release identity alongside Bundle identity.

  Migrate SQL, DynamoDB, D1, Firestore, Supabase, MongoDB, Drizzle, Kysely,
  Prisma, Standalone, mock, and in-memory implementations to schema `1.0.0`.
  Managed AWS, Cloudflare, and Firebase deployments place Release catalogs behind
  their supported pre-origin cache, while Supabase uses its direct Edge Function
  URL as a supported origin-only mode and reports Edge invocations separately
  from Postgres catalog reads.

- c8e24cd: Make Hot Updater v1 infrastructure a clean generation boundary. Managed init
  now rejects selected v0 resources before mutation and requires newly
  scaffolded resources, while doctor identifies missing v1 generation markers
  and gives the parallel-cutover remediation.

  Remove the v0 app-version and fingerprint HTTP routes, the legacy SDK-version
  header contract, CDN forwarding and cache paths for those routes, and managed
  provider Release Catalog backfills. Existing v0 native binaries must remain on
  their unchanged v0 endpoint; new v1 native builds use the unversioned catalog
  and artifact routes on fresh v1 infrastructure.

  Normalize managed provider base URLs to their public deployment roots. AWS,
  Cloudflare, and Firebase now serve `/version`, `/release-catalogs/*`,
  `/artifacts/*`, and `/events` directly; Supabase retains only its
  provider-owned Edge Function prefix. Client routes do not carry a library or
  protocol version prefix because incompatible generations use a fresh base URL.

### Patch Changes

- Updated dependencies [b424d47]
- Updated dependencies [9650748]
- Updated dependencies [88c163a]
- Updated dependencies [a9ffb2a]
- Updated dependencies [a9ffb2a]
- Updated dependencies [5a2e1cd]
- Updated dependencies [25af6ef]
- Updated dependencies [a9ffb2a]
  - @hot-updater/plugin-core@1.0.0-rc.0
  - @hot-updater/core@1.0.0-rc.0

## 0.36.0

## 0.35.12

## 0.35.11

## 0.35.10

## 0.35.9

## 0.35.8

## 0.35.7

## 0.35.6

## 0.35.5

## 0.35.4

## 0.35.3

## 0.35.2

## 0.35.1

## 0.35.0

## 0.34.0

## 0.33.2

## 0.33.1

## 0.33.0

## 0.32.0

## 0.31.4

## 0.31.3

## 0.31.2

## 0.31.1

## 0.31.0

## 0.30.12

### Patch Changes

- @hot-updater/core@0.30.12

## 0.30.11

### Patch Changes

- @hot-updater/core@0.30.11

## 0.30.10

### Patch Changes

- @hot-updater/core@0.30.10

## 0.30.9

### Patch Changes

- @hot-updater/core@0.30.9

## 0.30.8

### Patch Changes

- @hot-updater/core@0.30.8

## 0.30.7

### Patch Changes

- @hot-updater/core@0.30.7

## 0.30.6

### Patch Changes

- @hot-updater/core@0.30.6

## 0.30.5

### Patch Changes

- @hot-updater/core@0.30.5

## 0.30.4

### Patch Changes

- @hot-updater/core@0.30.4

## 0.30.3

### Patch Changes

- @hot-updater/core@0.30.3

## 0.30.2

### Patch Changes

- @hot-updater/core@0.30.2

## 0.30.1

### Patch Changes

- @hot-updater/core@0.30.1

## 0.30.0

### Minor Changes

- 83c01c8: fix: keep target cohorts additive to rollout

### Patch Changes

- Updated dependencies [83c01c8]
  - @hot-updater/core@0.30.0

## 0.29.8

### Patch Changes

- @hot-updater/core@0.29.8

## 0.29.7

### Patch Changes

- @hot-updater/core@0.29.7

## 0.29.6

### Patch Changes

- @hot-updater/core@0.29.6

## 0.29.5

### Patch Changes

- @hot-updater/core@0.29.5

## 0.29.4

### Patch Changes

- @hot-updater/core@0.29.4

## 0.29.3

### Patch Changes

- @hot-updater/core@0.29.3

## 0.29.2

### Patch Changes

- 2a1bc80: fix: node deps bundling
- Updated dependencies [2a1bc80]
  - @hot-updater/core@0.29.2

## 0.29.1

### Patch Changes

- @hot-updater/core@0.29.1

## 0.29.0

### Minor Changes

- a935992: feat: Rollout feature with control from 1% to 100%

### Patch Changes

- d0fe908: fix(console): rebuild copied bundles with fresh uuidv7 ids
- Updated dependencies [a935992]
- Updated dependencies [d0fe908]
  - @hot-updater/core@0.29.0

## 0.28.0

### Patch Changes

- @hot-updater/core@0.28.0

## 0.27.1

### Patch Changes

- @hot-updater/core@0.27.1

## 0.27.0

### Minor Changes

- 81f9437: feat(android): for safe reloading, Android reloads the process (#869)

### Patch Changes

- Updated dependencies [81f9437]
  - @hot-updater/core@0.27.0

## 0.26.2

### Patch Changes

- @hot-updater/core@0.26.2

## 0.26.1

### Patch Changes

- @hot-updater/core@0.26.1

## 0.26.0

### Patch Changes

- @hot-updater/core@0.26.0

## 0.25.14

### Patch Changes

- @hot-updater/core@0.25.14

## 0.25.13

### Patch Changes

- @hot-updater/core@0.25.13

## 0.25.12

### Patch Changes

- @hot-updater/core@0.25.12

## 0.25.11

### Patch Changes

- @hot-updater/core@0.25.11

## 0.25.10

### Patch Changes

- @hot-updater/core@0.25.10

## 0.25.9

### Patch Changes

- @hot-updater/core@0.25.9

## 0.25.8

### Patch Changes

- @hot-updater/core@0.25.8

## 0.25.7

### Patch Changes

- @hot-updater/core@0.25.7

## 0.25.6

### Patch Changes

- @hot-updater/core@0.25.6

## 0.25.5

### Patch Changes

- @hot-updater/core@0.25.5

## 0.25.4

### Patch Changes

- @hot-updater/core@0.25.4

## 0.25.3

### Patch Changes

- @hot-updater/core@0.25.3

## 0.25.2

### Patch Changes

- @hot-updater/core@0.25.2

## 0.25.1

### Patch Changes

- @hot-updater/core@0.25.1

## 0.25.0

### Patch Changes

- @hot-updater/core@0.25.0

## 0.24.7

### Patch Changes

- 294e324: fix: update babel plugin path in documentation and plugin files
- Updated dependencies [294e324]
  - @hot-updater/core@0.24.7

## 0.24.6

### Patch Changes

- @hot-updater/core@0.24.6

## 0.24.5

### Patch Changes

- @hot-updater/core@0.24.5

## 0.24.4

### Patch Changes

- @hot-updater/core@0.24.4

## 0.24.3

### Patch Changes

- @hot-updater/core@0.24.3

## 0.24.2

### Patch Changes

- @hot-updater/core@0.24.2

## 0.24.1

### Patch Changes

- @hot-updater/core@0.24.1

## 0.24.0

### Patch Changes

- @hot-updater/core@0.24.0

## 0.23.1

### Patch Changes

- @hot-updater/core@0.23.1

## 0.23.0

### Patch Changes

- Updated dependencies [e41fb6b]
  - @hot-updater/core@0.23.0

## 0.22.2

### Patch Changes

- @hot-updater/core@0.22.2

## 0.22.1

### Patch Changes

- @hot-updater/core@0.22.1

## 0.22.0

### Patch Changes

- @hot-updater/core@0.22.0

## 0.21.15

### Patch Changes

- a169f06: unique constraint violations
  - @hot-updater/core@0.21.15

## 0.21.14

### Patch Changes

- @hot-updater/core@0.21.14

## 0.21.13

### Patch Changes

- @hot-updater/core@0.21.13

## 0.21.12

### Patch Changes

- @hot-updater/core@0.21.12

## 0.21.11

### Patch Changes

- e2b67d7: fix(cli-tools): esm only package bundle
- 2905e47: feat(server): supports hot-updater database plugin style
- Updated dependencies [e2b67d7]
  - @hot-updater/core@0.21.11

## 0.21.10

### Patch Changes

- 5289b17: only include valid where clauses during building /bundles orm command
  - @hot-updater/core@0.21.10

## 0.21.9

### Patch Changes

- @hot-updater/core@0.21.9

## 0.21.8

### Patch Changes

- @hot-updater/core@0.21.8

## 0.21.7

### Patch Changes

- @hot-updater/core@0.21.7

## 0.21.6

### Patch Changes

- @hot-updater/core@0.21.6

## 0.21.5

### Patch Changes

- @hot-updater/core@0.21.5

## 0.21.4

### Patch Changes

- 5d3070a: fix(aws): semver bounded range matching bug (#632)
  - @hot-updater/core@0.21.4

## 0.21.3

### Patch Changes

- @hot-updater/core@0.21.3

## 0.21.2

### Patch Changes

- @hot-updater/core@0.21.2

## 0.21.1

### Patch Changes

- @hot-updater/core@0.21.1

## 0.22.0

### Minor Changes

- 036f8f0: feat: support `@hot-updater/server` for self-hosted (WIP)

### Patch Changes

- Updated dependencies [afb084b]
- Updated dependencies [036f8f0]
  - @hot-updater/core@0.22.0
