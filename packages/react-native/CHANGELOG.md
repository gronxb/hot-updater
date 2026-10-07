# @hot-updater/react-native

## 1.0.0-rc.40

### Patch Changes

- @hot-updater/protocol@1.0.0-rc.40
  - @hot-updater/plugin-insights@1.0.0-rc.40

## 1.0.0-rc.39

### Patch Changes

- Updated dependencies [2071bc6]
  - @hot-updater/plugin-insights@1.0.0-rc.39
  - @hot-updater/protocol@1.0.0-rc.39

## 1.0.0-rc.38

### Patch Changes

- Updated dependencies [bbbdd8c]
  - @hot-updater/plugin-insights@1.0.0-rc.38
  - @hot-updater/protocol@1.0.0-rc.38

## 1.0.0-rc.37

### Patch Changes

- Updated dependencies [5a5dd3e]
  - @hot-updater/plugin-insights@1.0.0-rc.37
  - @hot-updater/protocol@1.0.0-rc.37

## 1.0.0-rc.36

### Patch Changes

- c527bb2: Report installations on the built-in bundle. A client plugin's context has `minBundleId`, the ID of the bundle the native build ships, and the Insights client sends it with each report. Insights counts an installation that runs its build's built-in bundle again in the new `insights_builtin_distribution` gauge, by the release it runs and the bundle's ID, and `getAppUsage` returns `builtinBundleId` with each `bundleDistribution` row. The Console's **Distribution** shows **Built-in app** with the bundle ID under its app version, where it showed **Unknown bundle**, and event and installation details mark the built-in bundle. Reports from SDKs that do not send `minBundleId` count as before.

  The Insights schema version stays 1.0.0 while the 1.0.0 baseline gains the `insights_builtin_distribution` table; existing tables don't change. On SQL databases, create it as the baseline does (Supabase prefixes it with `hot_updater_v1_` and enables row level security); Drizzle and Prisma projects regenerate their schema with `hot-updater db generate` and migrate it. On AWS the DynamoDB policy allows the new partition: rerun `hot-updater init`. Firestore and MongoDB need no change. Installations count in it from their first report after the upgrade.

- c527bb2: Read the iOS built-in bundle ID from the `HOT_UPDATER_MIN_BUNDLE_ID` build setting. The CLI passes that setting to `xcodebuild` and adds the `$(HOT_UPDATER_MIN_BUNDLE_ID)` slot to `Info.plist`, as Android takes `-PMIN_BUNDLE_ID`, but the native module read `HOT_UPDATER_BUILD_TIMESTAMP`, so iOS always fell back to the time `HotUpdater.mm` was compiled. A value that is not a UUID is ignored with a warning, and an unset build setting still falls back to the compile time. Requires rebuilding the native app.
- Updated dependencies [c527bb2]
  - @hot-updater/protocol@1.0.0-rc.36
  - @hot-updater/plugin-insights@1.0.0-rc.36

## 1.0.0-rc.35

### Patch Changes

- 52ac89a: Build the Android library for the New Architecture unless the app sets `newArchEnabled=false`, and read that setting from the library project. React Native 0.82 and later run only the New Architecture and set it to `true` there, so an app that still has `newArchEnabled=false` in `gradle.properties`, or has no such line, no longer gets the old architecture build, whose crash recovery asked the app for a `ReactNativeHost` that throws when the app has none. `ReactNativeHost` code now builds only for the React Native versions that use it: the old architecture, and the bridge that React Native 0.81 and older can run the New Architecture on. Builds for React Native 0.82 and later no longer compile against `ReactNativeHost`, which React Native deprecates for removal. An app on React Native 0.81 or older that runs the old architecture keeps `newArchEnabled=false` in `gradle.properties`, as its template has. Requires rebuilding the native app.
- 52ac89a: Record a launch on Android when React Native loads inside an activity that was already started, as in a brownfield app that adds React Native to a screen on display. Android does not replay that activity start, so such a launch was never recorded, and a staged bundle that hung there was not rolled back on the next start. Requires rebuilding the native app.
- ff87aed: Keep a pending bundle when a launch never shows UI. An Android headless JS task, such as a background push message, and an iOS background launch no longer record an unfinished launch, so the next launch no longer rolls a healthy bundle back, adds it to crash history, and reports `RECOVERED`. A launch is recorded when an activity starts on Android, and when the app is in the foreground on iOS. Requires rebuilding the native app.
- 52ac89a: Give a bundle one retry after a launch that ends before the first render without a crash, such as a user leaving during the splash screen. The next start still rolls back and reports `RECOVERED`, but the bundle no longer goes into crash history at once: the session that recovered does not install it again, and a later session retries it. A second unfinished launch, or a crash, adds it to crash history as before. Requires rebuilding the native app.
- 52ac89a: Keep a session's launch result final when an update downloads during that session. A root wrapped with `HotUpdater.wrap` that mounts again in the same process, for example after Android recreates its activity, no longer stays on its `fallbackComponent` waiting for the downloaded bundle, and `onNotifyAppReady` is called again with `UNCHANGED`. The next launch still applies the downloaded bundle. Requires rebuilding the native app.
- @hot-updater/protocol@1.0.0-rc.35
  - @hot-updater/plugin-insights@1.0.0-rc.35

## 1.0.0-rc.34

### Patch Changes

- 48241d4: Remove crash exit reasons. Android 11 and later reported only why the previous process exited, such as `CRASH` or `ANR`, with no stack trace or message, and iOS reported nothing, so they could not show what crashed. The SDK no longer reads `ApplicationExitInfo` or sends `previousProcessExit`. `AppReadyResult` and `UpdateError` drop the field, Insights keeps no exit-reason rows, `getUpdateFailures` drops `recoveries`, and the Console drops **Crashes by exit reason**. A bundle's crash count in Release health is no longer a link. The server still accepts reports from SDKs that send the field and ignores it. Update failure reads count only the stages a failure records, so exit-reason rows already stored are ignored until they expire.

  The Insights schema version is 1.0.0, as core's is, while the 1.0.0 baseline changes in place: set the `schema.insights` setting to `1.0.0`. The Console's tooltips are shorter.

- Updated dependencies [48241d4]
  - @hot-updater/protocol@1.0.0-rc.30
  - @hot-updater/plugin-insights@1.0.0-rc.34

## 1.0.0-rc.33

### Patch Changes

- Updated dependencies [9fe6dfd]
  - @hot-updater/plugin-insights@1.0.0-rc.33

## 1.0.0-rc.32

### Patch Changes

- 384a5b6: Report a request that the SDK's timeout cuts off as `Request timed out` under Expo's fetch too, which rejects it with `fetch failed: FetchRequestCanceledException` instead of an `AbortError`: update failures now classify it as a network timeout, so an update check that times out is no longer reported as an unknown failure, and the same holds for client plugin requests. Expo's other fetch failures without a response classify as network errors.
- Updated dependencies [384a5b6]
  - @hot-updater/protocol@1.0.0-rc.29
  - @hot-updater/plugin-insights@1.0.0-rc.32

## 1.0.0-rc.31

### Patch Changes

- Updated dependencies [d846556]
  - @hot-updater/plugin-insights@1.0.0-rc.31

## 1.0.0-rc.30

### Patch Changes

- Updated dependencies [0c884b7]
- Updated dependencies [541f0ec]
  - @hot-updater/plugin-insights@1.0.0-rc.30

## 1.0.0-rc.29

### Patch Changes

- 80bb792: Attach the latest catalog or artifact HTTP response to existing Insights reports without adding requests or changing launch/failure deduplication. Preserve successful, cached, and failed response text with a bounded body and its original observation timestamp. Console exposes the response from event and installation details and alongside error investigation. No database migration is required.
- Updated dependencies [80bb792]
  - @hot-updater/protocol@1.0.0-rc.28
  - @hot-updater/plugin-insights@1.0.0-rc.29

## 1.0.0-rc.28

### Patch Changes

- Updated dependencies [b412f41]
  - @hot-updater/plugin-insights@1.0.0-rc.28

## 1.0.0-rc.27

### Patch Changes

- Improve the readability of Console update failures by grouping check metrics separately, emphasizing nonzero failures, and making stage/reason details easier to scan. Preserve all report data and rate calculations. Prepare all public Hot Updater packages together as 1.0.0-rc.27.
- Updated dependencies
  - @hot-updater/plugin-insights@1.0.0-rc.27
  - @hot-updater/protocol@1.0.0-rc.27

## 1.0.0-rc.26

### Patch Changes

- c9cfed7: Restore the rc.14 Insights metric layout in bundle rows and details while preserving current data, rates, links, and download failure reporting. Release all public Hot Updater packages together as 1.0.0-rc.26.
- Updated dependencies [c9cfed7]
  - @hot-updater/plugin-insights@1.0.0-rc.26
  - @hot-updater/protocol@1.0.0-rc.26

## 1.0.0-rc.25

### Patch Changes

- c9cfed7: Release the legacy Hermes fallback correction at 1.0.0-rc.25 with all public Hot Updater packages on the same RC.
- Updated dependencies [c9cfed7]
  - @hot-updater/plugin-insights@1.0.0-rc.25
  - @hot-updater/protocol@1.0.0-rc.25

## 1.0.0-rc.24

### Patch Changes

- c9cfed7: Release the project-scoped Expo, fingerprint, React Native, and Hermes resolution fixes at 1.0.0-rc.24 so projects can install the same RC of every Hot Updater package.
- Updated dependencies [c9cfed7]
  - @hot-updater/plugin-insights@1.0.0-rc.24
  - @hot-updater/protocol@1.0.0-rc.24

## 1.0.0-rc.23

### Patch Changes

- c9cfed7: Release with the Expo SDK 58 config fix at 1.0.0-rc.23 so projects can install the same RC of every Hot Updater package.
- Updated dependencies [c9cfed7]
  - @hot-updater/plugin-insights@1.0.0-rc.23
  - @hot-updater/protocol@1.0.0-rc.23

## 1.0.0-rc.22

### Patch Changes

- c9cfed7: Released with every Hot Updater package at 1.0.0-rc.22, so a project can install the same RC of each one.
- Updated dependencies [c9cfed7]
  - @hot-updater/plugin-insights@1.0.0-rc.22
  - @hot-updater/protocol@1.0.0-rc.22

## 1.0.0-rc.21

### Patch Changes

- c9cfed7: Every package now shares one release candidate version: `hot-updater` and every `@hot-updater/*` package move to the same version, so an app, its server, and the console can pin one version.
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

- f185d6d: Insights and API keys ship as their own packages: `@hot-updater/plugin-insights`, with `./server` and `./client`, and `@hot-updater/plugin-api-keys`, with `./server`. `@hot-updater/server` and `@hot-updater/react-native` depend on them: the server re-exports them from `@hot-updater/server/plugins/insights` and `@hot-updater/server/plugins/api-keys`, and the app SDK exports the Insights client from its root, so servers and apps install nothing more.
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

- 61fcd51: `@hot-updater/server` is the runtime host: its root holds `createHotUpdater`, its types, the handlers and `toNodeHandler`, and its other entries are the built-in adapters (`./adapters/*`) and plugins (`./plugins/insights`, `./plugins/api-keys`). The storage engine, the database adapter kit, and core's schema move to `@hot-updater/plugin-core`, the kit adapters and plugins build on, and test code moves to `@hot-updater/test-utils`.
  - `@hot-updater/server/database`, `@hot-updater/server/node`, `@hot-updater/server/plugins`, and `@hot-updater/server/plugins/insights/testing` are removed:
    - Import from `@hot-updater/plugin-core` what you imported from `@hot-updater/server/database` or `@hot-updater/server/plugins`.
    - Import `toNodeHandler` from `@hot-updater/server`.
    - Import the Insights suites from `@hot-updater/test-utils`.
  - From `@hot-updater/server/db`:
    - `createMeasuredDatabase`, `MeasuredDatabase`, and `MeasuredDatabaseOptions` move to `@hot-updater/test-utils`.
    - `targetBaseCandidateKey` and `EngineSqlOptions` move to `@hot-updater/plugin-core`, beside `parseBaseCandidateKey`.
    - `settingsStatements` is private.
  - `createEngine` now has the signature `createEngine(database, { plugins, now })`. It takes a database as `createEngineDatabase` returns it, and returns `{ core, database(plugin), flush, dispose }`. rc.18's `createEngine({ adapter, schema, maxPageSize, verify, retry })` from `@hot-updater/server/database` is gone. A transaction's retries are the database's `retry` (`createEngineDatabase({ retry })`), and verify mode is `verifyAdapter(adapter)`.
  - These rc.18 names now exist in no package, because they are the storage engine's internals:
    - `aggregateBatchingModule`, `CheckIndex`, `checkSchemaFence`, `classifySqlError`, `CliFor`, `compareTuples`, `createDatabaseEngine`;
    - `DATABASE_MAX_MULTI_VALUES`, `DATABASE_MAX_QUERY_LIMIT`, `DatabaseEngine`, `DatabaseEngineOptions`, `DatabaseTestState`, `DatabaseValueError`;
    - `ENGINE_SCHEMA_KEY`, `ENGINE_SCHEMA_VERSION`, `InstanceFor`, `isMissingSchemaError`, `MAX_SHARDS`, `migrateSchema`, `normalizeStoredValue`;
    - `ReadRange`, `ResolvedReference`, `resolveSchema`, `SchemaModule`, `settingsStatements`, `SHARD_COLUMN`, `validateSchema`, `withSchemaFence`.
  - No package has an internal entry: `@hot-updater/plugin-core/internal`, `@hot-updater/plugin-insights/internal`, and `@hot-updater/plugin-api-keys/internal` are removed, and `@hot-updater/plugin-insights/testing` too. A package uses another only through its public API. `InsightsBadRequestError`, which Insights' API throws for an input it refuses, is exported from `@hot-updater/plugin-insights/server`.
  - `@hot-updater/plugin-core` exports `createEngine(database, { plugins, now })`, the storage engine as `createHotUpdater` runs it: core's tables and the plugins', the plugins' settings rows behind the schema fence, expired rows pruned during writes, and batched aggregates. `meterReads(database)` meters any database on the engine, a provider's included, for adapter cost analysis. `database.measureReads(read)` reports what a call read at the adapter and at the engine. Aggregate batching's compaction and flush reads during the call count.
  - An `EngineDatabase` takes an optional `retry`, which `createEngineDatabase` also takes: how a transaction that conflicts with another write runs again, with `onRetry` to observe each rerun. A store many writers contend on can take more attempts.
  - `MemoryAdapterOptions` keeps only `tablePrefix`.
  - `@hot-updater/plugin-core` also exports what an adapter, a provider's tooling, or a plugin outside it needs: `SETTINGS_TABLE`, `aggregateBatchingTables`, and `encodeKvKey` for setups and access policies; `createEngineSqlMigrator`, `createSettingsMigrator`, `sqlTableShapes`, and `quoteSql` for ORM adapters; `DATABASE_VERSION_COLUMN`, `rowKey`, `findPhysicalIndex`, and `findPhysicalColumn` for an adapter that is neither SQL nor key-value; `compareUtf8` and `isDatabaseJsonObject` for plugins; the types `verifyAdapter` returns and throws; and the option and tooling types of its public functions. `createEngineDatabase` takes `readSettings` for an adapter that reads stored settings itself.
  - `CoreSchema`, core's tables as `createEngine`'s `core` handle types them, is part of `@hot-updater/plugin-core`'s API: a change to core's schema releases `@hot-updater/plugin-core` and ships with the migration `schema.core` versions.
  - `@hot-updater/test-utils` uses the other packages only through their public API. `createMeasuredDatabase(adapter, plugins, { now, storage })` returns a promise of core, the plugins' APIs, their `clientAuth`, and `measureReads`, from `createHotUpdater` over `meterReads({ name, adapter: verifyAdapter(adapter) })`; `now` is the plugins' clock. `setupReadBudgetTestSuite` takes no `server`, and its `createAdapter` gets `SETTINGS_TABLE` among its `tables`. `createPluginTestHarness` and `setupAggregateBatchingTestSuite` run on `createEngine` and take no `engine`; the harness runs no retention passes. It also exports `createMemoryKeyValueStore`, the database fixtures, and the Insights suites, and `@hot-updater/test-utils/node` the SQL test executors and `createD1TestDatabase(db, statements)`, a D1 database over `node:sqlite`. `@hot-updater/server` and `@hot-updater/plugin-insights` are optional peer dependencies.
  - Published packages leave out specs and test helpers:
    - `@hot-updater/server` publishes `dist` only.
    - `@hot-updater/cloudflare`, `@hot-updater/supabase`, and `@hot-updater/react-native` leave their specs out of the source they ship.
    - `@hot-updater/react-native` also leaves out its Android unit tests.
    - `@hot-updater/cloudflare`'s D1 test database moves to `@hot-updater/test-utils/node`.
  - `@hot-updater/postgres` and `@hot-updater/console` import the storage engine kit and the plugin types from `@hot-updater/plugin-core`.

- Updated dependencies [c9cfed7]
- Updated dependencies [5ec6796]
- Updated dependencies [f185d6d]
- Updated dependencies [f185d6d]
- Updated dependencies [4d15862]
- Updated dependencies [61fcd51]
  - @hot-updater/protocol@1.0.0-rc.21
  - @hot-updater/plugin-insights@1.0.0-rc.21

## 1.0.0-rc.17

### Minor Changes

- d7f1688: Insights reporting moves out of the SDK core into a client plugin, and the core gains a plugin API. This is a breaking change in the release candidate with no compatibility layer, and it needs a new native app build: update the app and the server together.
  - **Client plugins:** `HotUpdater.init` and `HotUpdater.wrap` take `plugins`. A plugin, declared with `defineClientPlugin`, has a unique `id` and a `setup(context)` that runs once and returns hooks: `onAppReady` (the launch: `UNCHANGED` with the running bundle and Release, or `UPDATE_APPLIED`/`RECOVERED` with the transition, and on Android 11+ `previousProcessExit`, why the previous process exited), `onUpdateCheck` (a check that found nothing, a same-bundle Release adoption, or an available update), `onBundleDownloaded` (with `delivery`: `patch`, `manifest`, or `archive`, and `patchFallback`), and `onUpdateError`. Hooks only observe: the SDK never waits for one, a hook that throws or rejects is reported through `onError` or a console warning, and events after a launch reach plugins after that launch's `onAppReady`. The context has `fetch(path, init)` under `baseURL` with `requestHeaders` and `requestTimeout`, the install id, platform, app and SDK versions, `isDebugBuild`, bundle, channel, cohort, and fingerprint getters, `now()`, and `storage`, a persistent key-value store scoped to the plugin (values up to 64 KB).
  - **Update failures:** `onUpdateError` receives `{ stage, reason, resource?, httpStatus?, originCode?, transport?, previousProcessExit?, targetBundleId?, targetReleaseId?, channel, bundleId, releaseId, updateStrategy, cause }`. `stage` is `check`, `download` (transfer and verification), or `install` (patch, extract, move into place); `reason` is `network`, `http`, `invalid_response`, `hash_mismatch`, `signature`, `patch`, `extract`, `storage`, or `unknown`; `resource` is what was being fetched or applied (`catalog`, `artifact`, `manifest`, `file`, `patch`, or `archive`); `originCode` is a storage origin's error code such as `ExpiredToken`; and `transport` says why no response arrived. iOS and Android attach the classification to `updateBundle` rejections in `userInfo`, and `updateBundle` in native resolves with how the bundle arrived. A stale selection or a bundle in crash history is not a failure, and a catalog request answered `404` with `x-hot-updater-catalog: none` means the scope has no update yet, not a failure. On iOS, a download answered with an HTTP error status now rejects with `DOWNLOAD_FAILED` instead of failing verification as `SIGNATURE_VERIFICATION_FAILED`.
  - **Insights plugin:** import `insights` from `@hot-updater/react-native/plugins/insights` and pass it in `plugins`; apps without it send no Insights requests. `insights({ debug })` reports from debug builds only with `debug: true`. `setUser({ userId })` or `setUser(null)` on the plugin replaces `HotUpdater.setUser`; it works before `init`, and `username` is gone. The plugin sends `UNCHANGED` at most once per UTC day while the channel, app version, bundle, Release, and user stay the same; downloads, applies, and recoveries always send. After the server answers `POST /events` with `404`, as a server without `insights()` does, it sends nothing for the rest of that runtime and for 24 hours, then tries again. It reports `UPDATE_FAILED` at most once per UTC day for each stage, reason, and target bundle, under an event id derived from them, with the failure's details in `metadata.failure`; it skips checks that failed offline, drops a failure once a download or apply of the same target is reported, and drops the event quietly when a server answers `400`. `UPDATE_DOWNLOADED` carries `metadata.delivery` and `metadata.patchFallback`, and `RECOVERED` carries `metadata.previousProcessExit` on Android 11+. Retries are unchanged: up to three attempts for a network error, timeout, `429`, or `5xx`, under one event id.
  - **Removed from the core:** the `insights` option of `init` and `wrap`, `HotUpdater.setUser`, and the `SetUserParams` type. The native module drops `getUserId`, `getUsername`, and `setUser` and adds `getStorageItem` and `setStorageItem`.
  - **Install id:** `HotUpdater.getInstallId()` now reads an id stored outside device backups (Application Support with `isExcludedFromBackup` on iOS, `noBackupFilesDir` on Android), as is the plugin storage. The id is not carried over from earlier release candidates, so an updated app reports under a new install id.

### Patch Changes

- 2493974: Bundle downloads retry a transient failure on both platforms. Android's retry loop never ran, because each attempt returned its error instead of throwing it, and iOS had no retry. A manifest, file, or patch download that fails with a network error, a timeout, a body that ended early, or a `408`, `429`, or `5xx` answer is now tried up to three times in all, 1 and then 2 seconds apart. Another `4xx`, a TLS failure, a cancelled download, and a local storage failure are not retried, and the archive, which falls back to per-file downloads, is tried once. A failure that remains keeps its update-failure classification.
- b4124e7: Stop re-rendering the wrapped app on download progress updates. `HotUpdater.wrap` now subscribes to progress only inside the fallback component and the `onProgress` reporter.
- Updated dependencies [e696e69]
- Updated dependencies [1ddd5fc]
- Updated dependencies [9a6715f]
- Updated dependencies [530cca5]
  - @hot-updater/plugin-core@1.0.0-rc.17

## 1.0.0-rc.16

### Patch Changes

- d482b13: Retry Insights reports, give each one an `eventId`, and keep debug builds out of production Insights.
  - **Retries:** a report that fails with a network error, a timeout, `429`, or a `5xx` is retried in the background, up to three attempts in all: about 1 s and then 2 s apart with jitter, or after the server's `Retry-After`, capped at 30 s. Each attempt keeps its own `requestTimeout`; any other status, such as `400`, is not retried. Startup, `onNotifyAppReady`, and `updateBundle()` still wait at most for a first attempt, never for a backoff. Reports leave one at a time in order, so a retried `UPDATE_APPLIED` cannot land after a later `UPDATE_DOWNLOADED`, and a warning is logged when a report is dropped.
  - **`eventId`:** every report carries a client-generated UUIDv7 `eventId`, the same on every attempt, so a server that deduplicates on it counts a retried report once. A server that rejects unknown payload keys answers `400` and the report is dropped, so upgrade `@hot-updater/server` with the SDK; an adapter that implements `POST /events` itself must accept or ignore the key.
  - **Debug builds:** when `__DEV__` is `true`, `HotUpdater.init` and `HotUpdater.wrap` send no Insights reports unless `insights: { debug: true }` is set. `insights: false` still turns reporting off everywhere, and `{ debug: true }` behaves like `true` in a release build.

- Updated dependencies [d482b13]
- Updated dependencies [d482b13]
- Updated dependencies [fe03f59]
- Updated dependencies [d482b13]
- Updated dependencies [2431c0a]
- Updated dependencies [ad00722]
- Updated dependencies [d482b13]
- Updated dependencies [d482b13]
- Updated dependencies [f6ffb68]
- Updated dependencies [c68e9f3]
- Updated dependencies [065c457]
- Updated dependencies [8a03eb2]
- Updated dependencies [aee193e]
- Updated dependencies [228b6c7]
- Updated dependencies [065c457]
- Updated dependencies [df31037]
  - @hot-updater/plugin-core@1.0.0-rc.16

## 1.0.0-rc.15

### Minor Changes

- f5fffea: Add atomic Release Insights aggregates, direct release-health and app-usage
  queries, and the redesigned Insights console without reconstructing metrics from
  raw event history.

### Patch Changes

- 333188a: Recover from an unverified OTA bundle that never reaches its first render after the app is killed. Persist native launch progress on iOS and Android and roll back on the next cold start even without a crash marker. Requires rebuilding the native app; terminating before first render counts as a failed launch.
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

- Updated dependencies [f5fffea]
- Updated dependencies [79c3eea]
  - @hot-updater/plugin-core@1.0.0-rc.15
  - @hot-updater/core@1.0.0-rc.15

## 1.0.0-rc.14

### Minor Changes

- 479c1e5: Report completed bundle downloads separately from applied updates. Persist the running bundle and pending selection, show Downloaded as waiting to apply, and keep Active, Downloaded, and Recovered totals visible above the activity chart tabs. Defer automatic No change reports until the update check finishes. Keep the unreleased 1.0.0 schema in its existing single initialization migration.

### Patch Changes

- Align all Hot Updater packages on 1.0.0-rc.14 for a coordinated release candidate. Future releases continue to use independent package versions.
- b23db5e: Drain queued iOS surface starts before recovery and prevent failed runtimes from
  starting surfaces or reporting readiness. Preserve fatal error handling when
  recovery cannot proceed and prevent delayed content events from verifying a
  crashing bundle. Serialize Android recovery decisions, publish complete crash
  markers before restarting, and preserve exception hooks in minified builds.
- Updated dependencies [479c1e5]
- Updated dependencies
- Updated dependencies [b23db5e]
  - @hot-updater/plugin-core@1.0.0-rc.14
  - @hot-updater/core@1.0.0-rc.14

## 1.0.0-rc.4

### Patch Changes

- 663d8e9: Finalize the unreleased v1 Insights contract with three event types: UPDATE_APPLIED, UNCHANGED, and RECOVERED. Same-file release selection reports UNCHANGED with null source bundle and update strategy while retaining release IDs. Remove RELEASE_ADOPTED from SDK payloads, server ingestion, database validators, and initial v1 schemas. No compatibility alias is accepted.

  Replace adopted outcomes and counters with unchanged in the Insights query API. Refresh all v1 SDK and infrastructure packages together; existing prerelease development databases require their obsolete event rows and constraints to be updated before using this contract.

- Updated dependencies [663d8e9]
  - @hot-updater/plugin-core@1.0.0-rc.3

## 1.0.0-rc.3

### Patch Changes

- f48521a: Align the console ID, `HotUpdater.getBundleId()`, update-check results, completion callbacks, and `bundle list/show` with the selected update identity so promotions sharing an artifact remain distinguishable. The getter can reflect a staged update before reload. Remove the prerelease `getReleaseId()` getter, keep artifact and crash identities unchanged, and move Artifact IDs into Advanced diagnostics. `bundle list --json` returns the internal rows, and `bundle show` accepts the console ID. Use `HotUpdater.getManifest().bundleId` for BugSnag sourcemap matching.
- Updated dependencies [51300d4]
- Updated dependencies [590ca70]
- Updated dependencies [a837c71]
  - @hot-updater/plugin-core@1.0.0-rc.2

## 1.0.0-rc.2

### Minor Changes

- 6d0cdc7: Rename the built-in Analytics domain to Insights across the database model,
  server provider and HTTP query route, React Native option and transport,
  Console route and UI, and provider contracts. This is a breaking pre-release
  rename with no compatibility aliases; use `database.models.insights`,
  `createInsightsProvider`, `/bundles/:id/events/insights`, and `insights`.

  Enable React Native Insights reporting by default for both `HotUpdater.init`
  and `HotUpdater.wrap`. Set `insights: false` to opt out.

### Patch Changes

- daacef2: Normalize an omitted native fingerprint constant to `null` so app-version analytics events keep the required payload field.
- Updated dependencies [6d0cdc7]
- Updated dependencies [8145d48]
  - @hot-updater/plugin-core@1.0.0-rc.1

## 1.0.0-rc.1

### Patch Changes

- eafb30c: Keep `HotUpdater.getMinBundleId()` as the public build-time bundle floor API.

## 1.0.0-rc.0

### Major Changes

- adb0e40: Release HotUpdater 1.0 with the Release Catalog architecture.

### Minor Changes

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

- ebe1f64: Add Analytics as a built-in `createHotUpdater` domain backed directly by the
  official `database.models.analytics` port. Event ingestion, bounded aggregation,
  installation search, HTTP routes, and Console views now live with the server;
  there is no Analytics plugin, provider override, universal component schema, or
  separate `@hot-updater/analytics` package.

  Runtime Analytics ingestion and query routes are always available. The former
  server-side `analytics` and `routes` options are removed.

  Database providers own the physical `bundle_events` table through the shared
  database contract and schema version.
  Event ingestion lives on `handlers.client`; queries live on
  `handlers.admin` and rely on the framework middleware protecting that mount.

  React Native clients can enable automatic OTA transition and Release adoption
  reporting by setting `analytics: true` in either `HotUpdater.init` or
  `HotUpdater.wrap`. Omitting the option or setting it to `false` sends no events.
  App-ready transitions retain stable installation and optional user identity
  across launches, and analytics delivery failures remain warning-only so they
  never block application startup.

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

- 3b367e7: Make `baseURL` the only React Native network source. Remove the `resolver` and
  client-side `authorityId` options, `HotUpdaterResolver`, its public
  parameter/result helper types, and `createDefaultResolver`. Custom GraphQL,
  RPC, and other backends must expose the v1 HTTP protocol through an adapter or
  proxy and pass that endpoint as `baseURL`.

  Report a one-time `console.error` when an app configures both `HotUpdater.init`
  and `HotUpdater.wrap`. Use `init + checkForUpdate` for custom or manual update
  flows, or use `wrap` for the automatic HOC flow; do not combine them.

  Remove authority from the public Release Catalog client paths. Catalog
  identity is managed automatically in persistence, while the
  client fetches `/release-catalogs/app-version/:platform/:channelKey/:appVersion`
  or `/release-catalogs/fingerprint/:platform/:channelKey/:fingerprintHash`.

- a9ffb2a: Remove leftover v0 aliases that are not field compatibility. `HotUpdater.wrap({ updateMode: "manual" })` throws, findMany accepts only `orderBy`, and Supabase plugins require `supabaseServiceRoleKey`. Managed init still detects leftover `supabaseAnonKey` so skipped v0 configs fail closed.
- f5f7de7: Move the Expo config plugin from `@hot-updater/react-native` to
  `@hot-updater/expo`. Configure Expo apps with `@hot-updater/expo` in the
  `plugins` array of `app.json` or `app.config.js`.

### Patch Changes

- 19b7e67: Reject incomplete manifest-driven bundles before installing or launching them.
- dd659b5: Handle standard trailing slashes on Android archive directory entries without treating them as malicious paths.
- e69c128: Preserve nested iOS bundle paths when installing and resolving cached updates.
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

- b56a75a: Fix Android TAR extraction for long paths stored in POSIX PAX headers.
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

- Updated dependencies [9759e8a]
  - @hot-updater/cli-tools@0.36.0
  - @hot-updater/plugin-core@0.36.0
  - @hot-updater/core@0.36.0
  - @hot-updater/js@0.36.0

## 0.35.12

### Patch Changes

- Updated dependencies [fd30452]
- Updated dependencies [6e8b32e]
  - @hot-updater/cli-tools@0.35.12
  - @hot-updater/js@0.35.12
  - @hot-updater/plugin-core@0.35.12
  - @hot-updater/core@0.35.12

## 0.35.11

### Patch Changes

- Updated dependencies [1a3a621]
  - @hot-updater/plugin-core@0.35.11
  - @hot-updater/cli-tools@0.35.11
  - @hot-updater/core@0.35.11
  - @hot-updater/js@0.35.11

## 0.35.10

### Patch Changes

- Updated dependencies [ce8d254]
  - @hot-updater/plugin-core@0.35.10
  - @hot-updater/cli-tools@0.35.10
  - @hot-updater/core@0.35.10
  - @hot-updater/js@0.35.10

## 0.35.9

### Patch Changes

- Updated dependencies [8688b1a]
- Updated dependencies [f9bb26d]
  - @hot-updater/cli-tools@0.35.9
  - @hot-updater/core@0.35.9
  - @hot-updater/js@0.35.9
  - @hot-updater/plugin-core@0.35.9

## 0.35.8

### Patch Changes

- 5eccd71: Serialize iOS old-architecture bridge teardown before reloading.
- Updated dependencies [4f9fab2]
  - @hot-updater/cli-tools@0.35.8
  - @hot-updater/core@0.35.8
  - @hot-updater/js@0.35.8
  - @hot-updater/plugin-core@0.35.8

## 0.35.7

### Patch Changes

- f166881: Preserve brotli decoder when Android minification is actived
  - @hot-updater/cli-tools@0.35.7
  - @hot-updater/core@0.35.7
  - @hot-updater/js@0.35.7
  - @hot-updater/plugin-core@0.35.7

## 0.35.6

### Patch Changes

- ae255f8: fix(android): run manifest-driven bundle installation on the I/O dispatcher
  - @hot-updater/cli-tools@0.35.6
  - @hot-updater/core@0.35.6
  - @hot-updater/js@0.35.6
  - @hot-updater/plugin-core@0.35.6

## 0.35.5

### Patch Changes

- 7c12f39: fix(android): ensure BsdiffPatch.apply runs on Dispatchers.IO to prevent ANR
  - @hot-updater/cli-tools@0.35.5
  - @hot-updater/core@0.35.5
  - @hot-updater/js@0.35.5
  - @hot-updater/plugin-core@0.35.5

## 0.35.4

### Patch Changes

- 7cacd77: fix(react-native): coalesce progress store notifications
  - @hot-updater/cli-tools@0.35.4
  - @hot-updater/core@0.35.4
  - @hot-updater/js@0.35.4
  - @hot-updater/plugin-core@0.35.4

## 0.35.3

### Patch Changes

- @hot-updater/cli-tools@0.35.3
- @hot-updater/core@0.35.3
- @hot-updater/js@0.35.3
- @hot-updater/plugin-core@0.35.3

## 0.35.2

### Patch Changes

- @hot-updater/cli-tools@0.35.2
- @hot-updater/core@0.35.2
- @hot-updater/js@0.35.2
- @hot-updater/plugin-core@0.35.2

## 0.35.1

### Patch Changes

- 8b91835: Fix the Expo config plugin to read EAS private key secret files from the `HOT_UPDATER_PRIVATE_KEY` environment variable.
  - @hot-updater/cli-tools@0.35.1
  - @hot-updater/core@0.35.1
  - @hot-updater/js@0.35.1
  - @hot-updater/plugin-core@0.35.1

## 0.35.0

### Patch Changes

- @hot-updater/cli-tools@0.35.0
- @hot-updater/core@0.35.0
- @hot-updater/js@0.35.0
- @hot-updater/plugin-core@0.35.0

## 0.34.0

### Minor Changes

- 95e0119: feat(react-native): add native programmatic configuration for brownfield apps

  Add `HotUpdater.configure(...)` on Android (`newarch`/`oldarch`) and iOS so brownfield / prebuilt-framework hosts can supply `fingerprintHash`, `publicKey`, and `channel` at runtime instead of relying on the host app's `AndroidManifest`/`strings.xml` or `Info.plist`, which the RN module cannot control when shipped as an AAR/XCFramework.

  It also adds an optional `isolationKey` override. The default OTA storage isolation key embeds the host app version, so every native release invalidates the OTA cache and falls back to the binary-embedded bundle. A stable, version-independent key (e.g. keyed by fingerprint + channel) keeps downloaded updates across host app version bumps.

  All overrides are opt-in and default to `null`/unset, so existing manifest/`Info.plist`-driven setups are unaffected.

### Patch Changes

- Updated dependencies [088f6c1]
- Updated dependencies [7244b65]
  - @hot-updater/plugin-core@0.34.0
  - @hot-updater/core@0.34.0
  - @hot-updater/cli-tools@0.34.0
  - @hot-updater/js@0.34.0

## 0.33.2

### Patch Changes

- @hot-updater/cli-tools@0.33.2
- @hot-updater/core@0.33.2
- @hot-updater/js@0.33.2
- @hot-updater/plugin-core@0.33.2

## 0.33.1

### Patch Changes

- Updated dependencies [a5c4467]
  - @hot-updater/plugin-core@0.33.1
  - @hot-updater/cli-tools@0.33.1
  - @hot-updater/core@0.33.1
  - @hot-updater/js@0.33.1

## 0.33.0

### Patch Changes

- 4f7c0c4: Relocate the bundled Android Brotli decoder to avoid duplicate classes with apps that depend on `org.brotli:dec`.
- Updated dependencies [070a86f]
- Updated dependencies [e914f56]
  - @hot-updater/cli-tools@0.33.0
  - @hot-updater/plugin-core@0.33.0
  - @hot-updater/core@0.33.0
  - @hot-updater/js@0.33.0

## 0.32.0

### Patch Changes

- 499e139: Harden self-hosted bundle management and native bundle extraction.

  Bundle management routes are now disabled by default and require an
  explicit `routes.bundles: true` opt-in when enabled. Protect those routes with
  framework middleware or an equivalent reverse-proxy/auth layer. Bundle list
  requests also validate `limit` against a bounded range.

  Android and iOS bundle extraction now reject unsafe archive entries and
  manifest asset paths before writing or reusing files.

- Updated dependencies [4e6d2ec]
  - @hot-updater/cli-tools@0.32.0
  - @hot-updater/plugin-core@0.32.0
  - @hot-updater/core@0.32.0
  - @hot-updater/js@0.32.0

## 0.31.4

### Patch Changes

- f74c6f4: fix(android): mark channel string non-translatable
  - @hot-updater/cli-tools@0.31.4
  - @hot-updater/core@0.31.4
  - @hot-updater/js@0.31.4
  - @hot-updater/plugin-core@0.31.4

## 0.31.3

### Patch Changes

- @hot-updater/cli-tools@0.31.3
- @hot-updater/core@0.31.3
- @hot-updater/js@0.31.3
- @hot-updater/plugin-core@0.31.3

## 0.31.2

### Patch Changes

- @hot-updater/cli-tools@0.31.2
- @hot-updater/core@0.31.2
- @hot-updater/js@0.31.2
- @hot-updater/plugin-core@0.31.2

## 0.31.1

### Patch Changes

- @hot-updater/cli-tools@0.31.1
- @hot-updater/core@0.31.1
- @hot-updater/js@0.31.1
- @hot-updater/plugin-core@0.31.1

## 0.31.0

### Minor Changes

- 5b0a0f5: Add signed manifest-based diff update support across deploy, server, provider storage, console tooling, and React Native runtime.
- 5b0a0f5: Add Hermes bundle patch metadata and runtime BSDIFF patch application support.

### Patch Changes

- e975b3f: chore(react-native): deprecated wrap updateMode
- 5b0a0f5: feat: add internal files directory retrieval in FileManagerService
- Updated dependencies [5b0a0f5]
- Updated dependencies [5b0a0f5]
  - @hot-updater/core@0.31.0
  - @hot-updater/cli-tools@0.31.0
  - @hot-updater/js@0.31.0
  - @hot-updater/plugin-core@0.31.0

## 0.30.12

### Patch Changes

- 1498fe3: feat(react-native): support dynamic `baseURL` resolvers for `HotUpdater.init`
  and `HotUpdater.wrap`

  `baseURL` can now be a string or a function returning a string or promise. The
  default resolver calls the function before each update check so apps can resolve
  the update server URL at runtime.
  - @hot-updater/cli-tools@0.30.12
  - @hot-updater/core@0.30.12
  - @hot-updater/js@0.30.12
  - @hot-updater/plugin-core@0.30.12

## 0.30.11

### Patch Changes

- @hot-updater/cli-tools@0.30.11
- @hot-updater/core@0.30.11
- @hot-updater/js@0.30.11
- @hot-updater/plugin-core@0.30.11

## 0.30.10

### Patch Changes

- @hot-updater/cli-tools@0.30.10
- @hot-updater/core@0.30.10
- @hot-updater/js@0.30.10
- @hot-updater/plugin-core@0.30.10

## 0.30.9

### Patch Changes

- e10d15f: fix(react-native): HotUpdater.init type
  - @hot-updater/cli-tools@0.30.9
  - @hot-updater/core@0.30.9
  - @hot-updater/js@0.30.9
  - @hot-updater/plugin-core@0.30.9

## 0.30.8

### Patch Changes

- Updated dependencies [6019156]
  - @hot-updater/cli-tools@0.30.8
  - @hot-updater/plugin-core@0.30.8
  - @hot-updater/core@0.30.8
  - @hot-updater/js@0.30.8

## 0.30.7

### Patch Changes

- f22ab70: Prevent duplicate progress events from notifying the React Native store when
  the computed update state has not changed.
- 03fd179: Run the `hot-updater` CLI from native ESM on Node 20 so TypeScript config
  files load through ESM import conditions.

  Require Node.js 20.19.0 or newer for the CLI package surface.

  Run the `hot-updater` CLI bin from the native ESM entrypoint and stop emitting
  a CommonJS build for the CLI entry.

  Bump the `hot-updater` CLI package's vulnerable `kysely` and
  `fast-xml-parser` dependency entries to patched versions without pnpm
  overrides.

- Updated dependencies [03fd179]
  - @hot-updater/cli-tools@0.30.7
  - @hot-updater/core@0.30.7
  - @hot-updater/js@0.30.7
  - @hot-updater/plugin-core@0.30.7

## 0.30.6

### Patch Changes

- @hot-updater/cli-tools@0.30.6
- @hot-updater/core@0.30.6
- @hot-updater/js@0.30.6
- @hot-updater/plugin-core@0.30.6

## 0.30.5

### Patch Changes

- 6e2892f: fix(android): export resetChannel in old arch
  - @hot-updater/cli-tools@0.30.5
  - @hot-updater/core@0.30.5
  - @hot-updater/js@0.30.5
  - @hot-updater/plugin-core@0.30.5

## 0.30.4

### Patch Changes

- b2db3ca: fix(react-native): always delegate resetChannel to native
  - @hot-updater/cli-tools@0.30.4
  - @hot-updater/core@0.30.4
  - @hot-updater/js@0.30.4
  - @hot-updater/plugin-core@0.30.4

## 0.30.3

### Patch Changes

- 2f32e43: feat: add internal files directory retrieval in FileManagerService
  - @hot-updater/cli-tools@0.30.3
  - @hot-updater/core@0.30.3
  - @hot-updater/js@0.30.3
  - @hot-updater/plugin-core@0.30.3

## 0.30.2

### Patch Changes

- 763d2b2: fix(native): launched bundle identity reporting
  - @hot-updater/cli-tools@0.30.2
  - @hot-updater/core@0.30.2
  - @hot-updater/js@0.30.2
  - @hot-updater/plugin-core@0.30.2

## 0.30.1

### Patch Changes

- @hot-updater/cli-tools@0.30.1
- @hot-updater/core@0.30.1
- @hot-updater/js@0.30.1
- @hot-updater/plugin-core@0.30.1

## 0.30.0

### Minor Changes

- 83c01c8: fix: keep target cohorts additive to rollout

### Patch Changes

- Updated dependencies [83c01c8]
  - @hot-updater/core@0.30.0
  - @hot-updater/cli-tools@0.30.0
  - @hot-updater/js@0.30.0
  - @hot-updater/plugin-core@0.30.0

## 0.29.8

### Patch Changes

- @hot-updater/cli-tools@0.29.8
- @hot-updater/core@0.29.8
- @hot-updater/js@0.29.8
- @hot-updater/plugin-core@0.29.8

## 0.29.7

### Patch Changes

- 8301941: fix(android): handle downloads without content length
  - @hot-updater/cli-tools@0.29.7
  - @hot-updater/core@0.29.7
  - @hot-updater/js@0.29.7
  - @hot-updater/plugin-core@0.29.7

## 0.29.6

### Patch Changes

- Updated dependencies [80cce61]
  - @hot-updater/cli-tools@0.29.6
  - @hot-updater/core@0.29.6
  - @hot-updater/js@0.29.6
  - @hot-updater/plugin-core@0.29.6

## 0.29.5

### Patch Changes

- b653286: fix(ios): avoid false invalid zip errors during bundle extraction
- Updated dependencies [52208f4]
  - @hot-updater/plugin-core@0.29.5
  - @hot-updater/cli-tools@0.29.5
  - @hot-updater/core@0.29.5
  - @hot-updater/js@0.29.5

## 0.29.4

### Patch Changes

- aa96e1a: fix(android): oldarch sync methods crash with WritableNativeMap/Array return types
  - @hot-updater/cli-tools@0.29.4
  - @hot-updater/core@0.29.4
  - @hot-updater/js@0.29.4
  - @hot-updater/plugin-core@0.29.4

## 0.29.3

### Patch Changes

- b4b2078: fix(ios): improve archive validation and download persistence
- b4b2078: fix(react-native): stream ios bundle extraction work after download
- Updated dependencies [d1ffb83]
  - @hot-updater/plugin-core@0.29.3
  - @hot-updater/cli-tools@0.29.3
  - @hot-updater/core@0.29.3
  - @hot-updater/js@0.29.3

## 0.29.2

### Patch Changes

- Updated dependencies [2a1bc80]
  - @hot-updater/cli-tools@0.29.2
  - @hot-updater/core@0.29.2
  - @hot-updater/js@0.29.2
  - @hot-updater/plugin-core@0.29.2

## 0.29.1

### Patch Changes

- @hot-updater/cli-tools@0.29.1
- @hot-updater/core@0.29.1
- @hot-updater/js@0.29.1
- @hot-updater/plugin-core@0.29.1

## 0.29.0

### Minor Changes

- a935992: feat: Rollout feature with control from 1% to 100%

### Patch Changes

- d0fe908: fix(console): rebuild copied bundles with fresh uuidv7 ids
- Updated dependencies [a935992]
- Updated dependencies [d0fe908]
  - @hot-updater/plugin-core@0.29.0
  - @hot-updater/cli-tools@0.29.0
  - @hot-updater/core@0.29.0
  - @hot-updater/js@0.29.0

## 0.28.0

### Minor Changes

- 09e3217: fix(react-native): improve rollback recovery

### Patch Changes

- @hot-updater/cli-tools@0.28.0
- @hot-updater/core@0.28.0
- @hot-updater/js@0.28.0
- @hot-updater/plugin-core@0.28.0

## 0.27.1

### Patch Changes

- @hot-updater/cli-tools@0.27.1
- @hot-updater/core@0.27.1
- @hot-updater/js@0.27.1
- @hot-updater/plugin-core@0.27.1

## 0.27.0

### Minor Changes

- 81f9437: feat(android): for safe reloading, Android reloads the process (#869)

### Patch Changes

- Updated dependencies [81f9437]
  - @hot-updater/cli-tools@0.27.0
  - @hot-updater/core@0.27.0
  - @hot-updater/js@0.27.0
  - @hot-updater/plugin-core@0.27.0

## 0.26.2

### Patch Changes

- @hot-updater/cli-tools@0.26.2
- @hot-updater/core@0.26.2
- @hot-updater/js@0.26.2
- @hot-updater/plugin-core@0.26.2

## 0.26.1

### Patch Changes

- 041236c: fix(android): use \_jsBundleLoader backing field for Expo SDK 55+ compatibility
  - @hot-updater/cli-tools@0.26.1
  - @hot-updater/core@0.26.1
  - @hot-updater/js@0.26.1
  - @hot-updater/plugin-core@0.26.1

## 0.26.0

### Minor Changes

- c43a01d: feat(react-native): runtime channel switch

### Patch Changes

- @hot-updater/cli-tools@0.26.0
- @hot-updater/core@0.26.0
- @hot-updater/js@0.26.0
- @hot-updater/plugin-core@0.26.0

## 0.25.14

### Patch Changes

- @hot-updater/cli-tools@0.25.14
- @hot-updater/core@0.25.14
- @hot-updater/js@0.25.14
- @hot-updater/plugin-core@0.25.14

## 0.25.13

### Patch Changes

- @hot-updater/cli-tools@0.25.13
- @hot-updater/core@0.25.13
- @hot-updater/js@0.25.13
- @hot-updater/plugin-core@0.25.13

## 0.25.12

### Patch Changes

- @hot-updater/cli-tools@0.25.12
- @hot-updater/core@0.25.12
- @hot-updater/js@0.25.12
- @hot-updater/plugin-core@0.25.12

## 0.25.11

### Patch Changes

- 70f3057: Add namespace fallback for string resource lookup
  - @hot-updater/cli-tools@0.25.11
  - @hot-updater/core@0.25.11
  - @hot-updater/js@0.25.11
  - @hot-updater/plugin-core@0.25.11

## 0.25.10

### Patch Changes

- Updated dependencies [90f9610]
- Updated dependencies [03c5adc]
  - @hot-updater/cli-tools@0.25.10
  - @hot-updater/plugin-core@0.25.10
  - @hot-updater/core@0.25.10
  - @hot-updater/js@0.25.10

## 0.25.9

### Patch Changes

- bd288a8: fix(android): brotil embed android for vulnerability
- Updated dependencies [6b22072]
  - @hot-updater/plugin-core@0.25.9
  - @hot-updater/cli-tools@0.25.9
  - @hot-updater/core@0.25.9
  - @hot-updater/js@0.25.9

## 0.25.8

### Patch Changes

- e7d3ffc: Add `bundle` parameter for XCFramework brownfield support on iOS
  - @hot-updater/cli-tools@0.25.8
  - @hot-updater/core@0.25.8
  - @hot-updater/js@0.25.8
  - @hot-updater/plugin-core@0.25.8

## 0.25.7

### Patch Changes

- 2922917: fix(iOS): Download progress percentage not displayed on iOS during OTA updates
- 17bc46a: feat(react-native): add brownfield support via HotUpdater.setReactHost()
  - @hot-updater/cli-tools@0.25.7
  - @hot-updater/core@0.25.7
  - @hot-updater/js@0.25.7
  - @hot-updater/plugin-core@0.25.7

## 0.25.6

### Patch Changes

- @hot-updater/cli-tools@0.25.6
- @hot-updater/core@0.25.6
- @hot-updater/js@0.25.6
- @hot-updater/plugin-core@0.25.6

## 0.25.5

### Patch Changes

- @hot-updater/cli-tools@0.25.5
- @hot-updater/core@0.25.5
- @hot-updater/js@0.25.5
- @hot-updater/plugin-core@0.25.5

## 0.25.4

### Patch Changes

- Updated dependencies [8c83ff2]
  - @hot-updater/cli-tools@0.25.4
  - @hot-updater/core@0.25.4
  - @hot-updater/js@0.25.4
  - @hot-updater/plugin-core@0.25.4

## 0.25.3

### Patch Changes

- @hot-updater/cli-tools@0.25.3
- @hot-updater/core@0.25.3
- @hot-updater/js@0.25.3
- @hot-updater/plugin-core@0.25.3

## 0.25.2

### Patch Changes

- 2c22c41: feat(expo): support bundle signing for eas build
  - @hot-updater/cli-tools@0.25.2
  - @hot-updater/core@0.25.2
  - @hot-updater/js@0.25.2
  - @hot-updater/plugin-core@0.25.2

## 0.25.1

### Patch Changes

- 820c276: fix(native): without request HEAD
  - @hot-updater/cli-tools@0.25.1
  - @hot-updater/core@0.25.1
  - @hot-updater/js@0.25.1
  - @hot-updater/plugin-core@0.25.1

## 0.25.0

### Minor Changes

- d22b48a: feat(expo): expo 'use dom' correct ota update

### Patch Changes

- @hot-updater/cli-tools@0.25.0
- @hot-updater/core@0.25.0
- @hot-updater/js@0.25.0
- @hot-updater/plugin-core@0.25.0

## 0.24.7

### Patch Changes

- 294e324: fix: update babel plugin path in documentation and plugin files
- Updated dependencies [294e324]
  - @hot-updater/cli-tools@0.24.7
  - @hot-updater/core@0.24.7
  - @hot-updater/js@0.24.7
  - @hot-updater/plugin-core@0.24.7

## 0.24.6

### Patch Changes

- Updated dependencies [9d7b6af]
  - @hot-updater/cli-tools@0.24.6
  - @hot-updater/core@0.24.6
  - @hot-updater/js@0.24.6
  - @hot-updater/plugin-core@0.24.6

## 0.24.5

### Patch Changes

- 93d3372: Use cachesDirectory on tvOS
  - @hot-updater/cli-tools@0.24.5
  - @hot-updater/core@0.24.5
  - @hot-updater/js@0.24.5
  - @hot-updater/plugin-core@0.24.5

## 0.24.4

### Patch Changes

- Updated dependencies [7ed539f]
  - @hot-updater/plugin-core@0.24.4
  - @hot-updater/cli-tools@0.24.4
  - @hot-updater/core@0.24.4
  - @hot-updater/js@0.24.4

## 0.24.3

### Patch Changes

- bbe71f7: Add tvOS support to HotUpdater
  - @hot-updater/cli-tools@0.24.3
  - @hot-updater/core@0.24.3
  - @hot-updater/js@0.24.3
  - @hot-updater/plugin-core@0.24.3

## 0.24.2

### Patch Changes

- 5a46549: fix(native): background update
  - @hot-updater/cli-tools@0.24.2
  - @hot-updater/core@0.24.2
  - @hot-updater/js@0.24.2
  - @hot-updater/plugin-core@0.24.2

## 0.24.1

### Patch Changes

- fe78d4f: feat(react-native): wrap with resolver
  - @hot-updater/cli-tools@0.24.1
  - @hot-updater/core@0.24.1
  - @hot-updater/js@0.24.1
  - @hot-updater/plugin-core@0.24.1

## 0.24.0

### Minor Changes

- 753208b: feat(native): notifyAppReady for auto rollback (invalid bundle)
- c51239c: fix(ios): getMinBundleId timezone issue

### Patch Changes

- @hot-updater/cli-tools@0.24.0
- @hot-updater/core@0.24.0
- @hot-updater/js@0.24.0
- @hot-updater/plugin-core@0.24.0

## 0.23.1

### Patch Changes

- 7fa9a20: feat(expo): bundle-signing supports cng plugin
  - @hot-updater/cli-tools@0.23.1
  - @hot-updater/core@0.23.1
  - @hot-updater/js@0.23.1
  - @hot-updater/plugin-core@0.23.1

## 0.23.0

### Minor Changes

- e41fb6b: feat: add bundle signing for cryptographic OTA verification

### Patch Changes

- Updated dependencies [e41fb6b]
  - @hot-updater/core@0.23.0
  - @hot-updater/js@0.23.0
  - @hot-updater/plugin-core@0.23.0
  - @hot-updater/cli-tools@0.23.0

## 0.22.2

### Patch Changes

- 82636ea: fix(expo): expo plugin transformer not found
  - hot-updater@0.22.2
  - @hot-updater/cli-tools@0.22.2
  - @hot-updater/core@0.22.2
  - @hot-updater/js@0.22.2
  - @hot-updater/plugin-core@0.22.2

## 0.22.1

### Patch Changes

- hot-updater@0.22.1
- @hot-updater/cli-tools@0.22.1
- @hot-updater/core@0.22.1
- @hot-updater/js@0.22.1
- @hot-updater/plugin-core@0.22.1

## 0.22.0

### Patch Changes

- hot-updater@0.22.0
- @hot-updater/cli-tools@0.22.0
- @hot-updater/core@0.22.0
- @hot-updater/js@0.22.0
- @hot-updater/plugin-core@0.22.0

## 0.21.15

### Patch Changes

- @hot-updater/cli-tools@0.21.15
- hot-updater@0.21.15
- @hot-updater/js@0.21.15
- @hot-updater/plugin-core@0.21.15
- @hot-updater/core@0.21.15

## 0.21.14

### Patch Changes

- 0b0152a: fix(ios): implement CustomNSError protocol for better error reporting…
  - hot-updater@0.21.14
  - @hot-updater/cli-tools@0.21.14
  - @hot-updater/core@0.21.14
  - @hot-updater/js@0.21.14
  - @hot-updater/plugin-core@0.21.14

## 0.21.13

### Patch Changes

- a6bda2b: refactor(expo): supports testcase RN82
- Updated dependencies [44f4e95]
  - hot-updater@0.21.13
  - @hot-updater/cli-tools@0.21.13
  - @hot-updater/core@0.21.13
  - @hot-updater/js@0.21.13
  - @hot-updater/plugin-core@0.21.13

## 0.21.12

### Patch Changes

- Updated dependencies [56e849b]
- Updated dependencies [5c4b98e]
  - hot-updater@0.21.12
  - @hot-updater/plugin-core@0.21.12
  - @hot-updater/cli-tools@0.21.12
  - @hot-updater/core@0.21.12
  - @hot-updater/js@0.21.12

## 0.21.11

### Patch Changes

- e2b67d7: fix(cli-tools): esm only package bundle
- Updated dependencies [d6c3a65]
- Updated dependencies [e2b67d7]
- Updated dependencies [2905e47]
  - @hot-updater/cli-tools@0.21.11
  - @hot-updater/core@0.21.11
  - hot-updater@0.21.11
  - @hot-updater/js@0.21.11
  - @hot-updater/plugin-core@0.21.11

## 0.21.10

### Patch Changes

- @hot-updater/cli-tools@0.21.10
- hot-updater@0.21.10
- @hot-updater/js@0.21.10
- @hot-updater/plugin-core@0.21.10
- @hot-updater/core@0.21.10

## 0.21.9

### Patch Changes

- Updated dependencies [396ae54]
- Updated dependencies [aa399a6]
  - hot-updater@0.21.9
  - @hot-updater/plugin-core@0.21.9
  - @hot-updater/cli-tools@0.21.9
  - @hot-updater/core@0.21.9
  - @hot-updater/js@0.21.9

## 0.21.8

### Patch Changes

- Updated dependencies [3fe8c81]
  - hot-updater@0.21.8
  - @hot-updater/plugin-core@0.21.8
  - @hot-updater/cli-tools@0.21.8
  - @hot-updater/core@0.21.8
  - @hot-updater/js@0.21.8

## 0.21.7

### Patch Changes

- 2b408f2: docs: revamp hot-updater.dev
- Updated dependencies [2b408f2]
  - @hot-updater/plugin-core@0.21.7
  - hot-updater@0.21.7
  - @hot-updater/core@0.21.7
  - @hot-updater/js@0.21.7

## 0.21.6

### Patch Changes

- 3e9681c: fix(android): Android API 25 compatibility with TarStream
- Updated dependencies [b12394d]
  - hot-updater@0.21.6
  - @hot-updater/core@0.21.6
  - @hot-updater/js@0.21.6
  - @hot-updater/plugin-core@0.21.6

## 0.21.5

### Patch Changes

- Updated dependencies [fc2bd56]
- Updated dependencies [a253498]
  - hot-updater@0.21.5
  - @hot-updater/core@0.21.5
  - @hot-updater/js@0.21.5
  - @hot-updater/plugin-core@0.21.5

## 0.21.4

### Patch Changes

- Updated dependencies [5d3070a]
  - @hot-updater/plugin-core@0.21.4
  - hot-updater@0.21.4
  - @hot-updater/js@0.21.4
  - @hot-updater/core@0.21.4

## 0.21.3

### Patch Changes

- c1125b4: chore(android): bump org.apache.commons:commons-compress:1.28.0
  - hot-updater@0.21.3
  - @hot-updater/core@0.21.3
  - @hot-updater/js@0.21.3
  - @hot-updater/plugin-core@0.21.3

## 0.21.2

### Patch Changes

- hot-updater@0.21.2
- @hot-updater/core@0.21.2
- @hot-updater/js@0.21.2
- @hot-updater/plugin-core@0.21.2

## 0.21.1

### Patch Changes

- Updated dependencies [7b7bc48]
  - @hot-updater/plugin-core@0.21.1
  - hot-updater@0.21.1
  - @hot-updater/core@0.21.1
  - @hot-updater/js@0.21.1

## 0.22.0

### Minor Changes

- 610b2dd: feat: supports `compressStrategy` => `tar.br` (brotli) / `tar.gz` (gzip)
- afb084b: feat: validate bundle file with fileHash

### Patch Changes

- Updated dependencies [610b2dd]
- Updated dependencies [afb084b]
- Updated dependencies [036f8f0]
  - hot-updater@0.22.0
  - @hot-updater/plugin-core@0.22.0
  - @hot-updater/core@0.22.0
  - @hot-updater/js@0.22.0

## 0.20.15

### Patch Changes

- Updated dependencies [526a5ba]
- Updated dependencies [ddf6f2c]
  - @hot-updater/plugin-core@0.20.15
  - hot-updater@0.20.15
  - @hot-updater/core@0.20.15
  - @hot-updater/js@0.20.15

## 0.20.14

### Patch Changes

- Updated dependencies [a61fa0e]
  - @hot-updater/plugin-core@0.20.14
  - hot-updater@0.20.14
  - @hot-updater/core@0.20.14
  - @hot-updater/js@0.20.14

## 0.20.13

### Patch Changes

- 05eeb89: feat(react-native): HotUpdater.isUpdateDownloaded()
  - hot-updater@0.20.13
  - @hot-updater/core@0.20.13
  - @hot-updater/js@0.20.13
  - @hot-updater/plugin-core@0.20.13

## 0.20.12

### Patch Changes

- 26be35b: fix: prevent re-download in js side
- f09a7ce: fix(android): await reload on ReactContextInitialized
  - hot-updater@0.20.12
  - @hot-updater/core@0.20.12
  - @hot-updater/js@0.20.12
  - @hot-updater/plugin-core@0.20.12

## 0.20.11

### Patch Changes

- afb3a6e: fix(fingerprint): separate fingerprint generation for cng
- Updated dependencies [afb3a6e]
- Updated dependencies [cb9c05b]
  - hot-updater@0.20.11
  - @hot-updater/plugin-core@0.20.11
  - @hot-updater/core@0.20.11
  - @hot-updater/js@0.20.11

## 0.20.10

### Patch Changes

- Updated dependencies [6b5435c]
  - hot-updater@0.20.10
  - @hot-updater/core@0.20.10
  - @hot-updater/js@0.20.10
  - @hot-updater/plugin-core@0.20.10

## 0.20.9

### Patch Changes

- a174bc5: Fix native code generation for Android when using Expo 54
  - hot-updater@0.20.9
  - @hot-updater/core@0.20.9
  - @hot-updater/js@0.20.9
  - @hot-updater/plugin-core@0.20.9

## 0.20.8

### Patch Changes

- Updated dependencies [ad7c999]
  - hot-updater@0.20.8
  - @hot-updater/plugin-core@0.20.8
  - @hot-updater/core@0.20.8
  - @hot-updater/js@0.20.8

## 0.20.7

### Patch Changes

- Updated dependencies [a92992c]
  - hot-updater@0.20.7
  - @hot-updater/plugin-core@0.20.7
  - @hot-updater/core@0.20.7
  - @hot-updater/js@0.20.7

## 0.20.6

### Patch Changes

- Updated dependencies [6a905d8]
  - @hot-updater/plugin-core@0.20.6
  - hot-updater@0.20.6
  - @hot-updater/core@0.20.6
  - @hot-updater/js@0.20.6

## 0.20.5

### Patch Changes

- 3383d38: fix(android): fix proguard syntax
  - hot-updater@0.20.5
  - @hot-updater/core@0.20.5
  - @hot-updater/js@0.20.5
  - @hot-updater/plugin-core@0.20.5

## 0.20.4

### Patch Changes

- Updated dependencies [5314b31]
- Updated dependencies [711392b]
  - hot-updater@0.20.4
  - @hot-updater/plugin-core@0.20.4
  - @hot-updater/core@0.20.4
  - @hot-updater/js@0.20.4

## 0.20.3

### Patch Changes

- e63056a: fix(cli): platform parser from hot-updater.config
- Updated dependencies [e63056a]
  - hot-updater@0.20.3
  - @hot-updater/plugin-core@0.20.3
  - @hot-updater/core@0.20.3
  - @hot-updater/js@0.20.3

## 0.20.2

### Patch Changes

- Updated dependencies [0e78fb0]
  - @hot-updater/plugin-core@0.20.2
  - hot-updater@0.20.2
  - @hot-updater/core@0.20.2
  - @hot-updater/js@0.20.2

## 0.20.1

### Patch Changes

- a3a4a28: feat(cli): set stringResourcePaths and infoPlistPaths in hot-updater.config.ts
- Updated dependencies [a3a4a28]
- Updated dependencies [42ff0e1]
  - hot-updater@0.20.1
  - @hot-updater/plugin-core@0.20.1
  - @hot-updater/core@0.20.1
  - @hot-updater/js@0.20.1

## 0.20.0

### Minor Changes

- a0e538c: feat(android): Support 0.81.0

### Patch Changes

- Updated dependencies [bc8e23d]
  - @hot-updater/plugin-core@0.20.0
  - hot-updater@0.20.0
  - @hot-updater/core@0.20.0
  - @hot-updater/js@0.20.0

## 0.19.10

### Patch Changes

- 4be92bd: link
- 8d2d55a: Injectable minimum bundle id for Android
- Updated dependencies [85b236d]
- Updated dependencies [8d2d55a]
- Updated dependencies [2bc52e8]
  - hot-updater@0.19.10
  - @hot-updater/plugin-core@0.19.10
  - @hot-updater/core@0.19.10
  - @hot-updater/js@0.19.10

## 0.19.9

### Patch Changes

- 7ce0af2: Skip fingerprint generation when using appVersion strategy
  - hot-updater@0.19.9
  - @hot-updater/core@0.19.9
  - @hot-updater/js@0.19.9
  - @hot-updater/plugin-core@0.19.9

## 0.19.8

### Patch Changes

- Updated dependencies [4a6a769]
  - hot-updater@0.19.8
  - @hot-updater/core@0.19.8
  - @hot-updater/js@0.19.8

## 0.19.7

### Patch Changes

- Updated dependencies [e28313d]
- Updated dependencies [bcc641e]
  - hot-updater@0.19.7
  - @hot-updater/core@0.19.7
  - @hot-updater/js@0.19.7

## 0.19.6

### Patch Changes

- 657a10e: Android Native Build - Gradle Build
- Updated dependencies [657a10e]
  - hot-updater@0.19.6
  - @hot-updater/core@0.19.6
  - @hot-updater/js@0.19.6

## 0.19.5

### Patch Changes

- 40d28c2: bump rnef
- d3ac760: fix: delete previous bundle when previous bundle access is needed
- Updated dependencies [40d28c2]
  - @hot-updater/core@0.19.5
  - hot-updater@0.19.5
  - @hot-updater/js@0.19.5

## 0.19.4

### Patch Changes

- hot-updater@0.19.4
- @hot-updater/core@0.19.4
- @hot-updater/js@0.19.4

## 0.19.3

### Patch Changes

- Updated dependencies [0c0ab1d]
  - hot-updater@0.19.3
  - @hot-updater/core@0.19.3
  - @hot-updater/js@0.19.3

## 0.19.2

### Patch Changes

- Updated dependencies [6aa6cd7]
  - hot-updater@0.19.2
  - @hot-updater/core@0.19.2
  - @hot-updater/js@0.19.2

## 0.19.1

### Patch Changes

- Updated dependencies [755b9fe]
  - hot-updater@0.19.1
  - @hot-updater/core@0.19.1
  - @hot-updater/js@0.19.1

## 0.19.0

### Minor Changes

- c408819: feat(expo): channel supports expo cng
- 886809d: fix(babel): make sure the backend can handle channel changes for a bundle and still receive updates correctly

### Patch Changes

- Updated dependencies [c408819]
- Updated dependencies [886809d]
  - hot-updater@0.19.0
  - @hot-updater/core@0.19.0
  - @hot-updater/js@0.19.0

## 0.18.5

### Patch Changes

- @hot-updater/core@0.18.5
- @hot-updater/js@0.18.5

## 0.18.4

### Patch Changes

- @hot-updater/core@0.18.4
- @hot-updater/js@0.18.4

## 0.18.3

### Patch Changes

- 34b96c1: fix(native): extracted bundle.zip directly into folder
  - @hot-updater/core@0.18.3
  - @hot-updater/js@0.18.3

## 0.18.2

### Patch Changes

- d8117b9: Stored bundle path should be separated by channel
- e6487bf: Attempt to move file to the same location
  - @hot-updater/core@0.18.2
  - @hot-updater/js@0.18.2

## 0.18.1

### Patch Changes

- 8bf8f8f: rspress 2.0.0 and llms.txt
  - @hot-updater/core@0.18.1
  - @hot-updater/js@0.18.1

## 0.18.0

### Minor Changes

- 73ec434: fingerprint-based update stratgy

### Patch Changes

- Updated dependencies [73ec434]
  - @hot-updater/core@0.18.0
  - @hot-updater/js@0.18.0
