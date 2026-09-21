# Lynx final acceptance reconciliation

Date: 2026-09-21 (Asia/Seoul).

PR: [#1300](https://github.com/gronxb/hot-updater/pull/1300). Implementation
commit under device verification:
`bfad8131abd8d3cef92fe1f08e3d41e3a6869f6a`.

## Scope decisions

The supported product boundary is the Lynx engine. ReactLynx, VueLynx, and
OctaneLynx use the same `@hot-updater/lynx` runtime, opaque artifact contract,
and native host. Delta delivery is required. React Native's legacy v1 metadata
migration is excluded from Lynx. All prerelease database changes remain in the
single 1.0.0 migration.

The basic Sparkling example is page based. Main and detail are separate compiler
outputs, a user action navigates with `sparkling-navigation`, and the native host
loads both from one verified Hot Updater selection. Immediate activation on both
OSes recreates every managed runtime and restores the bounded logical page stack
without terminating the process.
ReactLynx, VueLynx, and OctaneLynx each declare `main` and `detail` compiler
entries, emit `main.lynx.bundle` and `detail.lynx.bundle`, and wire the visible
“Open detail page” action to `navigate({ path: "detail.lynx.bundle" })`. Each
detail entry calls `HotUpdater.notifyAppReady()` and exposes managed close
navigation. The matrix contract binds the two page files and their per-page
resources to the same verified Release.

Production app-owned native code performs ordinary Sparkling initialization,
constructs the packaged Hot Updater host configuration, registers the supplied
modules, and mounts the supplied view. OTA installation, recovery, resource
resolution, page routing, authority, and generation replacement remain inside
`@hot-updater/lynx`. Diagnostic controls are confined to separate E2E and matrix
targets.

Common delivery code consumes explicit artifact, compression, patch-entry,
fingerprint, and signing declarations. React Native and Hermes artifact and
fingerprint policy lives in `@hot-updater/react-native`; bare and Rock delegate
to it. Expo fingerprint discovery lives in `@hot-updater/expo`. The common CLI
no longer depends on `@expo/fingerprint` and does not infer an engine from
artifact filenames.

## Current verification

The following checks pass on the current implementation:

- `pnpm --filter @hot-updater/lynx test:type`;
- `pnpm --dir examples/lynx test:type`;
- Android Sparkling `testDebugUnitTest`;
- `pnpm -w lint`;
- `pnpm exec vitest run e2e/lynx --project=unit:e2e`: 22 files and 429 tests;
- focused crash recovery projection: 2 files and 17 tests;
- `pnpm e2e:lynx:matrix -- --dry-run`, which enumerated all six cells and all
  16 required phases per cell; and
- `pnpm build:lynx:matrix-native`, which passed source-integrity verification
  for `bfad8131abd8d3cef92fe1f08e3d41e3a6869f6a` and produced the unchanged
  matrix binaries recorded below; and
- GitHub Integration for parent implementation commit
  `a1ea8133197d437904df21cab2a03721e4de9cb3` in 14 minutes 20 seconds. The
  current matrix-fixture correction is awaiting its GitHub run.

The E2E unit suite includes the explicit Lynx manifest, page-stack back
synchronization, real delta evidence, crash history projection, runtime journal,
managed resources, and public matrix contracts. These checks do not replace the
device gates below.

## Full shared E2E

Job `job-20260921042318-sbf4lo` was submitted with `platform=full`, profile
`standalone-kysely`, environment target `examples/lynx/.env.hotupdater`, and PR
#1300. The expected application ID is `com.hotupdater.lynxexample`. Each OS must
run the 25 applicable shared scenarios, excluding only
`metadata-v1-migration`, plus `sparkling-multipage-ota`, for 26 scenarios per OS.

Status: queued. A queued job is not acceptance.

## Framework matrix

Historical SDK3 receipts remain useful feasibility evidence for all six
framework and OS combinations. They do not replace a current matrix run. The
current matrix must reuse one unchanged native binary per OS across ReactLynx,
VueLynx, and OctaneLynx, and produce six strict receipts.

Status: pending current device execution.

The native artifact receipt is
`examples/lynx/.hot-updater/public-matrix/matrix-native-artifacts.json`. It
records source commit `bfad8131abd8d3cef92fe1f08e3d41e3a6869f6a`, a clean
tracked tree after allowing only the six preserved staged E2E helpers, iOS app
tree SHA-256
`61577fc53475992da6c15c18e7f0575682ad6b6c89bdcf1f8f1b24ae7be1c9cf`, and
Android APK SHA-256
`0712bdc13d8269d721b6ebfd412fcb0884945465302747fe7b4418aeb082abb1`.

VueLynx and OctaneLynx framework-generated `loadLazyBundle` templates remain an
upstream runtime limitation. Core external JavaScript, native dynamic components,
page bundles, managed resources, and OTA flows remain in the engine-level scope.
