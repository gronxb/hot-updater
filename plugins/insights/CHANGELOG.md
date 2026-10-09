# @hot-updater/plugin-insights

## 1.0.0-rc.43

### Patch Changes

- @hot-updater/protocol@1.0.0-rc.43

## 1.0.0-rc.42

### Minor Changes

- 72fd2de: The CLI manages Remote Config and reads Insights, as the Console does, on the server `hot-updater api-key` finds: `database` and `plugins` in `hot-updater.config.ts`, the server's admin routes through `standaloneRepository`, or the server file passed last.
  - **`hot-updater remote-config`:** `show` (`--version-number` for a published version), `versions`, `publish <file>`, `rollback <version>`, and `preview`. `publish` takes a template or what `show --json` printed, validates it, lists what it adds, changes, and removes, and asks first (`-y` to skip, `--dry-run` to stop before it). It publishes after the version the file was read at, or `--expected-version`, so a newer publish is never replaced, and the active template publishes nothing. `preview` evaluates the active template, a version, or a `--file` for a device's platform, channel, app version, cohort, fingerprint, and time.
  - **`hot-updater insights`:** `overview`, `failures`, `events`, and `installations`, with the Console's words: a bundle's Downloaded, Launched, and Crashed reports, update failure rates and their stages and reasons, reports by outcome or installation, and installations by install or user ID. `--bundle` takes the ID shown in the Console and reads the bundle's platform and channel; `--window` is `24h`, `7d`, or `30d`.
  - **Plugins:** `createRemoteConfigAdminApi(fetchAdmin)` is Remote Config over a server's admin routes, answering as `RemoteConfigApi` does, and `createInsightsAdminReads(fetchAdmin)` and `createInsightsReads(api)` are the Insights reads over the admin routes or the plugin's API. The Console and the CLI share them.

### Patch Changes

- @hot-updater/protocol@1.0.0-rc.42

## 1.0.0-rc.41

### Minor Changes

- 545f059: `HotUpdater.init` returns the app's HotUpdater instance: every HotUpdater method, including `wrap`, and each client plugin's API under the plugin's id, typed from `plugins`.
  - **Client plugin contract:** `setup(context)` returns `{ hooks, api }`, either of them, or nothing. `api` is what the app calls, as `hotUpdater.<id>`; a plugin id cannot be the name of an instance member, such as `reload` or `wrap`. A `setup` that returns hooks at the top level, as before, is reported through `onError` and gets no hooks. `ClientPluginApi`, `ClientPluginApis`, and `HotUpdaterClientSetup` type it; `HotUpdaterInstance` and `HotUpdaterCore` type the instance.
  - **Insights:** `setUser` moves from the plugin object to `hotUpdater.insights.setUser`. `insights()` keeps its context, device state, and delivery queue per `setup`, so one plugin object set up by two instances reports through each instance's own server. The launch report waits for native launch verification, so a user set right after `init` is on the first report.
  - **Remote Config:** the reads, `fetch`, `activate`, and `subscribe` are on `hotUpdater.remoteConfig`; the plugin object has only `id` and `setup`.
  - **Tests:** `setupClientPlugin` returns the plugin's `api`, and `setupClientPlugins` the plugins' `apis` by id.

### Patch Changes

- Updated dependencies [545f059]
- Updated dependencies [545f059]
  - @hot-updater/protocol@1.0.0-rc.41

## 1.0.0-rc.40

### Patch Changes

- @hot-updater/protocol@1.0.0-rc.40

## 1.0.0-rc.39

### Patch Changes

- 2071bc6: Release health's **Adoption** draws each bundle's downloads as a dashed line beside its launches, solid, in the bundle's color, per interval, and its table shows both counts for the period. After a forced update the two lines nearly meet; otherwise launches follow downloads as apps restart. The **Per interval** and **Cumulative** switch is gone, with its `adoptionTotal` URL value. The Console uses one vocabulary, Downloaded, Launched, and Crashed: event lists name `UPDATE_APPLIED` **Launched** and `RECOVERED` **Crashed**, Release health's crash count is **Crashed**, a download waiting for a restart is **Not launched yet**, and the Release health and bundle tooltips are a sentence or two.

  A download that a launch or crash implied, when its download report never arrived, now counts in the bundle's `UPDATE_DOWNLOADED` outcome counter too, in the hour of that launch or crash. So `countEventSeries` and `countEvents` for a bundle's downloads cover the downloads its release counts, and the reporting overview's `downloadedReports` counts them in whole hours. The launch or crash stays the row, so a download filter's counter can exceed the download rows its hour holds. No table changes: no migration is needed.

- @hot-updater/protocol@1.0.0-rc.39

## 1.0.0-rc.38

### Patch Changes

- bbbdd8c: Insights no longer miscounts two report orders. A launch report made, by its event ID, before the installation's latest report is late even after a later report, such as a user switch or the next day's launch, replaced the apply it preceded: it no longer counts a launch and a download of the bundle the installation left, or moves the installation back to it. A download that repeats the installation's pending one, from the same bundle to the same bundle, counts nothing, so a download reported twice before its launch counts once and the launch implies no second one. Both are kept in history as late reports, as before; the Console notes that the installation had already downloaded or run the bundle. Event IDs are made on the device, so a device whose clock jumps back has its launch reports judged late until its clock passes its latest report.
- @hot-updater/protocol@1.0.0-rc.38

## 1.0.0-rc.37

### Patch Changes

- 5a5dd3e: Keep an `UNCHANGED` report as an event when it changes what its installation runs, and count each release's downloads, launches, and crashes once per installation. The server compares a report with the installation's latest report and keeps it when it is the installation's first report (**First seen**), a new app version or native build (**App updated**), another bundle with no apply report for it (**Launched**), another Release of the bundle it already runs (**Release adopted**), or another channel. A user switch, and a launch that changes nothing, keep no event, so daily launches cost what they did. All Events and installation history show each change once, with what came before.

  A release's launches count its apply reports and the kept reports that moved an installation onto it when no apply report came. A launch or crash whose download report never arrived counts that download too. A download or apply that arrives after its installation already ran the bundle, as a reload can deliver it, counts nothing and moves no latest report. Once every installation restarts, a release's downloads equal its launches plus crashes. The Console's Bundles list shows **Downloaded**, **Launched**, and **Crashed**, and the bundle detail shows downloads not launched yet; a release of the built-in bundle shows no downloads. Release health's **Adoption** counts launches per interval or as a running total, and the crash rate is crashes ÷ (launches + crashes). `InsightsBundleEventFilter` accepts `UNCHANGED`, under a new `on:` key that `UNCHANGED` rows kept by older servers never used, so those count as no launch. No table changes: no migration is needed.

- @hot-updater/protocol@1.0.0-rc.37

## 1.0.0-rc.36

### Patch Changes

- c527bb2: Report installations on the built-in bundle. A client plugin's context has `minBundleId`, the ID of the bundle the native build ships, and the Insights client sends it with each report. Insights counts an installation that runs its build's built-in bundle again in the new `insights_builtin_distribution` gauge, by the release it runs and the bundle's ID, and `getAppUsage` returns `builtinBundleId` with each `bundleDistribution` row. The Console's **Distribution** shows **Built-in app** with the bundle ID under its app version, where it showed **Unknown bundle**, and event and installation details mark the built-in bundle. Reports from SDKs that do not send `minBundleId` count as before.

  The Insights schema version stays 1.0.0 while the 1.0.0 baseline gains the `insights_builtin_distribution` table; existing tables don't change. On SQL databases, create it as the baseline does (Supabase prefixes it with `hot_updater_v1_` and enables row level security); Drizzle and Prisma projects regenerate their schema with `hot-updater db generate` and migrate it. On AWS the DynamoDB policy allows the new partition: rerun `hot-updater init`. Firestore and MongoDB need no change. Installations count in it from their first report after the upgrade.

- Updated dependencies [c527bb2]
  - @hot-updater/protocol@1.0.0-rc.36

## 1.0.0-rc.35

### Patch Changes

- @hot-updater/protocol@1.0.0-rc.35

## 1.0.0-rc.34

### Patch Changes

- 48241d4: Remove crash exit reasons. Android 11 and later reported only why the previous process exited, such as `CRASH` or `ANR`, with no stack trace or message, and iOS reported nothing, so they could not show what crashed. The SDK no longer reads `ApplicationExitInfo` or sends `previousProcessExit`. `AppReadyResult` and `UpdateError` drop the field, Insights keeps no exit-reason rows, `getUpdateFailures` drops `recoveries`, and the Console drops **Crashes by exit reason**. A bundle's crash count in Release health is no longer a link. The server still accepts reports from SDKs that send the field and ignores it. Update failure reads count only the stages a failure records, so exit-reason rows already stored are ignored until they expire.

  The Insights schema version is 1.0.0, as core's is, while the 1.0.0 baseline changes in place: set the `schema.insights` setting to `1.0.0`. The Console's tooltips are shorter.

- Updated dependencies [48241d4]
  - @hot-updater/protocol@1.0.0-rc.30

## 1.0.0-rc.33

### Patch Changes

- 9fe6dfd: Count each release's applies instead of its active days. A release's lifetime counters count its `UPDATE_APPLIED` reports in `applies`, where they counted each installation once for each UTC day it launched the release, and `getReleaseActivity` returns `applies` instead of `launches`. A launch report changes no release or channel counter, and a recovery counts only the crash on the bundle it left, not an apply of the bundle it returned to. The Bundles list and detail show **Applied** instead of **Active days**, and rate known crashes over applied plus known crashes, as Release health does. Hourly and daily counters drop `launches` and `failed_updates`, which no read summed, and a daily launcher costs about 36 DynamoDB write units a day instead of 38.

  The Insights schema moves to 1.4.0 in the 1.0.0 baseline. A server, a Console, and a database on different Insights schemas refuse each other, so migrate the database and upgrade both together. On SQL databases, drop the `launches` and `failed_updates` columns of `insights_overview` and `insights_overview_daily`, and rename `launches` on `insights_overview_lifetime` to `applies`, set to 0 (Supabase prefixes these tables with `hot_updater_v1_`); Drizzle and Prisma projects regenerate their schema with `hot-updater db generate` and migrate it. Then set the `schema.insights` setting to `1.4.0`; DynamoDB, Firestore, and MongoDB need only the setting. Applied counts the apply reports received from then on, since the old counts included days an installation only relaunched.

## 1.0.0-rc.32

### Patch Changes

- Updated dependencies [384a5b6]
  - @hot-updater/protocol@1.0.0-rc.29

## 1.0.0-rc.31

### Patch Changes

- d846556: Rebuild Release health around one question: is a newly deployed bundle taking over, and is it crashing? It follows the two newest bundle deployments of the channel and platform, or a focused release and the one deployed before it, on the card's timeline (hourly for 24h, every six hours for 7d, daily for 30d), with each deployment marked and one color per bundle. Add a bundle from the ten newest deployments, up to four, or remove one; the choice and the tab are kept in the URL. **Adoption** charts the installations that applied each bundle, with its update failures; **Crashes** charts the launches that crashed on each bundle and recovered, with its crash rate, and recommends rolling a bundle back once it crashes for 5% of at least 20 installations that tried it. **Roll back** disables its release, as the bundle details do. A bundle's update failures or crashes open the Failures details on it, and View adoption on a bundle opens Release health on it.

  Remove what the old Release health used: the Bundle share chart and its daily observation heads, the Downloads and Adoption tabs, the metrics row, and the Launch failures tab. Insights drops `getDistributionHistory`, the `bundle_daily_heads` and `insights_distribution_history` tables, the per-report daily head writes, the per-hour release launch sketches, launches on hourly and daily rows (a release keeps its lifetime count), and the unread recent-events index; a repeated launch on the same UTC day writes nothing again, and a daily launcher costs about 38 DynamoDB write units a day instead of 58. `getReleaseActivity` reads lifetime release counts only, without `coverage`. The DynamoDB batching gate holds each event's batched aggregate writes to a budget instead of a ratio to the now cheaper transactional writes. It adds `countEventSeries`, a bundle filter's event counts per interval read from the hourly counts it already keeps. The Insights schema returns to the 1.0.0 baseline, version 1.2.0, without the 1.0.0-rc.30 migrations. Upgrade the Console and the plugin together: a 1.0.0-rc.30 Console cannot read Release health from this plugin. A database already migrated to 1.0.0-rc.30 records Insights 1.3.0, which this server refuses: set its `schema.insights` setting back to `1.2.0`, and on SQL databases drop the `bundle_daily_heads` and `insights_distribution_history` tables.

## 1.0.0-rc.30

### Patch Changes

- 0c884b7: Show daily observed bundle shares in Release health while retaining its scope totals and moving launch failures to a separate chart tab. Count each reporting installation once on its day's last observed running bundle, preserve previous days, and include built-in and unknown bundles in the denominator. Show gaps without observations, the unfinished current day, app-version filtering, and tooltip counts.

  Insights schema 1.3.0 adds daily observation heads and distribution history. Migrate the server and Console together; history begins after upgrade and is not backfilled. The shared model and HTTP conformance suites cover daily replacement and historical preservation, and the versioned infrastructure guide documents each provider's upgrade.

- 541f0ec: Show how quickly a release spreads after deployment in an Adoption tab of Release health. It charts the chosen release's download reports in each interval from the hour it was deployed, read from the Release ID's UUIDv7 timestamp, and their running total: hourly for 24h, six hours for 7d, and one day for 30d. Choose the release in the tab's Chart bundle list of releases observed in the period, newest deployment first, or with Chart newest bundle; or open View adoption from a bundle's Insights card, which picks the shortest period that covers its deployment. The open Release health tab is kept in the URL, the card stays in place while a new bundle or period loads, and an empty chart offers the period that covers the deployment.

  `getReleaseActivity` takes an optional `intervalMs` of whole hours on a release period read and then returns every series point of that span from the period's start; series points also carry `downloads`. It reads the same hourly counters as before, so no schema change, migration, or write is added. The shared model conformance suite covers the hourly series.

## 1.0.0-rc.29

### Patch Changes

- 80bb792: Attach the latest catalog or artifact HTTP response to existing Insights reports without adding requests or changing launch/failure deduplication. Preserve successful, cached, and failed response text with a bounded body and its original observation timestamp. Console exposes the response from event and installation details and alongside error investigation. No database migration is required.
- Updated dependencies [80bb792]
  - @hot-updater/protocol@1.0.0-rc.28

## 1.0.0-rc.28

### Patch Changes

- b412f41: Collect the original update error message and stack trace in Insights and display them in Console event history. Preserve distinct error messages when deduplicating daily failures, and identify older reports with no recorded cause. Error text is bounded to fit the event payload. Console now compares failure rates with the previous period and groups loaded error reports by their original message, with occurrence-specific stacks, app and SDK versions, installation history, and copyable reports. Raw history loads in bounded, resumable batches with explicit coverage. Existing database schemas remain compatible.

## 1.0.0-rc.27

### Patch Changes

- Improve the readability of Console update failures by grouping check metrics separately, emphasizing nonzero failures, and making stage/reason details easier to scan. Preserve all report data and rate calculations. Prepare all public Hot Updater packages together as 1.0.0-rc.27.
- Updated dependencies
  - @hot-updater/protocol@1.0.0-rc.27

## 1.0.0-rc.26

### Patch Changes

- c9cfed7: Restore the rc.14 Insights metric layout in bundle rows and details while preserving current data, rates, links, and download failure reporting. Release all public Hot Updater packages together as 1.0.0-rc.26.
- Updated dependencies [c9cfed7]
  - @hot-updater/protocol@1.0.0-rc.26

## 1.0.0-rc.25

### Patch Changes

- c9cfed7: Release the legacy Hermes fallback correction at 1.0.0-rc.25 with all public Hot Updater packages on the same RC.
- Updated dependencies [c9cfed7]
  - @hot-updater/protocol@1.0.0-rc.25

## 1.0.0-rc.24

### Patch Changes

- c9cfed7: Release the project-scoped Expo, fingerprint, React Native, and Hermes resolution fixes at 1.0.0-rc.24 so projects can install the same RC of every Hot Updater package.
- Updated dependencies [c9cfed7]
  - @hot-updater/protocol@1.0.0-rc.24

## 1.0.0-rc.23

### Patch Changes

- c9cfed7: Release with the Expo SDK 58 config fix at 1.0.0-rc.23 so projects can install the same RC of every Hot Updater package.
- Updated dependencies [c9cfed7]
  - @hot-updater/protocol@1.0.0-rc.23

## 1.0.0-rc.22

### Patch Changes

- c9cfed7: Released with every Hot Updater package at 1.0.0-rc.22, so a project can install the same RC of each one.
- Updated dependencies [c9cfed7]
  - @hot-updater/protocol@1.0.0-rc.22

## 1.0.0-rc.21

### Minor Changes

- f185d6d: Insights and API keys ship as their own packages: `@hot-updater/plugin-insights`, with `./server` and `./client`, and `@hot-updater/plugin-api-keys`, with `./server`. `@hot-updater/server` and `@hot-updater/react-native` depend on them: the server re-exports them from `@hot-updater/server/plugins/insights` and `@hot-updater/server/plugins/api-keys`, and the app SDK exports the Insights client from its root, so servers and apps install nothing more.
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

### Patch Changes

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

- Updated dependencies [c9cfed7]
- Updated dependencies [5ec6796]
- Updated dependencies [f185d6d]
- Updated dependencies [4d15862]
  - @hot-updater/protocol@1.0.0-rc.21
