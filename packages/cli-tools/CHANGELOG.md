# @hot-updater/cli-tools

## 1.0.0-rc.0

### Major Changes

- adb0e40: Release HotUpdater 1.0 with the Release Catalog architecture.

### Minor Changes

- 3b367e7: Add built-in API key authentication backed by the official
  `database.models.apiKeys` domain. Every `createHotUpdater` call must set
  `clientAccess` explicitly. `{ type: "api-key" }` protects OTA reads and
  Analytics ingestion with `x-api-key` by default; it does not grant Analytics
  query, Bundle management, or API key management access.

  Add `hot-updater api-key create`, `list`, and `revoke` for self-hosted
  deployments. Creation returns the plaintext API key exactly once, while the
  database stores only its SHA-256 hash and non-secret metadata. Managed AWS,
  Cloudflare, Firebase, and Supabase init use the same API key domain and persist
  the plaintext only in the local `HOT_UPDATER_API_KEY` environment entry.
  Console API key management uses the same domain directly.
  `createHotUpdater(...).apiKeys` exposes the common local create, list, and
  revoke management API without adding an HTTP management route.
  Self-hosted setup now recommends the `api-key` client policy: migrate the direct
  database, create a key from the same config, then pass the one-time plaintext to
  React Native through `x-api-key`. The `public` policy remains an explicit
  unauthenticated alternative.

  Rename the pre-release public API and storage terminology from Client Access
  Key to API Key, including `database.models.apiKeys`, `ApiKeyModel`,
  `ApiKeyRow`, `createApiKey`, and `registerApiKey`. Fresh v1 provider schemas use
  the canonical API key naming and do not migrate or reuse v0 databases.

  Remove the separate Better Auth package, generic authentication provider,
  managed route policy, universal component schema, and provisioning preset.

- b424d47: Replace the legacy database plugin API with the fixed official-domain contract:

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
      apiKeys,
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
  Analytics, and API key storage on an empty database. It rejects v0
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

  Self-hosted runtimes always expose Analytics ingestion and query capabilities
  backed by `database.models.analytics`. Every `createHotUpdater` call explicitly
  sets the required `clientAccess` policy, which can protect update checks and
  Analytics ingestion through
  `database.models.apiKeys`. Client update routes are always available
  on `handlers.client`, while admin routes are exposed only by explicitly
  mounting `handlers.admin`. The CLI-only
  `standaloneRepository` stays a bundle repository; the physical database passed
  to the self-hosted `createHotUpdater` instance owns the full official contract.

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
  Managed AWS and Cloudflare deployments place Release catalogs behind their
  supported pre-origin cache. Firebase and Supabase use their direct Function
  URLs as supported origin-only modes and report Function invocations separately
  from database catalog reads.

- e2455c5: Remove user-managed Catalog authority from configuration, generated provider
  environments, deployment output, and public React Native update state. Catalogs
  receive an opaque identity on their first atomic commit and preserve it across
  updates, rebuilds, and tombstones. CLI and server share the persisted identity
  without configuration. Native stale-generation and unexpected-Catalog guards
  remain in place.

  This changes the unreleased v1 database schema and internal JS/native protocol
  together. Catalog rows are part of persistent history and must be included in
  backups; a missing row with retained Releases cannot be regenerated safely.

- c8e24cd: Make Hot Updater v1 infrastructure a clean generation boundary. Managed init
  now rejects selected v0 compute resources before mutation. Supabase tables and
  RPCs plus Firebase collections and Functions use fixed v1 namespaces, allowing
  v0 and v1 to coexist in one project while doctor identifies missing generation
  markers and gives the parallel-cutover remediation.

  AWS fresh installs use v1 Lambda and DynamoDB names plus a Lambda-scoped v1
  signing-key path. S3 buckets can be shared across generations: init no longer
  treats a matching bucket origin as CloudFront ownership, creates a new
  distribution by default, and only updates the exact saved distribution after
  its generation check passes.

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
  creators. Route-group flags are removed; Analytics is always available and the
  required `clientAccess` policy controls client authentication.

- 7ec1a46: Persist required immutable archive and patch byte sizes across the initial v1
  Bundle contract and official database providers. This pre-release change has no
  general cross-provider backfill for earlier unreleased `1.0.0` schemas. DynamoDB
  readers default a missing archive byte size on existing Bundle rows to zero,
  while Cloudflare applies an incremental D1 migration that backfills missing
  Bundle and patch byte sizes with zero.

  Record optional exact served-object sizes and hashes in Bundle manifests,
  content-address new Brotli payloads by their compressed hash, and let the
  server select the archive when known normal diff bytes are equal to or larger
  than it. Unknown optional manifest metadata preserves the existing
  manifest-first path, with no native protocol change or request-time storage
  metadata probe.

### Patch Changes

- 3b367e7: Prevent managed init from overwriting existing v0 Workers and Functions when
  the selected compute resource name is already in use. Retry initial AWS Lambda
  creation while a newly created execution role propagates. Show the issued API
  key separately after the React Native setup example so it can be stored safely.
  Enable the Cloud Functions API before checking an existing Firebase function
  and report function discovery failures without an unhandled command stack.
  Bundle Firebase Functions' internal plugin dependency and deploy only the
  managed v1 Function target so an existing v0 Function is preserved.
  Wait for a newly provisioned Supabase Storage tenant before creating the
  selected bucket, and preserve the access level of a reused operator-owned
  bucket. Wait for PostgREST to expose newly migrated Supabase tables before
  registering the init API key, and keep Supabase CLI metadata inside the
  temporary scaffold workdir.
- a9ffb2a: Remove unused `releaseChannel` from `hot-updater.config.ts`. The build-time channel is set with `hot-updater channel set`.
- a9ffb2a: Require R2 S3 credentials, drop Wrangler `r2Storage` and Android `stringResourcePaths`. Doctor only targets infrastructure generation 1.0.0. Channel, fingerprint, and signing keys live in AndroidManifest.xml.
- c355c26: Extend Bundle Signing with plugins for a generic remote signing endpoint, AWS
  KMS, and Google Cloud KMS while preserving v0 local `enabled`/`privateKeyPath`
  configuration. Local `publicKeyPath` is optional; signing plugins require it.
  Support public-key-only native/Expo builds and sanitized read-only Console
  inspection. Local PEM is the standard baseline, while AWS KMS and Google Cloud
  KMS provide hardened, non-exportable key custody through optional SDK peers.

  Require RSA keys of at least 2048 bits, validate explicit public-key pins and
  native key matches before deployment, and verify signatures before upload.
  Prevent key generation from overwriting existing files and default to
  cancelling replacement of a different or invalid embedded public key. Existing
  v0 CLI-generated keys meet the key requirements; signing-key changes still
  require a native-first rollout.

- a9ffb2a: Remove leftover v0 aliases that are not field compatibility. `HotUpdater.wrap({ updateMode: "manual" })` throws, findMany accepts only `orderBy`, and Supabase plugins require `supabaseServiceRoleKey`. Managed init still detects leftover `supabaseAnonKey` so skipped v0 configs fail closed.
- Updated dependencies [3b367e7]
- Updated dependencies [b424d47]
- Updated dependencies [9650748]
- Updated dependencies [88c163a]
- Updated dependencies [a9ffb2a]
- Updated dependencies [a9ffb2a]
- Updated dependencies [5a2e1cd]
- Updated dependencies [adb0e40]
- Updated dependencies [e2455c5]
- Updated dependencies [25af6ef]
- Updated dependencies [c355c26]
- Updated dependencies [7ec1a46]
- Updated dependencies [a9ffb2a]
  - @hot-updater/plugin-core@1.0.0-rc.0
  - @hot-updater/core@1.0.0-rc.0

## 0.36.0

### Patch Changes

- 9759e8a: Reduce S3 management query work by skipping legacy UUIDv7 artifact traversal, deriving channels from canonical manifest keys, and batching multi-bundle deletion scans and commits. Store new bundle artifacts below `bundles/<bundle-id>` while preserving legacy reads, and add exact target app version filters to the CLI and Console. Add an exclusive-maintenance `hot-updater storage prune` command for orphaned bundle objects and unreferenced shared assets, with an explicit `--dry-run` candidate table, a recent-object protection window, and fail-closed reference validation safeguards.
- Updated dependencies [9759e8a]
  - @hot-updater/plugin-core@0.36.0
  - @hot-updater/core@0.36.0

## 0.35.12

### Patch Changes

- fd30452: Support firebase-admin v14 by using the modular Admin SDK APIs.
- 6e8b32e: Replace the semver dependency with verkit.
- Updated dependencies [6e8b32e]
  - @hot-updater/plugin-core@0.35.12
  - @hot-updater/core@0.35.12

## 0.35.11

### Patch Changes

- Updated dependencies [1a3a621]
  - @hot-updater/plugin-core@0.35.11
  - @hot-updater/core@0.35.11

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

- Updated dependencies [ce8d254]
  - @hot-updater/plugin-core@0.35.10
  - @hot-updater/core@0.35.10

## 0.35.9

### Patch Changes

- 8688b1a: chore: migrate to TypeScript 7 and OXC
- f9bb26d: Declare init inputs in each provider package through a shared contract, ask
  once before saving credential inputs, and support prompt-free infrastructure
  reconciliation with `init --env-file .env.hotupdater`.
  - @hot-updater/core@0.35.9
  - @hot-updater/plugin-core@0.35.9

## 0.35.8

### Patch Changes

- 4f9fab2: Render spinner, progress, and task output statically in CI and non-interactive
  terminals, and update the embedded Clack runtime to 1.7.0.
  - @hot-updater/core@0.35.8
  - @hot-updater/plugin-core@0.35.8

## 0.35.7

### Patch Changes

- @hot-updater/core@0.35.7
- @hot-updater/plugin-core@0.35.7

## 0.35.6

### Patch Changes

- @hot-updater/core@0.35.6
- @hot-updater/plugin-core@0.35.6

## 0.35.5

### Patch Changes

- @hot-updater/core@0.35.5
- @hot-updater/plugin-core@0.35.5

## 0.35.4

### Patch Changes

- @hot-updater/core@0.35.4
- @hot-updater/plugin-core@0.35.4

## 0.35.3

### Patch Changes

- @hot-updater/core@0.35.3
- @hot-updater/plugin-core@0.35.3

## 0.35.2

### Patch Changes

- @hot-updater/core@0.35.2
- @hot-updater/plugin-core@0.35.2

## 0.35.1

### Patch Changes

- @hot-updater/core@0.35.1
- @hot-updater/plugin-core@0.35.1

## 0.35.0

### Patch Changes

- @hot-updater/core@0.35.0
- @hot-updater/plugin-core@0.35.0

## 0.34.0

### Patch Changes

- Updated dependencies [088f6c1]
- Updated dependencies [7244b65]
  - @hot-updater/plugin-core@0.34.0
  - @hot-updater/core@0.34.0

## 0.33.2

### Patch Changes

- @hot-updater/core@0.33.2
- @hot-updater/plugin-core@0.33.2

## 0.33.1

### Patch Changes

- Updated dependencies [a5c4467]
  - @hot-updater/plugin-core@0.33.1
  - @hot-updater/core@0.33.1

## 0.33.0

### Patch Changes

- 070a86f: Fix copied bundle promotion to upload Brotli Hermes bundle assets expected by manifest-driven update checks.
- Updated dependencies [e914f56]
  - @hot-updater/plugin-core@0.33.0
  - @hot-updater/core@0.33.0

## 0.32.0

### Patch Changes

- 4e6d2ec: Use deterministic content-addressed storage keys for manifest assets, require storage plugins to implement object existence checks, skip uploads when the object already exists, limit deploy upload concurrency, stream hashing/compression work to reduce memory pressure, and report upload progress through 100%.
- Updated dependencies [4e6d2ec]
  - @hot-updater/plugin-core@0.32.0
  - @hot-updater/core@0.32.0

## 0.31.4

### Patch Changes

- @hot-updater/core@0.31.4
- @hot-updater/plugin-core@0.31.4

## 0.31.3

### Patch Changes

- @hot-updater/core@0.31.3
- @hot-updater/plugin-core@0.31.3

## 0.31.2

### Patch Changes

- @hot-updater/core@0.31.2
- @hot-updater/plugin-core@0.31.2

## 0.31.1

### Patch Changes

- @hot-updater/core@0.31.1
- @hot-updater/plugin-core@0.31.1

## 0.31.0

### Patch Changes

- Updated dependencies [5b0a0f5]
- Updated dependencies [5b0a0f5]
  - @hot-updater/core@0.31.0
  - @hot-updater/plugin-core@0.31.0

## 0.30.12

### Patch Changes

- @hot-updater/plugin-core@0.30.12

## 0.30.11

### Patch Changes

- @hot-updater/plugin-core@0.30.11

## 0.30.10

### Patch Changes

- @hot-updater/plugin-core@0.30.10

## 0.30.9

### Patch Changes

- @hot-updater/plugin-core@0.30.9

## 0.30.8

### Patch Changes

- 6019156: refactor(cli-tools): extract `promoteBundle` from `@hot-updater/console` so it can be reused by the CLI

  `promoteBundle` and `createCopiedBundleArchive` move from `@hot-updater/console`'s server-only `lib/server/promoteBundle.ts` into `@hot-updater/cli-tools`. The console's RPC handler now imports from `@hot-updater/cli-tools`. UUIDv7 helpers (`createUUIDv7`, `extractTimestampFromUUIDv7`, `createUUIDv7WithSameTimestamp`) move to `@hot-updater/plugin-core` since they are generic primitives, not console-specific.

  Pure refactor — no behavior change. Existing test coverage moves with the function. This unblocks an upcoming `hot-updater promote` CLI command that calls the same implementation as the console UI.

- Updated dependencies [6019156]
  - @hot-updater/plugin-core@0.30.8

## 0.30.7

### Patch Changes

- 03fd179: Run the `hot-updater` CLI from native ESM on Node 20 so TypeScript config
  files load through ESM import conditions.

  Require Node.js 20.19.0 or newer for the CLI package surface.

  Run the `hot-updater` CLI bin from the native ESM entrypoint and stop emitting
  a CommonJS build for the CLI entry.

  Bump the `hot-updater` CLI package's vulnerable `kysely` and
  `fast-xml-parser` dependency entries to patched versions without pnpm
  overrides.
  - @hot-updater/plugin-core@0.30.7

## 0.30.6

### Patch Changes

- @hot-updater/plugin-core@0.30.6

## 0.30.5

### Patch Changes

- @hot-updater/plugin-core@0.30.5

## 0.30.4

### Patch Changes

- @hot-updater/plugin-core@0.30.4

## 0.30.3

### Patch Changes

- @hot-updater/plugin-core@0.30.3

## 0.30.2

### Patch Changes

- @hot-updater/plugin-core@0.30.2

## 0.30.1

### Patch Changes

- @hot-updater/plugin-core@0.30.1

## 0.30.0

### Minor Changes

- 83c01c8: fix: keep target cohorts additive to rollout

### Patch Changes

- Updated dependencies [83c01c8]
  - @hot-updater/plugin-core@0.30.0

## 0.29.8

### Patch Changes

- @hot-updater/plugin-core@0.29.8

## 0.29.7

### Patch Changes

- @hot-updater/plugin-core@0.29.7

## 0.29.6

### Patch Changes

- 80cce61: feat(cli): merge init config on re-run
  - @hot-updater/plugin-core@0.29.6

## 0.29.5

### Patch Changes

- Updated dependencies [52208f4]
  - @hot-updater/plugin-core@0.29.5

## 0.29.4

### Patch Changes

- @hot-updater/plugin-core@0.29.4

## 0.29.3

### Patch Changes

- Updated dependencies [d1ffb83]
  - @hot-updater/plugin-core@0.29.3

## 0.29.2

### Patch Changes

- 2a1bc80: fix: node deps bundling
  - @hot-updater/plugin-core@0.29.2

## 0.29.1

### Patch Changes

- @hot-updater/core@0.29.1
- @hot-updater/plugin-core@0.29.1

## 0.29.0

### Minor Changes

- a935992: feat: Rollout feature with control from 1% to 100%

### Patch Changes

- d0fe908: fix(console): rebuild copied bundles with fresh uuidv7 ids
- Updated dependencies [a935992]
- Updated dependencies [d0fe908]
  - @hot-updater/plugin-core@0.29.0
  - @hot-updater/core@0.29.0

## 0.28.0

### Patch Changes

- @hot-updater/core@0.28.0
- @hot-updater/plugin-core@0.28.0

## 0.27.1

### Patch Changes

- @hot-updater/core@0.27.1
- @hot-updater/plugin-core@0.27.1

## 0.27.0

### Minor Changes

- 81f9437: feat(android): for safe reloading, Android reloads the process (#869)

### Patch Changes

- Updated dependencies [81f9437]
  - @hot-updater/core@0.27.0
  - @hot-updater/plugin-core@0.27.0

## 0.26.2

### Patch Changes

- @hot-updater/core@0.26.2
- @hot-updater/plugin-core@0.26.2

## 0.26.1

### Patch Changes

- @hot-updater/core@0.26.1
- @hot-updater/plugin-core@0.26.1

## 0.26.0

### Patch Changes

- @hot-updater/core@0.26.0
- @hot-updater/plugin-core@0.26.0

## 0.25.14

### Patch Changes

- @hot-updater/core@0.25.14
- @hot-updater/plugin-core@0.25.14

## 0.25.13

### Patch Changes

- @hot-updater/core@0.25.13
- @hot-updater/plugin-core@0.25.13

## 0.25.12

### Patch Changes

- @hot-updater/core@0.25.12
- @hot-updater/plugin-core@0.25.12

## 0.25.11

### Patch Changes

- @hot-updater/core@0.25.11
- @hot-updater/plugin-core@0.25.11

## 0.25.10

### Patch Changes

- 90f9610: Improve native build logging stream handling and make iOS child process
  termination on Ctrl+C more reliable.
- Updated dependencies [03c5adc]
  - @hot-updater/plugin-core@0.25.10
  - @hot-updater/core@0.25.10

## 0.25.9

### Patch Changes

- Updated dependencies [6b22072]
  - @hot-updater/plugin-core@0.25.9

## 0.25.8

### Patch Changes

- @hot-updater/plugin-core@0.25.8

## 0.25.7

### Patch Changes

- @hot-updater/plugin-core@0.25.7

## 0.25.6

### Patch Changes

- @hot-updater/plugin-core@0.25.6

## 0.25.5

### Patch Changes

- @hot-updater/plugin-core@0.25.5

## 0.25.4

### Patch Changes

- 8c83ff2: Add support for hot-updater.config.mjs
  - @hot-updater/plugin-core@0.25.4

## 0.25.3

### Patch Changes

- @hot-updater/plugin-core@0.25.3

## 0.25.2

### Patch Changes

- @hot-updater/plugin-core@0.25.2

## 0.25.1

### Patch Changes

- @hot-updater/plugin-core@0.25.1

## 0.25.0

### Patch Changes

- @hot-updater/plugin-core@0.25.0

## 0.24.7

### Patch Changes

- 294e324: fix: update babel plugin path in documentation and plugin files
- Updated dependencies [294e324]
  - @hot-updater/plugin-core@0.24.7

## 0.24.6

### Patch Changes

- 9d7b6af: feat(aws): sso template with fromSSO
  - @hot-updater/plugin-core@0.24.6

## 0.24.5

### Patch Changes

- @hot-updater/plugin-core@0.24.5

## 0.24.4

### Patch Changes

- Updated dependencies [7ed539f]
  - @hot-updater/plugin-core@0.24.4

## 0.24.3

### Patch Changes

- @hot-updater/plugin-core@0.24.3

## 0.24.2

### Patch Changes

- @hot-updater/plugin-core@0.24.2

## 0.24.1

### Patch Changes

- @hot-updater/plugin-core@0.24.1

## 0.24.0

### Patch Changes

- @hot-updater/plugin-core@0.24.0

## 0.23.1

### Patch Changes

- @hot-updater/plugin-core@0.23.1

## 0.23.0

### Patch Changes

- @hot-updater/plugin-core@0.23.0

## 0.22.2

### Patch Changes

- @hot-updater/plugin-core@0.22.2

## 0.22.1

### Patch Changes

- @hot-updater/plugin-core@0.22.1

## 0.22.0

### Patch Changes

- @hot-updater/plugin-core@0.22.0

## 0.21.15

### Patch Changes

- @hot-updater/plugin-core@0.21.15

## 0.21.14

### Patch Changes

- @hot-updater/plugin-core@0.21.14

## 0.21.13

### Patch Changes

- @hot-updater/plugin-core@0.21.13

## 0.21.12

### Patch Changes

- Updated dependencies [5c4b98e]
  - @hot-updater/plugin-core@0.21.12

## 0.21.11

### Patch Changes

- d6c3a65: chore(cli-tools): peerDeps
- e2b67d7: fix(cli-tools): esm only package bundle
- Updated dependencies [e2b67d7]
  - @hot-updater/plugin-core@0.21.11

## 0.21.10

### Patch Changes

- @hot-updater/plugin-core@0.21.10

## 0.21.9

### Patch Changes

- aa399a6: chore: deps picocolors
- Updated dependencies [aa399a6]
  - @hot-updater/plugin-core@0.21.9

## 0.21.8

### Patch Changes

- 3fe8c81: feat(plugin-core): reduced deps for edge-runtime
- Updated dependencies [3fe8c81]
  - @hot-updater/plugin-core@0.21.8
