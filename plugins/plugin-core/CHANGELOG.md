# @hot-updater/plugin-core

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

- 9650748: Remove `createBlobDatabasePlugin` and the AWS `s3Database` metadata provider.
  AWS init and Lambda@Edge now use DynamoDB as the only metadata database while
  continuing to store bundle artifacts in S3.
- a9ffb2a: Remove unused `releaseChannel` from `hot-updater.config.ts`. The build-time channel is set with `hot-updater channel set`.
- a9ffb2a: Require R2 S3 credentials, drop Wrangler `r2Storage` and Android `stringResourcePaths`. Doctor only targets infrastructure generation 1.0.0. Channel, fingerprint, and signing keys live in AndroidManifest.xml.
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

- 25af6ef: Replace runtime-profiled storage plugins with the flat, runtime-independent
  `createStoragePlugin({ name, protocol, put, get, getDownloadUrl, exists, delete
})` contract. Every operation uses an object input and object result. `put`
  accepts a complete object key and a one-shot Web stream, `get` returns a Web
  `Response`,
  `getDownloadUrl` returns the URL sent to update clients, and `delete` always
  targets exactly one object and resolves to the idempotent `{ deleted: true }`
  postcondition. Remove file paths, factory thunks, runtime contexts, prefix
  deletion, and lifecycle hooks from the core storage boundary.

  Standardize persisted locations as hierarchical
  `protocol://bucket/encoded/slash/key` URIs. `createStorageUri` encodes each key
  segment without flattening slash hierarchy, while `parseStorageUri` performs
  the matching validation and decoding. Empty and dot segments, query strings,
  and fragments are rejected.

  Pass server storage implementations directly through
  `createHotUpdater({ storage: [...] })`. URL policy belongs to each storage
  implementation: AWS S3 can use its CloudFront resolver or a server-signed URL,
  Firebase and Supabase generate provider URLs, and private Cloudflare R2 returns
  a signed handler-relative URL. Remove `storageDelivery`, public base-URL and
  top-level signing-key configuration, and the separate provider delivery
  helpers. Cloudflare Worker storage uses the same `r2Storage` export name from
  the `/worker` subpath and captures its native R2 binding at construction.

  Resolve persisted URIs by registered scheme ownership first, including `http`
  and `https`. Only an HTTP(S) URI without an owner uses direct fetch or redirect;
  other unowned schemes are unsupported. Runtime composition accepts at most one
  storage plugin for each scheme.

  Update every built-in storage provider, CLI and Console consumer, managed
  runtime, package entrypoint, and custom-hosting guide to the new contract.
  Remove the storage-only JWT URL helpers and obsolete runtime-specific storage
  creators. Route-group flags now live beside Analytics and client access keys in
  the single `createHotUpdater({ features })` object.

- a9ffb2a: Remove leftover v0 aliases that are not field compatibility. `HotUpdater.wrap({ updateMode: "manual" })` throws, findMany accepts only `orderBy`, and Supabase plugins require `supabaseServiceRoleKey`. Managed init still detects leftover `supabaseAnonKey` so skipped v0 configs fail closed.

### Patch Changes

- Updated dependencies [b424d47]
- Updated dependencies [88c163a]
- Updated dependencies [5a2e1cd]
- Updated dependencies [25af6ef]
  - @hot-updater/core@1.0.0-rc.0
  - @hot-updater/js@1.0.0-rc.0

## 0.36.0

### Patch Changes

- 9759e8a: Reduce S3 management query work by skipping legacy UUIDv7 artifact traversal, deriving channels from canonical manifest keys, and batching multi-bundle deletion scans and commits. Store new bundle artifacts below `bundles/<bundle-id>` while preserving legacy reads, and add exact target app version filters to the CLI and Console. Add an exclusive-maintenance `hot-updater storage prune` command for orphaned bundle objects and unreferenced shared assets, with an explicit `--dry-run` candidate table, a recent-object protection window, and fail-closed reference validation safeguards.
  - @hot-updater/core@0.36.0
  - @hot-updater/js@0.36.0

## 0.35.12

### Patch Changes

- 6e8b32e: Replace the semver dependency with verkit.
- Updated dependencies [6e8b32e]
  - @hot-updater/js@0.35.12
  - @hot-updater/core@0.35.12

## 0.35.11

### Patch Changes

- 1a3a621: Keep bundle content type detection portable across runtimes.
  - @hot-updater/core@0.35.11
  - @hot-updater/js@0.35.11

## 0.35.10

### Patch Changes

- ce8d254: feat: support platform-scoped `fingerprint.extraSources`

  `fingerprint.extraSources` now accepts `{ ios?: string[], android?: string[] }`
  in addition to `string[]`. An array keeps the existing behavior (shared by both
  platforms); the object form only feeds the fingerprint of the platform it is
  scoped to, so an iOS-only native input no longer moves the Android fingerprint
  (and vice versa).

  The default config no longer sets `extraSources: []`, which the config deep
  merge would otherwise use to clobber a user-supplied object.

  - @hot-updater/core@0.35.10
  - @hot-updater/js@0.35.10

## 0.35.9

### Patch Changes

- @hot-updater/core@0.35.9
- @hot-updater/js@0.35.9

## 0.35.8

### Patch Changes

- @hot-updater/core@0.35.8
- @hot-updater/js@0.35.8

## 0.35.7

### Patch Changes

- @hot-updater/core@0.35.7
- @hot-updater/js@0.35.7

## 0.35.6

### Patch Changes

- @hot-updater/core@0.35.6
- @hot-updater/js@0.35.6

## 0.35.5

### Patch Changes

- @hot-updater/core@0.35.5
- @hot-updater/js@0.35.5

## 0.35.4

### Patch Changes

- @hot-updater/core@0.35.4
- @hot-updater/js@0.35.4

## 0.35.3

### Patch Changes

- @hot-updater/core@0.35.3
- @hot-updater/js@0.35.3

## 0.35.2

### Patch Changes

- @hot-updater/core@0.35.2
- @hot-updater/js@0.35.2

## 0.35.1

### Patch Changes

- @hot-updater/core@0.35.1
- @hot-updater/js@0.35.1

## 0.35.0

### Patch Changes

- @hot-updater/core@0.35.0
- @hot-updater/js@0.35.0

## 0.34.0

### Patch Changes

- 088f6c1: refactor(server): remove fumadb adapter split
- Updated dependencies [7244b65]
  - @hot-updater/core@0.34.0
  - @hot-updater/js@0.34.0

## 0.33.2

### Patch Changes

- @hot-updater/core@0.33.2
- @hot-updater/js@0.33.2

## 0.33.1

### Patch Changes

- a5c4467: Remove blob database management index artifacts. Console reads now use canonical
  update manifests, and AWS deployments no longer write `_index` metadata.
  Target app version manifests are updated from commit changes without listing S3.
  AWS database metadata now uses single PutObject writes instead of multipart upload.
  AWS canonical manifest scans now use S3 delimiters to avoid reading asset object
  lists during console-style bundle lookups.
  AWS recursive manifest listing now uses bounded concurrency to avoid S3 SlowDown
  when E2E shards query bundle metadata in parallel.
  Blob database instances now remember locally committed deletions so immediate
  delete verification does not reload canonical manifests.
  Plugin-core now owns a request-scoped bundle unit-of-work / identity map. Within
  one request, repeated bundle reads reuse the same value, pending updates and
  deletes are reflected in `getBundleById` and query-aware `getBundles` results,
  and commit clears the pending state.
  Provider implementations continue to implement only reads and writes; they do
  not need to manage identity-map caching themselves. No-context reads no longer
  persist stale identity entries across logical requests, while no-context mutation
  staging remains available until commit for existing CLI-style flows.
  Server update-info artifact resolution reuses the request identity map instead
  of adding duplicate bundle reads for manifest artifact lookup.
  Canonical blob reloads now clear provider-local pending state so another plugin
  instance's committed manifest update is visible through the canonical path.
  Console bundle deletion now closes the detail panel immediately after cached
  state is updated, while broader bundle, child, and channel invalidations continue
  in the background.
  - @hot-updater/core@0.33.1
  - @hot-updater/js@0.33.1

## 0.33.0

### Patch Changes

- e914f56: Avoid redundant provider bundle reads during update checks and teach doctor to flag server runtime redeploy requirements.
  - @hot-updater/core@0.33.0
  - @hot-updater/js@0.33.0

## 0.32.0

### Minor Changes

- 4e6d2ec: Use deterministic content-addressed storage keys for manifest assets, require storage plugins to implement object existence checks, skip uploads when the object already exists, limit deploy upload concurrency, stream hashing/compression work to reduce memory pressure, and report upload progress through 100%.

### Patch Changes

- @hot-updater/core@0.32.0
- @hot-updater/js@0.32.0

## 0.31.4

### Patch Changes

- @hot-updater/core@0.31.4
- @hot-updater/js@0.31.4

## 0.31.3

### Patch Changes

- @hot-updater/core@0.31.3
- @hot-updater/js@0.31.3

## 0.31.2

### Patch Changes

- @hot-updater/core@0.31.2
- @hot-updater/js@0.31.2

## 0.31.1

### Patch Changes

- @hot-updater/core@0.31.1
- @hot-updater/js@0.31.1

## 0.31.0

### Patch Changes

- Updated dependencies [5b0a0f5]
- Updated dependencies [5b0a0f5]
  - @hot-updater/core@0.31.0
  - @hot-updater/js@0.31.0

## 0.30.12

### Patch Changes

- @hot-updater/core@0.30.12
- @hot-updater/js@0.30.12

## 0.30.11

### Patch Changes

- @hot-updater/core@0.30.11
- @hot-updater/js@0.30.11

## 0.30.10

### Patch Changes

- @hot-updater/core@0.30.10
- @hot-updater/js@0.30.10

## 0.30.9

### Patch Changes

- @hot-updater/core@0.30.9
- @hot-updater/js@0.30.9

## 0.30.8

### Patch Changes

- 6019156: refactor(cli-tools): extract `promoteBundle` from `@hot-updater/console` so it can be reused by the CLI

  `promoteBundle` and `createCopiedBundleArchive` move from `@hot-updater/console`'s server-only `lib/server/promoteBundle.ts` into `@hot-updater/cli-tools`. The console's RPC handler now imports from `@hot-updater/cli-tools`. UUIDv7 helpers (`createUUIDv7`, `extractTimestampFromUUIDv7`, `createUUIDv7WithSameTimestamp`) move to `@hot-updater/plugin-core` since they are generic primitives, not console-specific.

  Pure refactor — no behavior change. Existing test coverage moves with the function. This unblocks an upcoming `hot-updater promote` CLI command that calls the same implementation as the console UI.

  - @hot-updater/core@0.30.8
  - @hot-updater/js@0.30.8

## 0.30.7

### Patch Changes

- @hot-updater/core@0.30.7
- @hot-updater/js@0.30.7

## 0.30.6

### Patch Changes

- @hot-updater/core@0.30.6
- @hot-updater/js@0.30.6

## 0.30.5

### Patch Changes

- @hot-updater/core@0.30.5
- @hot-updater/js@0.30.5

## 0.30.4

### Patch Changes

- @hot-updater/core@0.30.4
- @hot-updater/js@0.30.4

## 0.30.3

### Patch Changes

- @hot-updater/core@0.30.3
- @hot-updater/js@0.30.3

## 0.30.2

### Patch Changes

- @hot-updater/core@0.30.2
- @hot-updater/js@0.30.2

## 0.30.1

### Patch Changes

- @hot-updater/core@0.30.1
- @hot-updater/js@0.30.1

## 0.30.0

### Minor Changes

- 83c01c8: fix: keep target cohorts additive to rollout

### Patch Changes

- Updated dependencies [83c01c8]
  - @hot-updater/core@0.30.0
  - @hot-updater/js@0.30.0

## 0.29.8

### Patch Changes

- @hot-updater/core@0.29.8
- @hot-updater/js@0.29.8

## 0.29.7

### Patch Changes

- @hot-updater/core@0.29.7
- @hot-updater/js@0.29.7

## 0.29.6

### Patch Changes

- @hot-updater/core@0.29.6
- @hot-updater/js@0.29.6

## 0.29.5

### Patch Changes

- 52208f4: perf: Fast-path lambda update checks through plugin-core
  - @hot-updater/core@0.29.5
  - @hot-updater/js@0.29.5

## 0.29.4

### Patch Changes

- @hot-updater/core@0.29.4

## 0.29.3

### Patch Changes

- d1ffb83: Stale data due to module-level singleton configPromise and shared changedMap across requests
  - @hot-updater/core@0.29.3

## 0.29.2

### Patch Changes

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

- 03c5adc: fix(plugin-core): update target-app-versions on channel promotion
  - @hot-updater/core@0.25.10

## 0.25.9

### Patch Changes

- 6b22072: Change the default value of `podInstalls` option in iOS native build scheme to `false`
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

- 7ed539f: fix(s3): s3Database not function error
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

- @hot-updater/core@0.21.15

## 0.21.14

### Patch Changes

- @hot-updater/core@0.21.14

## 0.21.13

### Patch Changes

- @hot-updater/core@0.21.13

## 0.21.12

### Patch Changes

- 5c4b98e: feat(storage): createStoragePlugin
  - @hot-updater/core@0.21.12

## 0.21.11

### Patch Changes

- e2b67d7: fix(cli-tools): esm only package bundle
- Updated dependencies [e2b67d7]
  - @hot-updater/core@0.21.11

## 0.21.10

### Patch Changes

- @hot-updater/core@0.21.10

## 0.21.9

### Patch Changes

- aa399a6: chore: deps picocolors
  - @hot-updater/core@0.21.9

## 0.21.8

### Patch Changes

- 3fe8c81: feat(plugin-core): reduced deps for edge-runtime
  - @hot-updater/core@0.21.8

## 0.21.7

### Patch Changes

- 2b408f2: docs: revamp hot-updater.dev
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

- 7b7bc48: fix: zlib using node api
  - @hot-updater/core@0.21.1

## 0.22.0

### Minor Changes

- 610b2dd: feat: supports `compressStrategy` => `tar.br` (brotli) / `tar.gz` (gzip)
- afb084b: feat: validate bundle file with fileHash
- 036f8f0: feat: support `@hot-updater/server` for self-hosted (WIP)

### Patch Changes

- Updated dependencies [afb084b]
- Updated dependencies [036f8f0]
  - @hot-updater/core@0.22.0

## 0.20.15

### Patch Changes

- 526a5ba: fix(aws): normalize targetAppVersion to prevent duplicate S3 paths
- ddf6f2c: Encodes paths before invalidation to handle special chars
  - @hot-updater/core@0.20.15

## 0.20.14

### Patch Changes

- a61fa0e: fix(aws): lambda using cloudfront private key from parameter store
  - @hot-updater/core@0.20.14

## 0.20.13

### Patch Changes

- @hot-updater/core@0.20.13

## 0.20.12

### Patch Changes

- @hot-updater/core@0.20.12

## 0.20.11

### Patch Changes

- cb9c05b: feat(fingerprint): bring back ignorePaths
  - @hot-updater/core@0.20.11

## 0.20.10

### Patch Changes

- @hot-updater/core@0.20.10

## 0.20.9

### Patch Changes

- @hot-updater/core@0.20.9

## 0.20.8

### Patch Changes

- ad7c999: feat(fingerprint): calculate OTA fingerprint only in native module
  - @hot-updater/core@0.20.8

## 0.20.7

### Patch Changes

- a92992c: chore(tsdown): failOnWarn true
- Updated dependencies [a92992c]
  - @hot-updater/core@0.20.7

## 0.20.6

### Patch Changes

- 6a905d8: fix(aws): widen invalidation scope when targetAppVersion covers a broader range
  - @hot-updater/core@0.20.6

## 0.20.5

### Patch Changes

- @hot-updater/core@0.20.5

## 0.20.4

### Patch Changes

- 5314b31: feat(rock): intergration formerly rnef
- 711392b: feat: default updateStrategy is 'appVersion'
  - @hot-updater/core@0.20.4

## 0.20.3

### Patch Changes

- e63056a: fix(cli): platform parser from hot-updater.config
  - @hot-updater/core@0.20.3

## 0.20.2

### Patch Changes

- 0e78fb0: fix(cli): Info.plist correct path
  - @hot-updater/core@0.20.2

## 0.20.1

### Patch Changes

- a3a4a28: feat(cli): set stringResourcePaths and infoPlistPaths in hot-updater.config.ts
  - @hot-updater/core@0.20.1

## 0.20.0

### Minor Changes

- bc8e23d: fix(cli): hot-updater.config.ts required updateStrategy field

### Patch Changes

- @hot-updater/core@0.20.0

## 0.19.10

### Patch Changes

- 2bc52e8: feat(storage): add support for target storage location and return storageUri (v0.18.0+)
  - @hot-updater/core@0.19.10

## 0.19.9

### Patch Changes

- @hot-updater/core@0.19.9

## 0.19.8

### Patch Changes

- @hot-updater/core@0.19.8

## 0.19.7

### Patch Changes

- @hot-updater/core@0.19.7

## 0.19.6

### Patch Changes

- 657a10e: Android Native Build - Gradle Build
  - @hot-updater/core@0.19.6

## 0.19.5

### Patch Changes

- 40d28c2: bump rnef
- Updated dependencies [40d28c2]
  - @hot-updater/core@0.19.5

## 0.19.4

### Patch Changes

- 0ddc955: fix(aws): cloudfront invalidate when update channel
  - @hot-updater/core@0.19.4

## 0.19.3

### Patch Changes

- 0c0ab1d: Add debug option while creating fingerprint
  - @hot-updater/core@0.19.3

## 0.19.2

### Patch Changes

- @hot-updater/core@0.19.2

## 0.19.1

### Patch Changes

- @hot-updater/core@0.19.1

## 0.19.0

### Minor Changes

- 886809d: fix(babel): make sure the backend can handle channel changes for a bundle and still receive updates correctly

### Patch Changes

- @hot-updater/core@0.19.0

## 0.18.5

### Patch Changes

- 494ce31: feat: delete Bundle
  - @hot-updater/core@0.18.5

## 0.18.4

### Patch Changes

- @hot-updater/core@0.18.4

## 0.18.3

### Patch Changes

- @hot-updater/core@0.18.3

## 0.18.2

### Patch Changes

- 437c98e: fix: pagination doesn't work (edit database spec)
  - @hot-updater/core@0.18.2

## 0.18.1

### Patch Changes

- @hot-updater/core@0.18.1

## 0.18.0

### Minor Changes

- 73ec434: fingerprint-based update stratgy

### Patch Changes

- Updated dependencies [73ec434]
  - @hot-updater/core@0.18.0
