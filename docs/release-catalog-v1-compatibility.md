# Release Catalog v1 compatibility inventory

This inventory records compatibility code that v1 deliberately keeps. The
rule is narrow: preserve installed clients, persisted artifacts, and supported
migration inputs, but do not preserve v0 write semantics when doing so would
break atomic Release and catalog commits.

## Required compatibility layers

| Boundary | Implementation | Why it remains | Removal gate |
| --- | --- | --- | --- |
| v0 mobile selector URLs | `packages/server/src/handler.ts`, `handlerUpdateRoutes.ts`, `db/releaseCatalog.ts`, and `plugins/js` | Installed v0 apps still call the app-version or fingerprint routes. The bridge selects from the compiled catalog and serializes the legacy update/rollback shape. Missing or pre-0.31 SDK headers still receive JSON `null` for no update. | The published v0 mobile support window has ended and field usage of both selector families is negligible. |
| Legacy Bundle management shape | `packages/core/src/types.ts`, `packages/server/src/handlerBundleRoutes.ts`, `db/databasePluginCore.ts`, and Standalone `standaloneLegacy{Implementation,Reads,Writes}.ts` | Existing Console and Standalone bundle routes use Bundle-shaped requests. The adapter translates each accepted write into an atomic Bundle, Release, and catalog mutation and rejects scope moves it cannot represent. | All first-party management clients use Release-native routes and no supported external integration uses Bundle mutation routes. |
| Legacy patch artifact scalars | `packages/core/src/types.ts` and `bundleArtifacts.ts` | Persisted v0 Bundles can contain `patchBaseBundleId`, `patchBaseFileHash`, `patchFileHash`, and `patchStorageUri` instead of `Bundle.patches`. Console display and artifact deletion still need to resolve that shape. New data prefers the first `patches` entry. | No retained Bundle or supported API response contains the scalar-only patch shape. |
| Custom resolver `checkUpdate` | `packages/react-native/src/types.ts` and `checkForUpdate.ts` | v0 applications with custom update servers can upgrade the SDK without immediately implementing protocol v2. It intentionally stays in legacy selection mode and does not claim Release Catalog guarantees. | A major-version removal after the custom resolver migration path has had a documented support window. |
| Persisted native metadata | Android and iOS `BundleMetadata` plus `BundleFileStorageService` | Existing installs have `stableBundleId`/`stagingBundleId` without Release receipts. v1 materializes a legacy `PersistedSelection`, preserves crash recovery, and later adopts a Release for the same Bundle. | No supported upgrade path can originate from metadata-v1 or Bundle-ID-only state. |
| Legacy bundle identity files | Android/iOS `HotUpdaterImpl` and `BundleFileStorageService` | Bundles installed by v0 may have a `BUNDLE_ID` file or root bundle file but no v1 manifest. v1 must still launch, identify, and clean up those artifacts. | The v0 artifact retention window has ended and migration telemetry shows no legacy layout use. |
| Stable cohort identity | Android/iOS `CohortService` | Existing users must keep the same cohort bucket across the upgrade; regenerating it would reshuffle rollouts. | Never remove without an explicit cohort identity migration. |
| Pre-cache v1 native binaries | `packages/react-native/src/catalogCacheNative.ts` | Release Catalog JS remains functional when the native cache methods are absent or fail; it performs an unconditional network fetch and disables conditional caching. | Every supported v1 native baseline includes the cache API. |
| Legacy native/JS result shapes | `packages/react-native/src/native.ts` | JS normalizes `PROMOTED`, NIL UUID bundle IDs, old-architecture JSON payloads, and legacy manifest asset objects returned by older native modules. | The matching native baselines leave the support matrix. |
| Stale iOS CocoaPods source lists | iOS `HotUpdaterCrashHandler.{h,mm}` and `Package.swift` exclusions | Existing projects can still compile the removed crash-handler filenames until `pod install` refreshes their source list; the files are empty shims and recovery stays in `HotUpdater.mm`. | Supported upgrade instructions and package managers no longer permit a stale source list from a v0 installation. |
| Legacy per-bundle asset layout | `plugins/plugin-core/src/assetStorageLayout.ts`, `legacyAssetStorageLayout.ts`, and `packages/console/src/lib/server/legacyBundleAssetCleanup.ts` | v0 manifests can reference mutable per-bundle files instead of content-addressed assets. Reads and deletion must continue to address the original objects. | All retained bundles have been deleted or migrated to content-addressed storage. |
| Analytics rows without Release IDs | `plugins/plugin-core/src/databasePluginCrudValidationRows.ts`, provider row parsers, and `packages/server/src/analytics/bounded/persistence.ts` | Events emitted before Releases existed have no `from_release_id` or `to_release_id`. Providers accept omitted legacy fields and normalize new events to nullable values so historical analytics remain readable. | All retained analytics events were written by Release-aware clients and every supported provider has completed the nullable-column migration. |
| Versioned database migration | `packages/server/src/schema/v0_*` and `db/fixedMigrator*` | Self-hosted SQL and MongoDB installations need deterministic, fail-closed upgrades from the supported v0 schema markers to 1.0.0. | Those source schema versions are outside the documented upgrade window. Keep migrations immutable while supported. |
| Managed provider backfills | AWS DynamoDB, Cloudflare D1, Firebase, and Supabase migration code | Managed schemas have provider-owned history and must preflight legacy Bundle policy, backfill deterministic Releases/catalogs, and resume safely without a partial cutover. | Provider-specific v0 upgrade support ends; applied migration files and markers still remain immutable historical state. |
| Deprecated configuration/API inputs | Android `stringResourcePaths`, `releaseChannel`, `getMinBundleId`/`MIN_BUNDLE_ID`, the old `updateBundle(id, url)` overload, manual `HotUpdater.wrap({ updateMode: "manual" })`, database `sortBy`, Supabase `supabaseAnonKey`, and Cloudflare Wrangler R2 config | These let v0 projects compile while users move to the v1 configuration. They are shims, not architecture dependencies. | Remove only on a documented major boundary after replacements and warnings have shipped for the support window. |

## Boundaries intentionally not preserved

- `s3Database` is not retained. Object storage cannot implement the v2 database
  models, compare-and-swap revisions, and atomic catalog commit contract. Use
  `s3Storage` beside a real database provider.
- v0 writers are not allowed against schema 1.0.0. A sequential fallback would
  expose a Release without its catalog or a catalog without its Bundle.
- v1 Release Catalog JS does not run on a v0 native binary. Missing receipt,
  high-water, and selection-guard methods fail with a rebuild instruction.
- The removed `/api/bundles/channels` route is not aliased; the canonical
  Channel-row API is `/api/channels`.
- Managed migrations do not silently invent policy for malformed or oversized
  legacy scopes. Preflight fails before destructive policy removal.
- Authentication, network, or server errors do not fall back to a cached
  catalog. Only a validated `304 Not Modified` may reuse the matching cache.

## Cleanup candidate found during the audit

`plugins/standalone/src/standaloneLegacyTransaction.ts` exports
`runLegacyAggregateTransaction`, but no production or test module imports it.
It is not part of the required compatibility path: current Standalone v1 writes
use `/api/database/commit`, while Bundle reads use
`createLegacyCompatibilityImplementation`. Remove the orphan in a separate,
focused cleanup after confirming it is not an undocumented deep import; do not
confuse it with the still-required Bundle management bridge.

## Governance

Every compatibility layer needs a test that starts from the old shape or state.
Cross-process and persisted-state boundaries require a scenario or contract
test; pure data normalization may use a focused unit test with the complete old
shape. Removal requires an explicit support-window decision and evidence for
the relevant field state, artifact layout, schema marker, or API consumer. Age
alone is not a removal condition.
