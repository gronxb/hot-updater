# hot-updater

## 1.0.0-rc.1

### Patch Changes

- 2aeccfb: Allow Doctor to accept package increments within the same prerelease channel.

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

- 88c163a: Align the CLI with the Release Catalog ownership model. Deploy now reports the
  committed Release and Catalog handles, Release commands expose and preview
  policy state, Bundle commands report Release references, missing Catalog
  projections can be rebuilt, and storage pruning safely reclaims unreferenced
  patch objects below live Bundle prefixes.

  Remove the ambiguous top-level Bundle-targeted rollback command. Use
  `hot-updater release disable <release-id>` to roll back an exact Release.

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

- a9ffb2a: Create schema 1.0.0 from empty databases only. `db migrate` and `db generate` no longer accept or upgrade v0 schema markers, and managed SQL templates are a single 1.0.0 CREATE.

### Patch Changes

- 353e1ca: Package the full Console application behind root and `/vite` exports so a thin
  Vite and Nitro host can deploy it with injected runtime configuration and
  authentication. Keep the CLI console unauthenticated but force it to bind to
  the loopback interface.
- c387b0b: Allow independently released Hot Updater packages from the same stable major
  version to pass doctor compatibility checks.
- c06c7df: Restore the plain `#!/usr/bin/env node` shebang on the CLI entry so Yarn Classic generates a working `hot-updater.cmd` shim on Windows.
- c06c7df: Rename the CLI's `init --env-file` option to `init --from-env-file` to avoid Node.js interpreting replay files as its own startup configuration. This keeps the portable shebang required by Yarn Classic on Windows without allowing `NODE_OPTIONS` in a replay file to run preloads before the CLI starts.

  Breaking change: update replay commands to `hot-updater init --from-env-file .env.hotupdater`. The old `--env-file` CLI option is no longer supported. The programmatic `envFile` option is unchanged.

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

- 3b367e7: Split the self-hosted HTTP runtime into mount-relative
  `handlers.client` and `handlers.admin` surfaces. Admin authentication now
  belongs entirely to framework middleware, mounting the admin handler is the
  explicit opt-in, and admin responses are marked private and non-cacheable.

  Move the canonical admin root from `/hot-updater/api` to
  `/hot-updater/admin`. `standaloneRepository.baseUrl` now points directly to
  that root and sends mount-relative Bundle, Release, Release Catalog, Channel,
  and database-commit requests. Managed runtimes mount only the client handler.

  Remove `features`, including `features.bundles`, `features.updateCheck`, and
  `features.clientAccessKeys`, plus Analytics `queryAccess`. The required
  top-level `clientAccess` policy now selects public or API-key authenticated
  client routes. The client handler always owns update routes and Analytics
  ingestion, while Analytics queries move to the admin surface. React Native
  clients independently opt into automatic transition reporting.
  `toNodeHandler` now accepts one handler function. React Native keeps the same
  client `baseURL` and resolves handler-relative storage paths against it,
  removing the server's `basePath` option. Client authentication uses `x-api-key`,
  not an admin bearer token.

  Resolve Expo fingerprint mode from the target app's dependencies so bare React
  Native fingerprints stay stable across monorepo and isolated installs.

- Updated dependencies [3b367e7]
- Updated dependencies [467e5f6]
- Updated dependencies [353e1ca]
- Updated dependencies [b424d47]
- Updated dependencies [3b367e7]
- Updated dependencies [9650748]
- Updated dependencies [88c163a]
- Updated dependencies [a9ffb2a]
- Updated dependencies [a9ffb2a]
- Updated dependencies [5a2e1cd]
- Updated dependencies [adb0e40]
- Updated dependencies [e2455c5]
- Updated dependencies [ebe1f64]
- Updated dependencies [c8e24cd]
- Updated dependencies [25af6ef]
- Updated dependencies [c06c7df]
- Updated dependencies [c355c26]
- Updated dependencies [e494531]
- Updated dependencies [3b367e7]
- Updated dependencies [7ec1a46]
- Updated dependencies [1af8cba]
- Updated dependencies [3b367e7]
- Updated dependencies [86f610b]
- Updated dependencies [a9ffb2a]
- Updated dependencies [a9ffb2a]
  - @hot-updater/plugin-core@1.0.0-rc.0
  - @hot-updater/server@1.0.0-rc.0
  - @hot-updater/console@1.0.0-rc.0
  - @hot-updater/cli-tools@1.0.0-rc.0
  - @hot-updater/aws@1.0.0-rc.0
  - @hot-updater/cloudflare@1.0.0-rc.0
  - @hot-updater/firebase@1.0.0-rc.0
  - @hot-updater/supabase@1.0.0-rc.0
  - @hot-updater/core@1.0.0-rc.0
  - @hot-updater/android-helper@1.0.0-rc.0
  - @hot-updater/apple-helper@1.0.0-rc.0

## 0.36.0

### Minor Changes

- 9759e8a: Reduce S3 management query work by skipping legacy UUIDv7 artifact traversal, deriving channels from canonical manifest keys, and batching multi-bundle deletion scans and commits. Store new bundle artifacts below `bundles/<bundle-id>` while preserving legacy reads, and add exact target app version filters to the CLI and Console. Add an exclusive-maintenance `hot-updater storage prune` command for orphaned bundle objects and unreferenced shared assets, with an explicit `--dry-run` candidate table, a recent-object protection window, and fail-closed reference validation safeguards.

### Patch Changes

- da7de2d: Preserve UUIDv7 S3 channels while avoiding per-prefix legacy traversal, respect
  standalone server pagination limits during storage pruning and batch deletion,
  and document the safe storage cleanup workflow.
- Updated dependencies [9759e8a]
  - @hot-updater/cli-tools@0.36.0
  - @hot-updater/plugin-core@0.36.0
  - @hot-updater/console@0.36.0
  - @hot-updater/server@0.36.0
  - @hot-updater/android-helper@0.36.0
  - @hot-updater/apple-helper@0.36.0
  - @hot-updater/core@0.36.0

## 0.35.12

### Patch Changes

- 6e8b32e: Replace the semver dependency with verkit.
- Updated dependencies [fd30452]
- Updated dependencies [6e8b32e]
  - @hot-updater/cli-tools@0.35.12
  - @hot-updater/console@0.35.12
  - @hot-updater/plugin-core@0.35.12
  - @hot-updater/server@0.35.12
  - @hot-updater/android-helper@0.35.12
  - @hot-updater/apple-helper@0.35.12
  - @hot-updater/core@0.35.12

## 0.35.11

### Patch Changes

- bfbb823: fix: read the iOS app version from Info.plist before project.pbxproj

  `getNativeAppVersion("ios")` tried the `xcodeproj` parser first and only fell back
  to `info-plist`. Parsing project.pbxproj is synchronous, so on a large project it
  blocks the event loop for the whole parse, and `deploy` does this after the bundle
  has already been uploaded, just to fill in `metadata.app_version`. On a 12.5MB
  pbxproj that was ~5 minutes locally and ~16 minutes on CI.

  Info.plist is read first now. `CFBundleShortVersionString` is also closer to what
  the built app actually reports than `MARKETING_VERSION` (#84). The xcodeproj parser
  is still there as a fallback when Info.plist has no version.

- bfbb823: fix: bump the bundled `@bacons/xcode` to 1.0.0-alpha.33

  alpha.24 was published in December 2024 and still uses the old Chevrotain-based
  pbxproj parser. alpha.31 picked up the single-pass rewrite from
  EvanBacon/xcode#37, which is 42x faster on their benchmarks and considerably more
  than that on large files.

  On a 12.5MB `project.pbxproj`, `XcodeProject.open()` goes from 286s and 1.8GB of
  peak RSS down to 0.2s and 285MB, returning the same 48,670 objects. The only API
  used here is `XcodeProject.open().toJSON()` in `getIOSVersion`, which is unchanged
  between the two versions.

- fceb580: fix: fallback to project.pbxproj when Info.plist contains an unresolved build setting
- Updated dependencies [1a3a621]
  - @hot-updater/plugin-core@0.35.11
  - @hot-updater/android-helper@0.35.11
  - @hot-updater/apple-helper@0.35.11
  - @hot-updater/cli-tools@0.35.11
  - @hot-updater/console@0.35.11
  - @hot-updater/server@0.35.11
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
  - @hot-updater/cli-tools@0.35.10
  - @hot-updater/android-helper@0.35.10
  - @hot-updater/apple-helper@0.35.10
  - @hot-updater/console@0.35.10
  - @hot-updater/server@0.35.10
  - @hot-updater/core@0.35.10

## 0.35.9

### Patch Changes

- f9bb26d: Declare init inputs in each provider package through a shared contract, ask
  once before saving credential inputs, and support prompt-free infrastructure
  reconciliation with `init --env-file .env.hotupdater`.
- Updated dependencies [8688b1a]
- Updated dependencies [f9bb26d]
  - @hot-updater/cli-tools@0.35.9
  - @hot-updater/android-helper@0.35.9
  - @hot-updater/apple-helper@0.35.9
  - @hot-updater/console@0.35.9
  - @hot-updater/core@0.35.9
  - @hot-updater/server@0.35.9
  - @hot-updater/plugin-core@0.35.9

## 0.35.8

### Patch Changes

- Updated dependencies [4f9fab2]
  - @hot-updater/cli-tools@0.35.8
  - @hot-updater/android-helper@0.35.8
  - @hot-updater/apple-helper@0.35.8
  - @hot-updater/console@0.35.8
  - @hot-updater/core@0.35.8
  - @hot-updater/server@0.35.8
  - @hot-updater/plugin-core@0.35.8

## 0.35.7

### Patch Changes

- @hot-updater/android-helper@0.35.7
- @hot-updater/apple-helper@0.35.7
- @hot-updater/cli-tools@0.35.7
- @hot-updater/console@0.35.7
- @hot-updater/core@0.35.7
- @hot-updater/server@0.35.7
- @hot-updater/plugin-core@0.35.7

## 0.35.6

### Patch Changes

- @hot-updater/android-helper@0.35.6
- @hot-updater/apple-helper@0.35.6
- @hot-updater/cli-tools@0.35.6
- @hot-updater/console@0.35.6
- @hot-updater/core@0.35.6
- @hot-updater/server@0.35.6
- @hot-updater/plugin-core@0.35.6

## 0.35.5

### Patch Changes

- @hot-updater/android-helper@0.35.5
- @hot-updater/apple-helper@0.35.5
- @hot-updater/cli-tools@0.35.5
- @hot-updater/console@0.35.5
- @hot-updater/core@0.35.5
- @hot-updater/server@0.35.5
- @hot-updater/plugin-core@0.35.5

## 0.35.4

### Patch Changes

- @hot-updater/android-helper@0.35.4
- @hot-updater/apple-helper@0.35.4
- @hot-updater/cli-tools@0.35.4
- @hot-updater/console@0.35.4
- @hot-updater/core@0.35.4
- @hot-updater/server@0.35.4
- @hot-updater/plugin-core@0.35.4

## 0.35.3

### Patch Changes

- @hot-updater/android-helper@0.35.3
- @hot-updater/apple-helper@0.35.3
- @hot-updater/cli-tools@0.35.3
- @hot-updater/console@0.35.3
- @hot-updater/core@0.35.3
- @hot-updater/server@0.35.3
- @hot-updater/plugin-core@0.35.3

## 0.35.2

### Patch Changes

- e3f0962: Add bulk deletion to `hot-updater bundle delete`. The command now accepts multiple bundle ids (`bundle delete <id...>`)
  - @hot-updater/android-helper@0.35.2
  - @hot-updater/apple-helper@0.35.2
  - @hot-updater/cli-tools@0.35.2
  - @hot-updater/console@0.35.2
  - @hot-updater/core@0.35.2
  - @hot-updater/server@0.35.2
  - @hot-updater/plugin-core@0.35.2

## 0.35.1

### Patch Changes

- @hot-updater/android-helper@0.35.1
- @hot-updater/apple-helper@0.35.1
- @hot-updater/cli-tools@0.35.1
- @hot-updater/console@0.35.1
- @hot-updater/core@0.35.1
- @hot-updater/server@0.35.1
- @hot-updater/plugin-core@0.35.1

## 0.35.0

### Minor Changes

- 4e1b86d: Make the `@hot-updater/server` root export runtime-safe, remove the ambiguous `@hot-updater/server/runtime` subpath, keep `@hot-updater/server/node` focused on `toNodeHandler`, and move database generation, migration, and bundle diff APIs to `@hot-updater/server/db`.

### Patch Changes

- Updated dependencies [4e1b86d]
  - @hot-updater/server@0.35.0
  - @hot-updater/console@0.35.0
  - @hot-updater/android-helper@0.35.0
  - @hot-updater/apple-helper@0.35.0
  - @hot-updater/cli-tools@0.35.0
  - @hot-updater/core@0.35.0
  - @hot-updater/plugin-core@0.35.0

## 0.34.0

### Minor Changes

- 8a4a269: feat(hot-updater): add `--provider` and `--build` flags to `init`

  `hot-updater init` always prompts for the build plugin and the provider. These optional flags pre-answer those two prompts so `init` can run without interaction:

  ```
  hot-updater init --provider cloudflare --build expo
  ```

  When a flag is omitted, the prompt is shown as before. Values are validated against the known choices.

  This is aimed at the Cloudflare redeploy flow described in #849: with a populated `.env.hotupdater`, re-running `init` redeploys the worker and applies pending migrations, and these flags remove the two prompts that otherwise block it from running unattended. Providers still prompt for any value that is not already present in `.env.hotupdater`.

### Patch Changes

- 088f6c1: refactor(server): remove fumadb adapter split
- 7244b65: Fix standalone database generation for provider SQL output and generated schema regeneration, and centralize the generated DB schema artifact contract.
- Updated dependencies [088f6c1]
- Updated dependencies [7244b65]
  - @hot-updater/server@0.34.0
  - @hot-updater/plugin-core@0.34.0
  - @hot-updater/core@0.34.0
  - @hot-updater/console@0.34.0
  - @hot-updater/android-helper@0.34.0
  - @hot-updater/apple-helper@0.34.0
  - @hot-updater/cli-tools@0.34.0

## 0.33.2

### Patch Changes

- @hot-updater/android-helper@0.33.2
- @hot-updater/apple-helper@0.33.2
- @hot-updater/cli-tools@0.33.2
- @hot-updater/console@0.33.2
- @hot-updater/core@0.33.2
- @hot-updater/server@0.33.2
- @hot-updater/plugin-core@0.33.2

## 0.33.1

### Patch Changes

- Updated dependencies [a5c4467]
  - @hot-updater/console@0.33.1
  - @hot-updater/plugin-core@0.33.1
  - @hot-updater/server@0.33.1
  - @hot-updater/android-helper@0.33.1
  - @hot-updater/apple-helper@0.33.1
  - @hot-updater/cli-tools@0.33.1
  - @hot-updater/core@0.33.1

## 0.33.0

### Minor Changes

- 0eb4639: Unify doctor infrastructure update targets so runtime and migration requirements share one version target source.

### Patch Changes

- e914f56: Avoid redundant provider bundle reads during update checks and teach doctor to flag server runtime redeploy requirements.
- Updated dependencies [070a86f]
- Updated dependencies [e914f56]
- Updated dependencies [2b9944a]
  - @hot-updater/cli-tools@0.33.0
  - @hot-updater/server@0.33.0
  - @hot-updater/plugin-core@0.33.0
  - @hot-updater/console@0.33.0
  - @hot-updater/android-helper@0.33.0
  - @hot-updater/apple-helper@0.33.0
  - @hot-updater/core@0.33.0

## 0.32.0

### Patch Changes

- 4e6d2ec: Use deterministic content-addressed storage keys for manifest assets, require storage plugins to implement object existence checks, skip uploads when the object already exists, limit deploy upload concurrency, stream hashing/compression work to reduce memory pressure, and report upload progress through 100%.
- c6d10fc: fix(fingerprint): load `@expo/fingerprint` as an optional peer dependency for fingerprint commands
- 8e87b5f: Harden Supabase init by enabling RLS for Hot Updater tables, pinning
  Supabase function search paths, and generating service-role env naming while
  failing skipped legacy configs before writing the service-role env key.
- Updated dependencies [4e6d2ec]
- Updated dependencies [499e139]
  - @hot-updater/cli-tools@0.32.0
  - @hot-updater/console@0.32.0
  - @hot-updater/plugin-core@0.32.0
  - @hot-updater/server@0.32.0
  - @hot-updater/android-helper@0.32.0
  - @hot-updater/apple-helper@0.32.0
  - @hot-updater/core@0.32.0

## 0.31.4

### Patch Changes

- @hot-updater/android-helper@0.31.4
- @hot-updater/apple-helper@0.31.4
- @hot-updater/cli-tools@0.31.4
- @hot-updater/console@0.31.4
- @hot-updater/core@0.31.4
- @hot-updater/server@0.31.4
- @hot-updater/plugin-core@0.31.4

## 0.31.3

### Patch Changes

- d5d9c48: fix(hot-updater): match patch bases by semver compatibility
  - @hot-updater/android-helper@0.31.3
  - @hot-updater/apple-helper@0.31.3
  - @hot-updater/cli-tools@0.31.3
  - @hot-updater/console@0.31.3
  - @hot-updater/core@0.31.3
  - @hot-updater/server@0.31.3
  - @hot-updater/plugin-core@0.31.3

## 0.31.2

### Patch Changes

- fe365ef: Bundle CLI-only dependencies so Expo projects do not install a duplicate
  `@expo/fingerprint` through `hot-updater`.
- 0084a78: tree-shake sql-formatter dialects
  - @hot-updater/android-helper@0.31.2
  - @hot-updater/apple-helper@0.31.2
  - @hot-updater/cli-tools@0.31.2
  - @hot-updater/console@0.31.2
  - @hot-updater/core@0.31.2
  - @hot-updater/server@0.31.2
  - @hot-updater/plugin-core@0.31.2

## 0.31.1

### Patch Changes

- 8eb21d7: Check native OTA wiring in doctor
  - @hot-updater/android-helper@0.31.1
  - @hot-updater/apple-helper@0.31.1
  - @hot-updater/cli-tools@0.31.1
  - @hot-updater/console@0.31.1
  - @hot-updater/core@0.31.1
  - @hot-updater/server@0.31.1
  - @hot-updater/plugin-core@0.31.1

## 0.31.0

### Minor Changes

- 5b0a0f5: Add signed manifest-based diff update support across deploy, server, provider storage, console tooling, and React Native runtime.

### Patch Changes

- 5b0a0f5: Add CLI bundle inspection and metadata mutation commands for automation:
  `bundle show`, `bundle update`, and `bundle delete`.
- Updated dependencies [5b0a0f5]
- Updated dependencies [5b0a0f5]
  - @hot-updater/core@0.31.0
  - @hot-updater/console@0.31.0
  - @hot-updater/server@0.31.0
  - @hot-updater/android-helper@0.31.0
  - @hot-updater/cli-tools@0.31.0
  - @hot-updater/plugin-core@0.31.0
  - @hot-updater/apple-helper@0.31.0

## 0.30.12

### Patch Changes

- @hot-updater/android-helper@0.30.12
- @hot-updater/apple-helper@0.30.12
- @hot-updater/cli-tools@0.30.12
- @hot-updater/console@0.30.12
- @hot-updater/core@0.30.12
- @hot-updater/server@0.30.12
- @hot-updater/plugin-core@0.30.12

## 0.30.11

### Patch Changes

- eb32048: fix(cli): `deploy` falls back to the auto-detected target app version in non-interactive mode

  Previously, running `hot-updater deploy` without `-t` and without `-i` errored with
  "Target app version not found", even though `getDefaultTargetAppVersion` had already
  extracted the version from the binary's native files (Info.plist for iOS, build.gradle
  for Android) for use as the interactive prompt's placeholder. CI deploys had to
  either pass `-t` explicitly or scrape the version out of package.json.

  Now the resolution order is: explicit `-t` → interactive prompt (with the auto-detected
  value as placeholder) → auto-detected default → clear error if the native config is
  unreadable. Existing `-t` and `-i` invocations are unchanged.
  - @hot-updater/android-helper@0.30.11
  - @hot-updater/apple-helper@0.30.11
  - @hot-updater/cli-tools@0.30.11
  - @hot-updater/console@0.30.11
  - @hot-updater/core@0.30.11
  - @hot-updater/server@0.30.11
  - @hot-updater/plugin-core@0.30.11

## 0.30.10

### Patch Changes

- 677271a: feat(cli): `deploy` runs both platforms when `-p` is omitted

  `hot-updater deploy` (without `-p ios` or `-p android`) now deploys ios then android sequentially. If ios fails, android is not attempted — the channel is never left half-updated. This is the typical CI/CD invocation pattern.

  ```
  hot-updater deploy -c dev               # ios + android, sequential, abort-on-first-failure
  hot-updater deploy -p ios -c dev        # unchanged: single platform
  hot-updater deploy -i -c dev            # unchanged: interactive prompt for one platform
  ```

  Existing `-p ios` / `-p android` invocations are unchanged; `-i` (interactive) still prompts for a single platform. The change is purely in the no-`-p`-no-`-i` path, which previously errored with "Platform not found" — that error path is now the multi-platform deploy.

- fb780c1: feat(cli): add `bundle promote` command

  Move or copy a bundle to a different channel from the CLI, mirroring the console's Promote-to-Channel UI.

  ```
  hot-updater bundle promote <bundle-id> -t <target-channel> [-a copy|move] [-y]
  ```

  - The bundle id is positional — the bundle carries its own source channel, so no `--source` flag is needed.
  - `--action copy` (default) creates a new bundle id on the target channel and leaves the original in place — CodePush-promote semantics.
  - `--action move` updates the bundle's `channel` column without creating a new bundle (D1-only mutation; no R2 work).
  - Wraps the `promoteBundle` function from `@hot-updater/cli-tools`, so the CLI and console use one implementation. Surfaces the underlying `LEGACY_BUNDLE_ERROR` and signing/storage configuration errors directly.

  Pre-flight: rejects bundle-already-on-target, missing bundle id, empty target. Refuses to mutate without `-y` in a non-TTY shell. Lives under the `bundle` namespace alongside `bundle list/disable/enable` since the noun being mutated is the bundle (its channel attribute, or a copy of it).

- 014430a: fix(cli): make multi-platform deploy a first-class flow

  `hot-updater deploy` now handles the no-`-p` path inside the deploy command
  itself instead of looping from the CLI entrypoint. This keeps the banner and
  success output consistent, makes it explicit that iOS and Android are deployed
  sequentially, and writes local bundle archives to platform-specific output
  directories so one platform no longer overwrites the other.
  - @hot-updater/android-helper@0.30.10
  - @hot-updater/apple-helper@0.30.10
  - @hot-updater/cli-tools@0.30.10
  - @hot-updater/console@0.30.10
  - @hot-updater/core@0.30.10
  - @hot-updater/server@0.30.10
  - @hot-updater/plugin-core@0.30.10

## 0.30.9

### Patch Changes

- @hot-updater/android-helper@0.30.9
- @hot-updater/apple-helper@0.30.9
- @hot-updater/cli-tools@0.30.9
- @hot-updater/console@0.30.9
- @hot-updater/core@0.30.9
- @hot-updater/server@0.30.9
- @hot-updater/plugin-core@0.30.9

## 0.30.8

### Patch Changes

- 655b97c: feat(cli): add `bundle list/disable/enable` commands

  Adds three subcommands under a new top-level `bundle` namespace:
  - `hot-updater bundle list [-c <channel>] [-p <ios|android>] [--limit <n>]` — tabulated listing of bundles, most recent first. `--limit` validation uses commander's idiomatic `InvalidArgumentError` shape.
  - `hot-updater bundle disable <bundle-id> [-y]` — disable a single bundle. Refuses to mutate without `-y` in a non-TTY shell. Re-reads the bundle after `commitBundle` and exits non-zero if the change did not take effect; treats a mid-flight deletion as success.
  - `hot-updater bundle enable <bundle-id> [-y]` — re-enable a previously disabled bundle.

  All three commands load config via `loadConfig(null)` (matching the `console` command's idiom) since they are not platform-scoped operations. They use the existing `DatabasePlugin` interface (`getBundles`, `getBundleById`, `updateBundle`, `commitBundle`), so they work against every supported provider with no plugin-side changes. The `--platform` option is the shared `platformCommandOption` already used by `deploy`. `onUnmount` is wrapped in its own try/catch so cleanup errors never mask the originating mutation error. Help text documents the read-mutate-verify contract and exit codes (0 = success, 1 = error, 2 = user-aborted).

- 8318094: feat(cli): add `rollback <channel>` command

  Disables the most recent enabled bundle on a channel for each requested platform.

  ```
  hot-updater rollback <channel> [-p ios|android] [-y] [--confirm-revert-to-binary] [--target <bundle-id>]
  ```

  Behavior:
  - **Read phase** loads up to two most-recent enabled bundles per (channel, platform) so the operator can see what would become active after rollback.
  - **Validate phase** refuses with non-zero exit if any (channel, platform) would have **no** enabled bundles after the rollback unless `--confirm-revert-to-binary` is passed. The error message names both safe escape hatches in priority order: `-p <unaffected>` first, then `--confirm-revert-to-binary`.
  - **Mutate phase** queues `updateBundle({ enabled: false })` for each target and commits once. Note: `DatabasePlugin.commitBundle` runs ops sequentially in the underlying provider, so atomicity across platforms is **not** guaranteed. The mutate is wrapped in a try/catch so a mid-commit throw still falls through to the verify phase.
  - **Verify phase** re-reads each target. Distinguishes three states — disabled (success), still-enabled (failure), and gone (success: a deleted bundle satisfies the rollback intent). Surfaces partial-failure state explicitly with non-zero exit and per-platform `FAILED` lines naming the exact retry command, including a `--target <bundle-id>` flag for scoped retry.

  Refuses to mutate without `-y` in a non-TTY shell. `onUnmount` is wrapped in its own try/catch so cleanup errors never mask the originating mutation error. Help text documents the four-phase contract and exit codes (0 = success, 1 = error, 2 = user-aborted).

- deff7ab: feat(cli): cli design system
- 8318094: Feature - CLI Rollback
- Updated dependencies [6019156]
  - @hot-updater/cli-tools@0.30.8
  - @hot-updater/plugin-core@0.30.8
  - @hot-updater/console@0.30.8
  - @hot-updater/android-helper@0.30.8
  - @hot-updater/apple-helper@0.30.8
  - @hot-updater/server@0.30.8
  - @hot-updater/core@0.30.8

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

- Updated dependencies [03fd179]
  - @hot-updater/apple-helper@0.30.7
  - @hot-updater/cli-tools@0.30.7
  - @hot-updater/android-helper@0.30.7
  - @hot-updater/console@0.30.7
  - @hot-updater/core@0.30.7
  - @hot-updater/server@0.30.7
  - @hot-updater/plugin-core@0.30.7

## 0.30.6

### Patch Changes

- 82de1c6: fix(deps): widen `@expo/fingerprint` to caret range to allow dedupe with Expo SDK
  - @hot-updater/android-helper@0.30.6
  - @hot-updater/apple-helper@0.30.6
  - @hot-updater/cli-tools@0.30.6
  - @hot-updater/console@0.30.6
  - @hot-updater/core@0.30.6
  - @hot-updater/server@0.30.6
  - @hot-updater/plugin-core@0.30.6

## 0.30.5

### Patch Changes

- @hot-updater/android-helper@0.30.5
- @hot-updater/apple-helper@0.30.5
- @hot-updater/cli-tools@0.30.5
- @hot-updater/console@0.30.5
- @hot-updater/core@0.30.5
- @hot-updater/server@0.30.5
- @hot-updater/plugin-core@0.30.5

## 0.30.4

### Patch Changes

- @hot-updater/android-helper@0.30.4
- @hot-updater/apple-helper@0.30.4
- @hot-updater/cli-tools@0.30.4
- @hot-updater/console@0.30.4
- @hot-updater/core@0.30.4
- @hot-updater/server@0.30.4
- @hot-updater/plugin-core@0.30.4

## 0.30.3

### Patch Changes

- @hot-updater/android-helper@0.30.3
- @hot-updater/apple-helper@0.30.3
- @hot-updater/cli-tools@0.30.3
- @hot-updater/console@0.30.3
- @hot-updater/core@0.30.3
- @hot-updater/server@0.30.3
- @hot-updater/plugin-core@0.30.3

## 0.30.2

### Patch Changes

- @hot-updater/android-helper@0.30.2
- @hot-updater/apple-helper@0.30.2
- @hot-updater/cli-tools@0.30.2
- @hot-updater/console@0.30.2
- @hot-updater/core@0.30.2
- @hot-updater/server@0.30.2
- @hot-updater/plugin-core@0.30.2

## 0.30.1

### Patch Changes

- 5a7cb26: feat(cli): check infra in hot-updater doctor
- Updated dependencies [35b8720]
  - @hot-updater/console@0.30.1
  - @hot-updater/android-helper@0.30.1
  - @hot-updater/apple-helper@0.30.1
  - @hot-updater/cli-tools@0.30.1
  - @hot-updater/core@0.30.1
  - @hot-updater/server@0.30.1
  - @hot-updater/plugin-core@0.30.1

## 0.30.0

### Minor Changes

- 83c01c8: fix: keep target cohorts additive to rollout

### Patch Changes

- Updated dependencies [83c01c8]
  - @hot-updater/console@0.30.0
  - @hot-updater/server@0.30.0
  - @hot-updater/core@0.30.0
  - @hot-updater/android-helper@0.30.0
  - @hot-updater/apple-helper@0.30.0
  - @hot-updater/cli-tools@0.30.0
  - @hot-updater/plugin-core@0.30.0

## 0.29.8

### Patch Changes

- Updated dependencies [28e14aa]
  - @hot-updater/console@0.29.8
  - @hot-updater/android-helper@0.29.8
  - @hot-updater/apple-helper@0.29.8
  - @hot-updater/cli-tools@0.29.8
  - @hot-updater/core@0.29.8
  - @hot-updater/server@0.29.8
  - @hot-updater/plugin-core@0.29.8

## 0.29.7

### Patch Changes

- @hot-updater/android-helper@0.29.7
- @hot-updater/apple-helper@0.29.7
- @hot-updater/cli-tools@0.29.7
- @hot-updater/console@0.29.7
- @hot-updater/core@0.29.7
- @hot-updater/server@0.29.7
- @hot-updater/plugin-core@0.29.7

## 0.29.6

### Patch Changes

- 5a2d37c: Fix the local `fix-ci` runner so the integration step finishes cleanly after
  background emulator processes exit.
- Updated dependencies [80cce61]
  - @hot-updater/cli-tools@0.29.6
  - @hot-updater/android-helper@0.29.6
  - @hot-updater/apple-helper@0.29.6
  - @hot-updater/console@0.29.6
  - @hot-updater/core@0.29.6
  - @hot-updater/server@0.29.6
  - @hot-updater/plugin-core@0.29.6

## 0.29.5

### Patch Changes

- Updated dependencies [52208f4]
  - @hot-updater/server@0.29.5
  - @hot-updater/plugin-core@0.29.5
  - @hot-updater/android-helper@0.29.5
  - @hot-updater/apple-helper@0.29.5
  - @hot-updater/cli-tools@0.29.5
  - @hot-updater/console@0.29.5
  - @hot-updater/core@0.29.5

## 0.29.4

### Patch Changes

- @hot-updater/android-helper@0.29.4
- @hot-updater/apple-helper@0.29.4
- @hot-updater/cli-tools@0.29.4
- @hot-updater/console@0.29.4
- @hot-updater/core@0.29.4
- @hot-updater/server@0.29.4
- @hot-updater/plugin-core@0.29.4

## 0.29.3

### Patch Changes

- ca2e17d: refactor(cli): deploy log align print
- Updated dependencies [d1ffb83]
  - @hot-updater/plugin-core@0.29.3
  - @hot-updater/console@0.29.3
  - @hot-updater/server@0.29.3
  - @hot-updater/android-helper@0.29.3
  - @hot-updater/apple-helper@0.29.3
  - @hot-updater/cli-tools@0.29.3
  - @hot-updater/core@0.29.3

## 0.29.2

### Patch Changes

- 2a1bc80: fix: node deps bundling
- Updated dependencies [2a1bc80]
  - @hot-updater/cli-tools@0.29.2
  - @hot-updater/core@0.29.2
  - @hot-updater/server@0.29.2
  - @hot-updater/plugin-core@0.29.2
  - @hot-updater/android-helper@0.29.2
  - @hot-updater/apple-helper@0.29.2
  - @hot-updater/console@0.29.2

## 0.29.1

### Patch Changes

- @hot-updater/android-helper@0.29.1
- @hot-updater/apple-helper@0.29.1
- @hot-updater/cli-tools@0.29.1
- @hot-updater/console@0.29.1
- @hot-updater/core@0.29.1
- @hot-updater/server@0.29.1
- @hot-updater/plugin-core@0.29.1

## 0.29.0

### Minor Changes

- a935992: feat: Rollout feature with control from 1% to 100%

### Patch Changes

- d0fe908: fix(console): rebuild copied bundles with fresh uuidv7 ids
- Updated dependencies [a935992]
- Updated dependencies [d0fe908]
- Updated dependencies [a935992]
  - @hot-updater/plugin-core@0.29.0
  - @hot-updater/cli-tools@0.29.0
  - @hot-updater/console@0.29.0
  - @hot-updater/server@0.29.0
  - @hot-updater/core@0.29.0
  - @hot-updater/android-helper@0.29.0
  - @hot-updater/apple-helper@0.29.0

## 0.28.0

### Patch Changes

- @hot-updater/android-helper@0.28.0
- @hot-updater/apple-helper@0.28.0
- @hot-updater/cli-tools@0.28.0
- @hot-updater/console@0.28.0
- @hot-updater/core@0.28.0
- @hot-updater/server@0.28.0
- @hot-updater/plugin-core@0.28.0

## 0.27.1

### Patch Changes

- @hot-updater/server@0.27.1
- @hot-updater/android-helper@0.27.1
- @hot-updater/apple-helper@0.27.1
- @hot-updater/cli-tools@0.27.1
- @hot-updater/console@0.27.1
- @hot-updater/core@0.27.1
- @hot-updater/plugin-core@0.27.1

## 0.27.0

### Minor Changes

- 81f9437: feat(android): for safe reloading, Android reloads the process (#869)

### Patch Changes

- Updated dependencies [81f9437]
  - @hot-updater/android-helper@0.27.0
  - @hot-updater/apple-helper@0.27.0
  - @hot-updater/cli-tools@0.27.0
  - @hot-updater/console@0.27.0
  - @hot-updater/core@0.27.0
  - @hot-updater/server@0.27.0
  - @hot-updater/plugin-core@0.27.0

## 0.26.2

### Patch Changes

- @hot-updater/server@0.26.2
- @hot-updater/android-helper@0.26.2
- @hot-updater/apple-helper@0.26.2
- @hot-updater/cli-tools@0.26.2
- @hot-updater/console@0.26.2
- @hot-updater/core@0.26.2
- @hot-updater/plugin-core@0.26.2

## 0.26.1

### Patch Changes

- @hot-updater/android-helper@0.26.1
- @hot-updater/apple-helper@0.26.1
- @hot-updater/cli-tools@0.26.1
- @hot-updater/console@0.26.1
- @hot-updater/core@0.26.1
- @hot-updater/server@0.26.1
- @hot-updater/plugin-core@0.26.1

## 0.26.0

### Patch Changes

- @hot-updater/android-helper@0.26.0
- @hot-updater/apple-helper@0.26.0
- @hot-updater/cli-tools@0.26.0
- @hot-updater/console@0.26.0
- @hot-updater/core@0.26.0
- @hot-updater/server@0.26.0
- @hot-updater/plugin-core@0.26.0

## 0.25.14

### Patch Changes

- @hot-updater/server@0.25.14
- @hot-updater/android-helper@0.25.14
- @hot-updater/apple-helper@0.25.14
- @hot-updater/cli-tools@0.25.14
- @hot-updater/console@0.25.14
- @hot-updater/core@0.25.14
- @hot-updater/plugin-core@0.25.14

## 0.25.13

### Patch Changes

- 169b019: chore: bump fast-xml-parser
- Updated dependencies [169b019]
  - @hot-updater/apple-helper@0.25.13
  - @hot-updater/android-helper@0.25.13
  - @hot-updater/cli-tools@0.25.13
  - @hot-updater/console@0.25.13
  - @hot-updater/core@0.25.13
  - @hot-updater/server@0.25.13
  - @hot-updater/plugin-core@0.25.13

## 0.25.12

### Patch Changes

- 38b2af0: fix(expo): android template SDK 55
  - @hot-updater/android-helper@0.25.12
  - @hot-updater/apple-helper@0.25.12
  - @hot-updater/cli-tools@0.25.12
  - @hot-updater/console@0.25.12
  - @hot-updater/core@0.25.12
  - @hot-updater/server@0.25.12
  - @hot-updater/plugin-core@0.25.12

## 0.25.11

### Patch Changes

- @hot-updater/android-helper@0.25.11
- @hot-updater/apple-helper@0.25.11
- @hot-updater/cli-tools@0.25.11
- @hot-updater/console@0.25.11
- @hot-updater/core@0.25.11
- @hot-updater/server@0.25.11
- @hot-updater/plugin-core@0.25.11

## 0.25.10

### Patch Changes

- Updated dependencies [90f9610]
- Updated dependencies [03c5adc]
  - @hot-updater/android-helper@0.25.10
  - @hot-updater/apple-helper@0.25.10
  - @hot-updater/cli-tools@0.25.10
  - @hot-updater/plugin-core@0.25.10
  - @hot-updater/console@0.25.10
  - @hot-updater/server@0.25.10
  - @hot-updater/core@0.25.10

## 0.25.9

### Patch Changes

- 6b22072: Change the default value of `podInstalls` option in iOS native build scheme to `false`
- Updated dependencies [6b22072]
  - @hot-updater/apple-helper@0.25.9
  - @hot-updater/plugin-core@0.25.9
  - @hot-updater/android-helper@0.25.9
  - @hot-updater/cli-tools@0.25.9
  - @hot-updater/console@0.25.9
  - @hot-updater/server@0.25.9
  - @hot-updater/core@0.25.9

## 0.25.8

### Patch Changes

- @hot-updater/android-helper@0.25.8
- @hot-updater/apple-helper@0.25.8
- @hot-updater/cli-tools@0.25.8
- @hot-updater/console@0.25.8
- @hot-updater/core@0.25.8
- @hot-updater/server@0.25.8
- @hot-updater/plugin-core@0.25.8

## 0.25.7

### Patch Changes

- @hot-updater/android-helper@0.25.7
- @hot-updater/apple-helper@0.25.7
- @hot-updater/cli-tools@0.25.7
- @hot-updater/console@0.25.7
- @hot-updater/core@0.25.7
- @hot-updater/server@0.25.7
- @hot-updater/plugin-core@0.25.7

## 0.25.6

### Patch Changes

- c7a0cc5: fix(cli): even though "provider: 'mysql'" is configured, the error still shows the dialect as postgresql
  - @hot-updater/android-helper@0.25.6
  - @hot-updater/apple-helper@0.25.6
  - @hot-updater/cli-tools@0.25.6
  - @hot-updater/console@0.25.6
  - @hot-updater/core@0.25.6
  - @hot-updater/server@0.25.6
  - @hot-updater/plugin-core@0.25.6

## 0.25.5

### Patch Changes

- 8041bab: fix(cli): function parse$4 expects an xml, but some inputs come as binary as well
  - @hot-updater/android-helper@0.25.5
  - @hot-updater/apple-helper@0.25.5
  - @hot-updater/cli-tools@0.25.5
  - @hot-updater/console@0.25.5
  - @hot-updater/core@0.25.5
  - @hot-updater/server@0.25.5
  - @hot-updater/plugin-core@0.25.5

## 0.25.4

### Patch Changes

- Updated dependencies [8c83ff2]
  - @hot-updater/cli-tools@0.25.4
  - @hot-updater/console@0.25.4
  - @hot-updater/server@0.25.4
  - @hot-updater/core@0.25.4
  - @hot-updater/plugin-core@0.25.4

## 0.25.3

### Patch Changes

- cddc20f: feat: add critical conflict check for expo-updates
  - @hot-updater/cli-tools@0.25.3
  - @hot-updater/console@0.25.3
  - @hot-updater/core@0.25.3
  - @hot-updater/server@0.25.3
  - @hot-updater/plugin-core@0.25.3

## 0.25.2

### Patch Changes

- @hot-updater/cli-tools@0.25.2
- @hot-updater/console@0.25.2
- @hot-updater/core@0.25.2
- @hot-updater/server@0.25.2
- @hot-updater/plugin-core@0.25.2

## 0.25.1

### Patch Changes

- @hot-updater/cli-tools@0.25.1
- @hot-updater/console@0.25.1
- @hot-updater/core@0.25.1
- @hot-updater/server@0.25.1
- @hot-updater/plugin-core@0.25.1

## 0.25.0

### Minor Changes

- d22b48a: feat(expo): expo 'use dom' correct ota update

### Patch Changes

- @hot-updater/cli-tools@0.25.0
- @hot-updater/console@0.25.0
- @hot-updater/core@0.25.0
- @hot-updater/server@0.25.0
- @hot-updater/plugin-core@0.25.0

## 0.24.7

### Patch Changes

- 294e324: fix: update babel plugin path in documentation and plugin files
- Updated dependencies [294e324]
  - @hot-updater/cli-tools@0.24.7
  - @hot-updater/console@0.24.7
  - @hot-updater/core@0.24.7
  - @hot-updater/server@0.24.7
  - @hot-updater/plugin-core@0.24.7

## 0.24.6

### Patch Changes

- 9d7b6af: feat(aws): sso template with fromSSO
- 962ecdd: fix(expo): fingerprint autolinking for expo
- Updated dependencies [9d7b6af]
  - @hot-updater/cli-tools@0.24.6
  - @hot-updater/console@0.24.6
  - @hot-updater/server@0.24.6
  - @hot-updater/core@0.24.6
  - @hot-updater/plugin-core@0.24.6

## 0.24.5

### Patch Changes

- f755c3c: Add build\* to default fingerprint ignore paths
  - @hot-updater/cli-tools@0.24.5
  - @hot-updater/console@0.24.5
  - @hot-updater/core@0.24.5
  - @hot-updater/server@0.24.5
  - @hot-updater/plugin-core@0.24.5

## 0.24.4

### Patch Changes

- Updated dependencies [7ed539f]
  - @hot-updater/plugin-core@0.24.4
  - @hot-updater/cli-tools@0.24.4
  - @hot-updater/console@0.24.4
  - @hot-updater/server@0.24.4
  - @hot-updater/core@0.24.4

## 0.24.3

### Patch Changes

- @hot-updater/cli-tools@0.24.3
- @hot-updater/console@0.24.3
- @hot-updater/core@0.24.3
- @hot-updater/server@0.24.3
- @hot-updater/plugin-core@0.24.3

## 0.24.2

### Patch Changes

- @hot-updater/cli-tools@0.24.2
- @hot-updater/console@0.24.2
- @hot-updater/core@0.24.2
- @hot-updater/server@0.24.2
- @hot-updater/plugin-core@0.24.2

## 0.24.1

### Patch Changes

- @hot-updater/cli-tools@0.24.1
- @hot-updater/console@0.24.1
- @hot-updater/core@0.24.1
- @hot-updater/server@0.24.1
- @hot-updater/plugin-core@0.24.1

## 0.24.0

### Patch Changes

- @hot-updater/cli-tools@0.24.0
- @hot-updater/console@0.24.0
- @hot-updater/core@0.24.0
- @hot-updater/server@0.24.0
- @hot-updater/plugin-core@0.24.0

## 0.23.1

### Patch Changes

- 7fa9a20: feat(expo): bundle-signing supports cng plugin
  - @hot-updater/cli-tools@0.23.1
  - @hot-updater/console@0.23.1
  - @hot-updater/core@0.23.1
  - @hot-updater/server@0.23.1
  - @hot-updater/plugin-core@0.23.1

## 0.23.0

### Minor Changes

- e41fb6b: feat: add bundle signing for cryptographic OTA verification

### Patch Changes

- Updated dependencies [e41fb6b]
  - @hot-updater/core@0.23.0
  - @hot-updater/console@0.23.0
  - @hot-updater/server@0.23.0
  - @hot-updater/plugin-core@0.23.0
  - @hot-updater/cli-tools@0.23.0

## 0.22.2

### Patch Changes

- @hot-updater/cli-tools@0.22.2
- @hot-updater/console@0.22.2
- @hot-updater/core@0.22.2
- @hot-updater/server@0.22.2
- @hot-updater/aws@0.22.2
- @hot-updater/cloudflare@0.22.2
- @hot-updater/firebase@0.22.2
- @hot-updater/plugin-core@0.22.2
- @hot-updater/supabase@0.22.2

## 0.22.1

### Patch Changes

- Updated dependencies [422bf89]
  - @hot-updater/console@0.22.1
  - @hot-updater/cli-tools@0.22.1
  - @hot-updater/core@0.22.1
  - @hot-updater/server@0.22.1
  - @hot-updater/aws@0.22.1
  - @hot-updater/cloudflare@0.22.1
  - @hot-updater/firebase@0.22.1
  - @hot-updater/plugin-core@0.22.1
  - @hot-updater/supabase@0.22.1

## 0.22.0

### Patch Changes

- Updated dependencies [32ad614]
  - @hot-updater/server@0.22.0
  - @hot-updater/cli-tools@0.22.0
  - @hot-updater/console@0.22.0
  - @hot-updater/core@0.22.0
  - @hot-updater/aws@0.22.0
  - @hot-updater/cloudflare@0.22.0
  - @hot-updater/firebase@0.22.0
  - @hot-updater/plugin-core@0.22.0
  - @hot-updater/supabase@0.22.0

## 0.21.15

### Patch Changes

- Updated dependencies [a169f06]
  - @hot-updater/server@0.21.15
  - @hot-updater/cli-tools@0.21.15
  - @hot-updater/aws@0.21.15
  - @hot-updater/cloudflare@0.21.15
  - @hot-updater/firebase@0.21.15
  - @hot-updater/plugin-core@0.21.15
  - @hot-updater/console@0.21.15
  - @hot-updater/core@0.21.15
  - @hot-updater/supabase@0.21.15

## 0.21.14

### Patch Changes

- @hot-updater/cli-tools@0.21.14
- @hot-updater/console@0.21.14
- @hot-updater/core@0.21.14
- @hot-updater/server@0.21.14
- @hot-updater/aws@0.21.14
- @hot-updater/cloudflare@0.21.14
- @hot-updater/firebase@0.21.14
- @hot-updater/plugin-core@0.21.14
- @hot-updater/supabase@0.21.14

## 0.21.13

### Patch Changes

- 44f4e95: Fix processing of directory glob patterns on extraSources
  - @hot-updater/cli-tools@0.21.13
  - @hot-updater/console@0.21.13
  - @hot-updater/core@0.21.13
  - @hot-updater/server@0.21.13
  - @hot-updater/aws@0.21.13
  - @hot-updater/cloudflare@0.21.13
  - @hot-updater/firebase@0.21.13
  - @hot-updater/plugin-core@0.21.13
  - @hot-updater/supabase@0.21.13

## 0.21.12

### Patch Changes

- 56e849b: chore(server): storagePlugins to storages
- Updated dependencies [56e849b]
- Updated dependencies [5c4b98e]
  - @hot-updater/server@0.21.12
  - @hot-updater/plugin-core@0.21.12
  - @hot-updater/cloudflare@0.21.12
  - @hot-updater/firebase@0.21.12
  - @hot-updater/supabase@0.21.12
  - @hot-updater/aws@0.21.12
  - @hot-updater/cli-tools@0.21.12
  - @hot-updater/console@0.21.12
  - @hot-updater/core@0.21.12

## 0.21.11

### Patch Changes

- e2b67d7: fix(cli-tools): esm only package bundle
- 2905e47: feat(server): supports hot-updater database plugin style
- Updated dependencies [d6c3a65]
- Updated dependencies [7ee2830]
- Updated dependencies [e2b67d7]
- Updated dependencies [2905e47]
  - @hot-updater/cli-tools@0.21.11
  - @hot-updater/server@0.21.11
  - @hot-updater/console@0.21.11
  - @hot-updater/core@0.21.11
  - @hot-updater/aws@0.21.11
  - @hot-updater/cloudflare@0.21.11
  - @hot-updater/firebase@0.21.11
  - @hot-updater/plugin-core@0.21.11
  - @hot-updater/supabase@0.21.11

## 0.21.10

### Patch Changes

- Updated dependencies [5289b17]
  - @hot-updater/server@0.21.10
  - @hot-updater/cli-tools@0.21.10
  - @hot-updater/aws@0.21.10
  - @hot-updater/cloudflare@0.21.10
  - @hot-updater/firebase@0.21.10
  - @hot-updater/plugin-core@0.21.10
  - @hot-updater/console@0.21.10
  - @hot-updater/core@0.21.10
  - @hot-updater/supabase@0.21.10

## 0.21.9

### Patch Changes

- 396ae54: feat(cli): db generate --sql create only sql
- aa399a6: chore: deps picocolors
- Updated dependencies [aa399a6]
  - @hot-updater/plugin-core@0.21.9
  - @hot-updater/cli-tools@0.21.9
  - @hot-updater/console@0.21.9
  - @hot-updater/server@0.21.9
  - @hot-updater/aws@0.21.9
  - @hot-updater/cloudflare@0.21.9
  - @hot-updater/firebase@0.21.9
  - @hot-updater/supabase@0.21.9
  - @hot-updater/core@0.21.9

## 0.21.8

### Patch Changes

- 3fe8c81: feat(plugin-core): reduced deps for edge-runtime
- Updated dependencies [3fe8c81]
  - @hot-updater/plugin-core@0.21.8
  - @hot-updater/cli-tools@0.21.8
  - @hot-updater/cloudflare@0.21.8
  - @hot-updater/firebase@0.21.8
  - @hot-updater/aws@0.21.8
  - @hot-updater/console@0.21.8
  - @hot-updater/supabase@0.21.8
  - @hot-updater/core@0.21.8

## 0.21.7

### Patch Changes

- Updated dependencies [2b408f2]
  - @hot-updater/plugin-core@0.21.7
  - @hot-updater/cloudflare@0.21.7
  - @hot-updater/firebase@0.21.7
  - @hot-updater/supabase@0.21.7
  - @hot-updater/aws@0.21.7
  - @hot-updater/console@0.21.7
  - @hot-updater/core@0.21.7

## 0.21.6

### Patch Changes

- b12394d: feat(cli): create migration sql hot-updater generate-db
  - @hot-updater/console@0.21.6
  - @hot-updater/core@0.21.6
  - @hot-updater/aws@0.21.6
  - @hot-updater/cloudflare@0.21.6
  - @hot-updater/firebase@0.21.6
  - @hot-updater/plugin-core@0.21.6
  - @hot-updater/supabase@0.21.6

## 0.21.5

### Patch Changes

- fc2bd56: feat: Add disabled option to deploy command
- a253498: chore(cli): replace es-git with native Git commands
  - @hot-updater/console@0.21.5
  - @hot-updater/core@0.21.5
  - @hot-updater/aws@0.21.5
  - @hot-updater/cloudflare@0.21.5
  - @hot-updater/firebase@0.21.5
  - @hot-updater/plugin-core@0.21.5
  - @hot-updater/supabase@0.21.5

## 0.21.4

### Patch Changes

- Updated dependencies [5d3070a]
  - @hot-updater/plugin-core@0.21.4
  - @hot-updater/aws@0.21.4
  - @hot-updater/cloudflare@0.21.4
  - @hot-updater/firebase@0.21.4
  - @hot-updater/console@0.21.4
  - @hot-updater/supabase@0.21.4
  - @hot-updater/core@0.21.4

## 0.21.3

### Patch Changes

- @hot-updater/console@0.21.3
- @hot-updater/core@0.21.3
- @hot-updater/aws@0.21.3
- @hot-updater/cloudflare@0.21.3
- @hot-updater/firebase@0.21.3
- @hot-updater/plugin-core@0.21.3
- @hot-updater/supabase@0.21.3

## 0.21.2

### Patch Changes

- Updated dependencies [b72da6e]
  - @hot-updater/firebase@0.21.2
  - @hot-updater/console@0.21.2
  - @hot-updater/core@0.21.2
  - @hot-updater/aws@0.21.2
  - @hot-updater/cloudflare@0.21.2
  - @hot-updater/plugin-core@0.21.2
  - @hot-updater/supabase@0.21.2

## 0.21.1

### Patch Changes

- Updated dependencies [7b7bc48]
  - @hot-updater/plugin-core@0.21.1
  - @hot-updater/console@0.21.1
  - @hot-updater/aws@0.21.1
  - @hot-updater/cloudflare@0.21.1
  - @hot-updater/firebase@0.21.1
  - @hot-updater/supabase@0.21.1
  - @hot-updater/core@0.21.1

## 0.22.0

### Minor Changes

- 610b2dd: feat: supports `compressStrategy` => `tar.br` (brotli) / `tar.gz` (gzip)
- 036f8f0: feat: support `@hot-updater/server` for self-hosted (WIP)

### Patch Changes

- Updated dependencies [610b2dd]
- Updated dependencies [afb084b]
- Updated dependencies [036f8f0]
  - @hot-updater/plugin-core@0.22.0
  - @hot-updater/cloudflare@0.22.0
  - @hot-updater/firebase@0.22.0
  - @hot-updater/supabase@0.22.0
  - @hot-updater/aws@0.22.0
  - @hot-updater/console@0.22.0
  - @hot-updater/core@0.22.0

## 0.20.15

### Patch Changes

- Updated dependencies [526a5ba]
- Updated dependencies [ddf6f2c]
  - @hot-updater/plugin-core@0.20.15
  - @hot-updater/console@0.20.15
  - @hot-updater/aws@0.20.15
  - @hot-updater/cloudflare@0.20.15
  - @hot-updater/firebase@0.20.15
  - @hot-updater/supabase@0.20.15
  - @hot-updater/core@0.20.15

## 0.20.14

### Patch Changes

- Updated dependencies [a61fa0e]
  - @hot-updater/plugin-core@0.20.14
  - @hot-updater/aws@0.20.14
  - @hot-updater/console@0.20.14
  - @hot-updater/cloudflare@0.20.14
  - @hot-updater/firebase@0.20.14
  - @hot-updater/supabase@0.20.14
  - @hot-updater/core@0.20.14

## 0.20.13

### Patch Changes

- @hot-updater/console@0.20.13
- @hot-updater/core@0.20.13
- @hot-updater/aws@0.20.13
- @hot-updater/cloudflare@0.20.13
- @hot-updater/firebase@0.20.13
- @hot-updater/plugin-core@0.20.13
- @hot-updater/supabase@0.20.13

## 0.20.12

### Patch Changes

- @hot-updater/console@0.20.12
- @hot-updater/core@0.20.12
- @hot-updater/aws@0.20.12
- @hot-updater/cloudflare@0.20.12
- @hot-updater/firebase@0.20.12
- @hot-updater/plugin-core@0.20.12
- @hot-updater/supabase@0.20.12

## 0.20.11

### Patch Changes

- afb3a6e: fix(fingerprint): separate fingerprint generation for cng
- cb9c05b: feat(fingerprint): bring back ignorePaths
- Updated dependencies [cb9c05b]
  - @hot-updater/plugin-core@0.20.11
  - @hot-updater/console@0.20.11
  - @hot-updater/aws@0.20.11
  - @hot-updater/cloudflare@0.20.11
  - @hot-updater/firebase@0.20.11
  - @hot-updater/supabase@0.20.11
  - @hot-updater/core@0.20.11

## 0.20.10

### Patch Changes

- 6b5435c: Ignore android/ios folder changes in fingerprint to avoid mismatch after prebuild
  - @hot-updater/console@0.20.10
  - @hot-updater/core@0.20.10
  - @hot-updater/aws@0.20.10
  - @hot-updater/cloudflare@0.20.10
  - @hot-updater/firebase@0.20.10
  - @hot-updater/plugin-core@0.20.10
  - @hot-updater/supabase@0.20.10

## 0.20.9

### Patch Changes

- Updated dependencies [5cbea75]
  - @hot-updater/cloudflare@0.20.9
  - @hot-updater/console@0.20.9
  - @hot-updater/core@0.20.9
  - @hot-updater/aws@0.20.9
  - @hot-updater/firebase@0.20.9
  - @hot-updater/plugin-core@0.20.9
  - @hot-updater/supabase@0.20.9

## 0.20.8

### Patch Changes

- ad7c999: feat(fingerprint): calculate OTA fingerprint only in native module
- Updated dependencies [ad7c999]
  - @hot-updater/plugin-core@0.20.8
  - @hot-updater/console@0.20.8
  - @hot-updater/aws@0.20.8
  - @hot-updater/cloudflare@0.20.8
  - @hot-updater/firebase@0.20.8
  - @hot-updater/supabase@0.20.8
  - @hot-updater/core@0.20.8

## 0.20.7

### Patch Changes

- a92992c: chore(tsdown): failOnWarn true
- Updated dependencies [a92992c]
  - @hot-updater/plugin-core@0.20.7
  - @hot-updater/cloudflare@0.20.7
  - @hot-updater/console@0.20.7
  - @hot-updater/firebase@0.20.7
  - @hot-updater/supabase@0.20.7
  - @hot-updater/core@0.20.7
  - @hot-updater/aws@0.20.7

## 0.20.6

### Patch Changes

- Updated dependencies [6a905d8]
  - @hot-updater/plugin-core@0.20.6
  - @hot-updater/console@0.20.6
  - @hot-updater/aws@0.20.6
  - @hot-updater/cloudflare@0.20.6
  - @hot-updater/firebase@0.20.6
  - @hot-updater/supabase@0.20.6
  - @hot-updater/core@0.20.6

## 0.20.5

### Patch Changes

- @hot-updater/console@0.20.5
- @hot-updater/core@0.20.5
- @hot-updater/aws@0.20.5
- @hot-updater/cloudflare@0.20.5
- @hot-updater/firebase@0.20.5
- @hot-updater/plugin-core@0.20.5
- @hot-updater/supabase@0.20.5

## 0.20.4

### Patch Changes

- 5314b31: feat(rock): intergration formerly rnef
- Updated dependencies [5314b31]
- Updated dependencies [711392b]
  - @hot-updater/plugin-core@0.20.4
  - @hot-updater/cloudflare@0.20.4
  - @hot-updater/firebase@0.20.4
  - @hot-updater/supabase@0.20.4
  - @hot-updater/aws@0.20.4
  - @hot-updater/console@0.20.4
  - @hot-updater/core@0.20.4

## 0.20.3

### Patch Changes

- e63056a: fix(cli): platform parser from hot-updater.config
- Updated dependencies [e63056a]
  - @hot-updater/plugin-core@0.20.3
  - @hot-updater/console@0.20.3
  - @hot-updater/aws@0.20.3
  - @hot-updater/cloudflare@0.20.3
  - @hot-updater/firebase@0.20.3
  - @hot-updater/supabase@0.20.3
  - @hot-updater/core@0.20.3

## 0.20.2

### Patch Changes

- Updated dependencies [0e78fb0]
  - @hot-updater/plugin-core@0.20.2
  - @hot-updater/console@0.20.2
  - @hot-updater/aws@0.20.2
  - @hot-updater/cloudflare@0.20.2
  - @hot-updater/firebase@0.20.2
  - @hot-updater/supabase@0.20.2
  - @hot-updater/core@0.20.2

## 0.20.1

### Patch Changes

- a3a4a28: feat(cli): set stringResourcePaths and infoPlistPaths in hot-updater.config.ts
- 42ff0e1: chore: bump @expo/fingerprint
- Updated dependencies [a3a4a28]
- Updated dependencies [b7b83ae]
  - @hot-updater/plugin-core@0.20.1
  - @hot-updater/console@0.20.1
  - @hot-updater/aws@0.20.1
  - @hot-updater/cloudflare@0.20.1
  - @hot-updater/firebase@0.20.1
  - @hot-updater/supabase@0.20.1
  - @hot-updater/core@0.20.1

## 0.20.0

### Patch Changes

- Updated dependencies [a0e538c]
- Updated dependencies [bc8e23d]
  - @hot-updater/cloudflare@0.20.0
  - @hot-updater/plugin-core@0.20.0
  - @hot-updater/console@0.20.0
  - @hot-updater/aws@0.20.0
  - @hot-updater/firebase@0.20.0
  - @hot-updater/supabase@0.20.0
  - @hot-updater/core@0.20.0

## 0.19.10

### Patch Changes

- 85b236d: skip gitignore and package json scripts
- 8d2d55a: Injectable minimum bundle id for Android
- Updated dependencies [a3c0901]
- Updated dependencies [4be92bd]
- Updated dependencies [2bc52e8]
  - @hot-updater/firebase@0.19.10
  - @hot-updater/cloudflare@0.19.10
  - @hot-updater/supabase@0.19.10
  - @hot-updater/aws@0.19.10
  - @hot-updater/plugin-core@0.19.10
  - @hot-updater/console@0.19.10
  - @hot-updater/core@0.19.10

## 0.19.9

### Patch Changes

- Updated dependencies [bcf6798]
  - @hot-updater/aws@0.19.9
  - @hot-updater/console@0.19.9
  - @hot-updater/core@0.19.9
  - @hot-updater/cloudflare@0.19.9
  - @hot-updater/firebase@0.19.9
  - @hot-updater/plugin-core@0.19.9
  - @hot-updater/supabase@0.19.9

## 0.19.8

### Patch Changes

- 4a6a769: feat(cli): show fingerprint diff
  - @hot-updater/console@0.19.8
  - @hot-updater/core@0.19.8
  - @hot-updater/aws@0.19.8
  - @hot-updater/cloudflare@0.19.8
  - @hot-updater/firebase@0.19.8
  - @hot-updater/plugin-core@0.19.8
  - @hot-updater/supabase@0.19.8

## 0.19.7

### Patch Changes

- e28313d: chore(cli): move commander to devDependencies and bundle it
- bcc641e: fix(cli): skipping set config `expo prebuild --platform android`
  - @hot-updater/console@0.19.7
  - @hot-updater/core@0.19.7
  - @hot-updater/aws@0.19.7
  - @hot-updater/cloudflare@0.19.7
  - @hot-updater/firebase@0.19.7
  - @hot-updater/plugin-core@0.19.7
  - @hot-updater/supabase@0.19.7

## 0.19.6

### Patch Changes

- 657a10e: Android Native Build - Gradle Build
- Updated dependencies [657a10e]
  - @hot-updater/aws@0.19.6
  - @hot-updater/cloudflare@0.19.6
  - @hot-updater/firebase@0.19.6
  - @hot-updater/plugin-core@0.19.6
  - @hot-updater/console@0.19.6
  - @hot-updater/supabase@0.19.6
  - @hot-updater/core@0.19.6

## 0.19.5

### Patch Changes

- 40d28c2: bump rnef
- Updated dependencies [40d28c2]
  - @hot-updater/console@0.19.5
  - @hot-updater/core@0.19.5
  - @hot-updater/aws@0.19.5
  - @hot-updater/cloudflare@0.19.5
  - @hot-updater/firebase@0.19.5
  - @hot-updater/plugin-core@0.19.5
  - @hot-updater/supabase@0.19.5

## 0.19.4

### Patch Changes

- Updated dependencies [0ddc955]
  - @hot-updater/plugin-core@0.19.4
  - @hot-updater/console@0.19.4
  - @hot-updater/aws@0.19.4
  - @hot-updater/cloudflare@0.19.4
  - @hot-updater/firebase@0.19.4
  - @hot-updater/supabase@0.19.4
  - @hot-updater/core@0.19.4

## 0.19.3

### Patch Changes

- 0c0ab1d: Add debug option while creating fingerprint
- Updated dependencies [0c0ab1d]
  - @hot-updater/plugin-core@0.19.3
  - @hot-updater/console@0.19.3
  - @hot-updater/aws@0.19.3
  - @hot-updater/cloudflare@0.19.3
  - @hot-updater/firebase@0.19.3
  - @hot-updater/supabase@0.19.3
  - @hot-updater/core@0.19.3

## 0.19.2

### Patch Changes

- 6aa6cd7: fix: globby to fast-glob unicorn-magic error
  - @hot-updater/console@0.19.2
  - @hot-updater/core@0.19.2
  - @hot-updater/aws@0.19.2
  - @hot-updater/cloudflare@0.19.2
  - @hot-updater/firebase@0.19.2
  - @hot-updater/plugin-core@0.19.2
  - @hot-updater/supabase@0.19.2

## 0.19.1

### Patch Changes

- 755b9fe: fix(expo): ensure fingerprint when prebuild
  - @hot-updater/console@0.19.1
  - @hot-updater/core@0.19.1
  - @hot-updater/aws@0.19.1
  - @hot-updater/cloudflare@0.19.1
  - @hot-updater/firebase@0.19.1
  - @hot-updater/plugin-core@0.19.1
  - @hot-updater/supabase@0.19.1

## 0.19.0

### Minor Changes

- c408819: feat(expo): channel supports expo cng
- 886809d: fix(babel): make sure the backend can handle channel changes for a bundle and still receive updates correctly

### Patch Changes

- Updated dependencies [886809d]
- Updated dependencies [fb846ce]
- Updated dependencies [75e82a8]
  - @hot-updater/plugin-core@0.19.0
  - @hot-updater/firebase@0.19.0
  - @hot-updater/console@0.19.0
  - @hot-updater/aws@0.19.0
  - @hot-updater/cloudflare@0.19.0
  - @hot-updater/supabase@0.19.0
  - @hot-updater/core@0.19.0

## 0.18.5

### Patch Changes

- Updated dependencies [494ce31]
  - @hot-updater/plugin-core@0.18.5
  - @hot-updater/cloudflare@0.18.5
  - @hot-updater/console@0.18.5
  - @hot-updater/firebase@0.18.5
  - @hot-updater/supabase@0.18.5
  - @hot-updater/aws@0.18.5
  - @hot-updater/core@0.18.5

## 0.18.4

### Patch Changes

- c6c4838: cancellation of platform selection prompt shows log correctly
  - @hot-updater/console@0.18.4
  - @hot-updater/core@0.18.4
  - @hot-updater/aws@0.18.4
  - @hot-updater/cloudflare@0.18.4
  - @hot-updater/firebase@0.18.4
  - @hot-updater/plugin-core@0.18.4
  - @hot-updater/supabase@0.18.4

## 0.18.3

### Patch Changes

- 34b96c1: fix(native): extracted bundle.zip directly into folder
- d56a2b3: hot-updater doctor
- 72f881c: channel set <channel> after create fingerprint
- 85fc787: fix doctor command check semver version
- 894b2bc: `app-version` shows naive native app version with refactored version utilties
- Updated dependencies [d56a2b3]
  - @hot-updater/aws@0.18.3
  - @hot-updater/console@0.18.3
  - @hot-updater/core@0.18.3
  - @hot-updater/cloudflare@0.18.3
  - @hot-updater/firebase@0.18.3
  - @hot-updater/plugin-core@0.18.3
  - @hot-updater/supabase@0.18.3

## 0.18.2

### Patch Changes

- 70c7f11: fix: no exit deploy in warning state
- Updated dependencies [437c98e]
- Updated dependencies [70c7f11]
  - @hot-updater/plugin-core@0.18.2
  - @hot-updater/cloudflare@0.18.2
  - @hot-updater/console@0.18.2
  - @hot-updater/firebase@0.18.2
  - @hot-updater/supabase@0.18.2
  - @hot-updater/aws@0.18.2
  - @hot-updater/core@0.18.2

## 0.18.1

### Patch Changes

- 8bf8f8f: rspress 2.0.0 and llms.txt
- 7db6246: create fingerprint
- Updated dependencies [8bf8f8f]
  - @hot-updater/console@0.18.1
  - @hot-updater/core@0.18.1
  - @hot-updater/aws@0.18.1
  - @hot-updater/cloudflare@0.18.1
  - @hot-updater/firebase@0.18.1
  - @hot-updater/plugin-core@0.18.1
  - @hot-updater/supabase@0.18.1

## 0.18.0

### Minor Changes

- 73ec434: fingerprint-based update stratgy

### Patch Changes

- Updated dependencies [73ec434]
  - @hot-updater/plugin-core@0.18.0
  - @hot-updater/cloudflare@0.18.0
  - @hot-updater/console@0.18.0
  - @hot-updater/firebase@0.18.0
  - @hot-updater/supabase@0.18.0
  - @hot-updater/core@0.18.0
  - @hot-updater/aws@0.18.0
