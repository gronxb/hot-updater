# Release Catalog v1 compatibility inventory

This inventory records compatibility code that v1 deliberately keeps. The
boundary is on-device state that survives an App Store or Play Store upgrade,
not server infrastructure. v0 databases, remote storage, endpoints, selection
protocols, and management write shapes remain on their unchanged v0 deployment.

## Required compatibility layers

| Boundary                       | Implementation                                                      | Why it remains                                                                                                                                                                                                      | Removal gate                                                                                             |
| ------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Persisted native metadata      | Android and iOS `BundleMetadata` plus `BundleFileStorageService`    | Existing installs can have `stableBundleId`/`stagingBundleId` without Release receipts. v1 materializes a legacy `PersistedSelection`, preserves crash recovery, and can later adopt a Release for the same Bundle. | No supported store-upgrade path can originate from Bundle-ID-only metadata.                              |
| Legacy bundle identity files   | Android/iOS `HotUpdaterImpl` and `BundleFileStorageService`         | A Bundle installed by v0 can have a `BUNDLE_ID` file or root bundle file but no v1 manifest. The v1 native build must still launch, identify, and clean up that local artifact.                                     | The on-device v0 artifact retention window has ended and telemetry shows no legacy layout use.           |
| Stable cohort identity         | Android/iOS `CohortService`                                         | An App Store or Play Store upgrade preserves application storage. Keeping the same key prevents existing users from being reshuffled into a different rollout bucket.                                               | Never remove without an explicit cohort identity migration.                                              |
| Native bridge result shapes    | `packages/react-native/src/native.ts`                               | The supported old-architecture bridge serializes results as JSON, while locally retained v0 artifacts can expose legacy identity and manifest shapes after the native upgrade.                                      | Neither the supported bridge nor any store-upgrade path can expose those shapes.                         |
| Release-less transition events | React Native app-ready reporting and nullable Insights Release IDs | The first v1 launch can transition from BUILTIN or a locally retained v0 Bundle, neither of which has a v1 Release ID. Bundle IDs still describe the transition direction.                                          | Every supported transition source has a v1 Release receipt or an explicit non-Release identity contract. |

## Boundaries intentionally not preserved

- `s3Database` is not retained. Object storage cannot implement the v2 database
  models, compare-and-swap revisions, and atomic catalog commit contract. Use
  `s3Storage` beside a real database provider.
- v0 writers are not allowed against schema 1.0.0. A sequential fallback would
  expose a Release without its catalog or a catalog without its Bundle.
- v1 creates schema `1.0.0` only on empty storage. It does not upgrade or read a
  populated v0 database, and it does not backfill v0 Bundle policy.
- v0 app-version and fingerprint routes are not mounted by v1. Existing native
  binaries must keep using their unchanged v0 endpoint.
- `LegacyBundle`, Bundle-policy management writes, and the server-side v0
  selector are removed. Bundle rows contain immutable artifact data; Release
  rows contain delivery policy.
- The scalar Bundle patch fields and mutable per-bundle remote asset layout are
  removed. v1 uses `Bundle.patches` and content-addressed remote assets.
- Custom resolver callbacks are removed. React Native accepts only `baseURL`;
  GraphQL, RPC, and other backends must expose the v1 HTTP protocol through an
  adapter or proxy.
- v1 Release Catalog JS does not run on a v0 native binary. Missing receipt,
  high-water, selection-guard, and Release Catalog cache methods fail with a
  rebuild instruction.
- Stale iOS CocoaPods source lists are not supported. Refresh the native project
  with Expo Prebuild or `pod install` before building v1.
- The removed `/api/bundles/channels` route is not aliased; the canonical admin
  Channel-row path is `/channels` relative to the admin handler mount.
- Managed AWS, Cloudflare, Firebase, and Supabase init does not migrate selected
  v0 resources. Detection fails before mutation and requires newly scaffolded
  v1 resources.
- Authentication, network, or server errors do not fall back to a cached
  catalog. Only a validated `304 Not Modified` may reuse the matching cache.
- `HotUpdater.wrap({ updateMode })`, findMany `sortBy`, Supabase
  `supabaseAnonKey`, config `releaseChannel`, Wrangler `r2Storage`, and
  Android `stringResourcePaths` are not accepted inputs. Managed init still
  detects leftover `supabaseAnonKey` so skipped v0 configs fail closed. The
  build-time channel is `hot-updater channel set` into AndroidManifest.xml /
  Info.plist.

## Governance

Every retained compatibility layer needs a test that starts from the old local
shape or state. Cross-process and persisted-state boundaries require a scenario
or contract test; pure data normalization may use a focused unit test with the
complete old shape. Server-side v0 compatibility must not be reintroduced into
the fresh v1 generation.
