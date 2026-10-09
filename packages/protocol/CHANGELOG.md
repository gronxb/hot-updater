# @hot-updater/protocol

## 1.0.0-rc.43

## 1.0.0-rc.42

## 1.0.0-rc.41

### Minor Changes

- 545f059: `HotUpdater.init` returns the app's HotUpdater instance: every HotUpdater method, including `wrap`, and each client plugin's API under the plugin's id, typed from `plugins`.
  - **Client plugin contract:** `setup(context)` returns `{ hooks, api }`, either of them, or nothing. `api` is what the app calls, as `hotUpdater.<id>`; a plugin id cannot be the name of an instance member, such as `reload` or `wrap`. A `setup` that returns hooks at the top level, as before, is reported through `onError` and gets no hooks. `ClientPluginApi`, `ClientPluginApis`, and `HotUpdaterClientSetup` type it; `HotUpdaterInstance` and `HotUpdaterCore` type the instance.
  - **Insights:** `setUser` moves from the plugin object to `hotUpdater.insights.setUser`. `insights()` keeps its context, device state, and delivery queue per `setup`, so one plugin object set up by two instances reports through each instance's own server. The launch report waits for native launch verification, so a user set right after `init` is on the first report.
  - **Remote Config:** the reads, `fetch`, `activate`, and `subscribe` are on `hotUpdater.remoteConfig`; the plugin object has only `id` and `setup`.
  - **Tests:** `setupClientPlugin` returns the plugin's `api`, and `setupClientPlugins` the plugins' `apis` by id.

### Patch Changes

- 545f059: `HotUpdater` keeps only `init`; every other method is on the instance it returns. Call `HotUpdater.init` once at the top level of a module, export the instance, and call `hotUpdater.checkForUpdate()`, `hotUpdater.reload()`, `hotUpdater.getBundleId()`, and the rest on it. Each `init` call returns an independent instance with its own configuration, plugins, and launch report, and nothing is configured globally; create one per app.

  `HotUpdater.wrap` becomes `hotUpdater.wrap`, which takes only the update flow: `updateStrategy`, `fallbackComponent`, `onProgress`, `reloadOnForceUpdate`, and `onUpdateProcessCompleted`. Move `baseURL`, `requestHeaders`, `requestTimeout`, `plugins`, `onError`, and `onNotifyAppReady` to `HotUpdater.init`. `HotUpdaterOptions` becomes `HotUpdaterWrapOptions`. `wrap` reads the launch through `init` instead of reading it again, and reloads for a forced update only after that read.

## 1.0.0-rc.40

## 1.0.0-rc.39

## 1.0.0-rc.38

## 1.0.0-rc.37

## 1.0.0-rc.36

### Patch Changes

- c527bb2: Report installations on the built-in bundle. A client plugin's context has `minBundleId`, the ID of the bundle the native build ships, and the Insights client sends it with each report. Insights counts an installation that runs its build's built-in bundle again in the new `insights_builtin_distribution` gauge, by the release it runs and the bundle's ID, and `getAppUsage` returns `builtinBundleId` with each `bundleDistribution` row. The Console's **Distribution** shows **Built-in app** with the bundle ID under its app version, where it showed **Unknown bundle**, and event and installation details mark the built-in bundle. Reports from SDKs that do not send `minBundleId` count as before.

  The Insights schema version stays 1.0.0 while the 1.0.0 baseline gains the `insights_builtin_distribution` table; existing tables don't change. On SQL databases, create it as the baseline does (Supabase prefixes it with `hot_updater_v1_` and enables row level security); Drizzle and Prisma projects regenerate their schema with `hot-updater db generate` and migrate it. On AWS the DynamoDB policy allows the new partition: rerun `hot-updater init`. Firestore and MongoDB need no change. Installations count in it from their first report after the upgrade.

## 1.0.0-rc.35

## 1.0.0-rc.30

### Patch Changes

- 48241d4: Remove crash exit reasons. Android 11 and later reported only why the previous process exited, such as `CRASH` or `ANR`, with no stack trace or message, and iOS reported nothing, so they could not show what crashed. The SDK no longer reads `ApplicationExitInfo` or sends `previousProcessExit`. `AppReadyResult` and `UpdateError` drop the field, Insights keeps no exit-reason rows, `getUpdateFailures` drops `recoveries`, and the Console drops **Crashes by exit reason**. A bundle's crash count in Release health is no longer a link. The server still accepts reports from SDKs that send the field and ignores it. Update failure reads count only the stages a failure records, so exit-reason rows already stored are ignored until they expire.

  The Insights schema version is 1.0.0, as core's is, while the 1.0.0 baseline changes in place: set the `schema.insights` setting to `1.0.0`. The Console's tooltips are shorter.

## 1.0.0-rc.29

### Patch Changes

- 384a5b6: Report a request that the SDK's timeout cuts off as `Request timed out` under Expo's fetch too, which rejects it with `fetch failed: FetchRequestCanceledException` instead of an `AbortError`: update failures now classify it as a network timeout, so an update check that times out is no longer reported as an unknown failure, and the same holds for client plugin requests. Expo's other fetch failures without a response classify as network errors.

## 1.0.0-rc.28

### Patch Changes

- 80bb792: Attach the latest catalog or artifact HTTP response to existing Insights reports without adding requests or changing launch/failure deduplication. Preserve successful, cached, and failed response text with a bounded body and its original observation timestamp. Console exposes the response from event and installation details and alongside error investigation. No database migration is required.

## 1.0.0-rc.27

### Patch Changes

- Improve the readability of Console update failures by grouping check metrics separately, emphasizing nonzero failures, and making stage/reason details easier to scan. Preserve all report data and rate calculations. Prepare all public Hot Updater packages together as 1.0.0-rc.27.

## 1.0.0-rc.26

### Patch Changes

- c9cfed7: Restore the rc.14 Insights metric layout in bundle rows and details while preserving current data, rates, links, and download failure reporting. Release all public Hot Updater packages together as 1.0.0-rc.26.

## 1.0.0-rc.25

### Patch Changes

- c9cfed7: Release the legacy Hermes fallback correction at 1.0.0-rc.25 with all public Hot Updater packages on the same RC.

## 1.0.0-rc.24

### Patch Changes

- c9cfed7: Release the project-scoped Expo, fingerprint, React Native, and Hermes resolution fixes at 1.0.0-rc.24 so projects can install the same RC of every Hot Updater package.

## 1.0.0-rc.23

### Patch Changes

- c9cfed7: Release with the Expo SDK 58 config fix at 1.0.0-rc.23 so projects can install the same RC of every Hot Updater package.

## 1.0.0-rc.22

### Patch Changes

- c9cfed7: Released with every Hot Updater package at 1.0.0-rc.22, so a project can install the same RC of each one.

## 1.0.0-rc.21

### Minor Changes

- 5ec6796: CLI commands exist only for user workflows. Checks move into `hot-updater doctor`, which can now repair what it finds with `--fix`, and plumbing commands are removed, with no aliases:
  - `hot-updater app-version` is removed. `doctor` shows each platform's app version in its native status, as `appVersion` in `--json`.
  - Bare `hot-updater channel` shows help. `doctor` shows the native default channels, and `channel set` stays.
  - Bare `hot-updater fingerprint` shows help. Under the fingerprint update strategy, `doctor` compares `fingerprint.json` with the project's fingerprint and reports `FINGERPRINT_JSON_STALE` with the sources that changed, or `FINGERPRINT_GENERATION_FAILED`. `fingerprint create` stays.
  - `hot-updater db catalog preflight` and `db catalog rebuild` are removed. When `hot-updater.config.ts` sets `database`, `doctor` opens it once per run and checks every scope that has a catalog row or a release:
    - `RELEASE_CATALOG_STALE` is a catalog that differs from a rebuild from its releases;
    - `RELEASE_CATALOG_IDENTITY_MISSING` is a scope whose releases have no catalog row, which devices get 404 for. The row must be restored from backup;
    - `RELEASE_CATALOG_CHECK_FAILED` is a scope core cannot compile, reported beside the other scopes' results;
    - a database doctor cannot reach is the warning `RELEASE_CATALOGS_UNCHECKED`, never a failure.
  - `hot-updater bundle preflight` is removed. `bundle update --dry-run` takes the same options and validates the update and shows the projected catalog, without saving or asking.
  - `hot-updater bundle artifact delete` is removed. Deleting a release deletes its artifact record when no other release uses it, whether the CLI, the console, or the admin API deletes it.
    - Every patch to or from that artifact goes with it, so a device running the deleted bundle downloads its next update in full.
    - `bundle delete` says so, and its `--json` output names the artifact in `deletedArtifactId`.
    - Stored files stay until `storage prune`.
    - Artifact records that an earlier release candidate's `bundle delete` left behind show up in `doctor` as `UNREFERENCED_ARTIFACTS`. `doctor --fix` deletes them, and `storage prune` then reclaims their files.
  - `hot-updater patch` no longer takes the hidden `--bundle-id` and `--base-bundle-id` aliases. Use `--artifact-id` and `--base-artifact-id`.
  - `hot-updater keys export-public` no longer takes `-i, --input <path>`. It exports the configured signing key.
  - `hot-updater build:android` needs `EXPERIMENTAL`, like `build:ios`, `run:android`, and `run:ios`.

  `hot-updater doctor --fix` runs the repairs doctor can make itself:
  - it rebuilds stale release catalogs from their releases;
  - it deletes the artifact records no release uses;
  - it writes what `fingerprint create` writes, where it differs;
  - it writes what `keys export-public --yes` writes.

  It names every write, in the output and in `details.fixes`, and checks again.

  It skips native files that `expo prebuild` generates. It never removes a public key: an issue with more than one remedy, such as `ORPHAN_PUBLIC_KEY`, stays report-only. When it wrote a native file, it ends by asking for a native rebuild.

  `@hot-updater/protocol` exports `parseReleaseCatalog`, the check a client runs on a fetched release catalog, with `hasExpectedReleaseCatalogScope`, `ExpectedReleaseCatalogScope`, `MAX_RELEASE_CATALOG_WIRE_BYTES`, and `getUtf8ByteLength`. The React Native update client and doctor's server checks both run it.

  `@hot-updater/test-utils` exports `storeBundles`, which stores bundles with no release through the storage engine.

- f185d6d: The plugin authoring APIs move below the packages that run plugins, so a plugin package needs neither `@hot-updater/server` nor `@hot-updater/react-native` to build:
  - `@hot-updater/plugin-core` exports `definePlugin` and its types, the schema DSL, the typed database handle, the database errors, `isDatabaseBusyError`, `HotUpdaterConfigError`, and `CoreReads`, now an explicit interface of core's reads.
  - `@hot-updater/protocol` exports the client plugin contract: `defineClientPlugin` and its hook and context types. `@hot-updater/react-native` exports the same names as before.

- 4d15862: `@hot-updater/core` is renamed `@hot-updater/protocol`: the device-safe, zero-dependency package for what crosses a boundary, the formats and pure computations the app and the server share and the contracts between a host and its extensions on the device, such as the client plugin contract. `@hot-updater/plugin-core` is the kit that extends the server, with the adapter and server plugin contracts and their helpers: it runs wherever the server runs, and the app never imports it.
  - Import from `@hot-updater/protocol` where you imported `@hot-updater/core`. Every Hot Updater package that depended on `@hot-updater/core` depends on `@hot-updater/protocol` instead. `@hot-updater/core` stays on npm for 0.x.
  - `canonicalizeAppVersion` moves to `@hot-updater/protocol`, which bundles the version parsing it uses and has no dependencies. `@hot-updater/plugin-core` exports it as before.
  - `@hot-updater/react-native` no longer depends on `@hot-updater/plugin-core`: the app imports `@hot-updater/protocol` and the built-in Insights client, never `@hot-updater/plugin-core` or `@hot-updater/server`.
  - `@hot-updater/plugin-insights` takes `@hot-updater/plugin-core` as an optional peer dependency, which only its `./server` entry needs, and `@hot-updater/plugin-api-keys` as a peer dependency, so an app that installs `@hot-updater/react-native` no longer installs `@hot-updater/plugin-core`. A server gets it through `@hot-updater/server`.
  - Third-party server plugins and storage, build, and signing adapters import `@hot-updater/plugin-core` and list it in `peerDependencies`; client plugins do the same with `@hot-updater/protocol`. `@hot-updater/plugin-core` now also exports `addDistinct`, `countDistinct`, and `mergeDistinct`, so a plugin imports everything it needs from its root.
  - Client plugins import `defineClientPlugin` and its types from `@hot-updater/protocol`. `@hot-updater/react-native` still exports them for app code.
  - The `@hot-updater/react-native/plugins/insights` subpath is removed: import `insights` and its types from `@hot-updater/react-native`, as in `import { HotUpdater, insights } from "@hot-updater/react-native"`. Metro bundles the Insights client into every app, about 4 KB gzipped; it reports nothing until the app adds it to `plugins`. `hot-updater init` and the agent scaffold print that import, and `hot-updater doctor` looks for it.
  - `@hot-updater/protocol` exports the plugin host the SDK runs client plugins on, for any device SDK to reuse: `createPluginHost`, `pluginStorageKey`, `resolveBaseURL`, `HotUpdaterBaseURL`, and the `PluginHost*` types. `@hot-updater/react-native` has no subpaths, and `@hot-updater/test-utils/react-native` runs client plugins on protocol's host, without `@hot-updater/react-native` as a peer dependency.
  - `@hot-updater/cli-tools` adds `renderAppImports`, which groups the app's imports by module.
  - The `@hot-updater/plugin-core` root exports `definePlugin`, the schema DSL, the typed database handle, and the database errors.

### Patch Changes

- c9cfed7: Every package now shares one release candidate version: `hot-updater` and every `@hot-updater/*` package move to the same version, so an app, its server, and the console can pin one version.

## 1.0.0-rc.15

### Patch Changes

- 79c3eea: Use the versioned manifest artifact protocol for every OTA install. Deploys
  publish a manifest, content-addressed files and one tar.br bulk transport. The
  native installer reuses byte-identical built-in assets and compares tar.br with
  the remaining transfer cost. Complete downloads without patches may additionally
  allow the signed TAR framing overhead to avoid request fanout. Failed archives
  fall back once to verified original files; failed patches recover per file.

  Remove `compressStrategy`, ZIP/gzip OTA extraction, format detection and archive
  strategy branches. Archive identity and bounds belong to the signed manifest;
  Bundle and provider rows stay manifest-based. The unreleased 1.0.0 schema and
  initial migrations now require manifest metadata directly.

  Validate complete descriptor sets before reuse, recheck cached target files,
  and retain hash-verified staging files across retries. Download remaining files
  with a fixed concurrency limit and report only network files in download progress.

  Allow concurrent Supabase deploys to upload the same shared content-addressed
  asset without failing on an already-existing object.

  Authenticate the versioned artifact endpoint. Preserve installed bundles across
  promotion failures and interrupted renames, and require durable metadata before
  activating an OTA. Remove manifestless launch and BUNDLE_ID compatibility paths,
  unused native progress fields, observers, and unused iOS task-state persistence.

## 1.0.0-rc.14

### Patch Changes

- Align all Hot Updater packages on 1.0.0-rc.14 for a coordinated release candidate. Future releases continue to use independent package versions.

## 1.0.0-rc.0

### Major Changes

- adb0e40: Release HotUpdater 1.0 with the Release Catalog architecture.

### Minor Changes

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

### Patch Changes

- 7244b65: Fix standalone database generation for provider SQL output and generated schema regeneration, and centralize the generated DB schema artifact contract.

## 0.33.2

## 0.33.1

## 0.33.0

## 0.32.0

## 0.31.4

## 0.31.3

## 0.31.2

## 0.31.1

## 0.31.0

### Minor Changes

- 5b0a0f5: Add signed manifest-based diff update support across deploy, server, provider storage, console tooling, and React Native runtime.
- 5b0a0f5: Add Hermes bundle patch metadata and runtime BSDIFF patch application support.

## 0.30.12

## 0.30.11

## 0.30.10

## 0.30.9

## 0.30.8

## 0.30.7

## 0.30.6

## 0.30.5

## 0.30.4

## 0.30.3

## 0.30.2

## 0.30.1

## 0.30.0

### Minor Changes

- 83c01c8: fix: keep target cohorts additive to rollout

## 0.29.8

## 0.29.7

## 0.29.6

## 0.29.5

## 0.29.4

## 0.29.3

## 0.29.2

### Patch Changes

- 2a1bc80: fix: node deps bundling

## 0.29.1

## 0.29.0

### Minor Changes

- a935992: feat: Rollout feature with control from 1% to 100%

### Patch Changes

- d0fe908: fix(console): rebuild copied bundles with fresh uuidv7 ids

## 0.28.0

## 0.27.1

## 0.27.0

### Minor Changes

- 81f9437: feat(android): for safe reloading, Android reloads the process (#869)

## 0.26.2

## 0.26.1

## 0.26.0

## 0.25.14

## 0.25.13

## 0.25.12

## 0.25.11

## 0.25.10

## 0.25.9

## 0.25.8

## 0.25.7

## 0.25.6

## 0.25.5

## 0.25.4

## 0.25.3

## 0.25.2

## 0.25.1

## 0.25.0

## 0.24.7

### Patch Changes

- 294e324: fix: update babel plugin path in documentation and plugin files

## 0.24.6

## 0.24.5

## 0.24.4

## 0.24.3

## 0.24.2

## 0.24.1

## 0.24.0

## 0.23.1

## 0.23.0

### Minor Changes

- e41fb6b: feat: add bundle signing for cryptographic OTA verification

## 0.22.2

## 0.22.1

## 0.22.0

## 0.21.15

## 0.21.14

## 0.21.13

## 0.21.12

## 0.21.11

### Patch Changes

- e2b67d7: fix(cli-tools): esm only package bundle

## 0.21.10

## 0.21.9

## 0.21.8

## 0.21.7

## 0.21.6

## 0.21.5

## 0.21.4

## 0.21.3

## 0.21.2

## 0.21.1

## 0.22.0

### Minor Changes

- afb084b: feat: validate bundle file with fileHash
- 036f8f0: feat: support `@hot-updater/server` for self-hosted (WIP)

## 0.20.15

## 0.20.14

## 0.20.13

## 0.20.12

## 0.20.11

## 0.20.10

## 0.20.9

## 0.20.8

## 0.20.7

### Patch Changes

- a92992c: chore(tsdown): failOnWarn true

## 0.20.6

## 0.20.5

## 0.20.4

## 0.20.3

## 0.20.2

## 0.20.1

## 0.20.0

## 0.19.10

## 0.19.9

## 0.19.8

## 0.19.7

## 0.19.6

## 0.19.5

### Patch Changes

- 40d28c2: bump rnef

## 0.19.4

## 0.19.3

## 0.19.2

## 0.19.1

## 0.19.0

## 0.18.5

## 0.18.4

## 0.18.3

## 0.18.2

## 0.18.1

## 0.18.0

### Minor Changes

- 73ec434: fingerprint-based update stratgy
