# iOS Sparkling host

The `SparklingGo` scheme is the production Sparkling scaffold for
`com.hotupdater.lynxexample`. It is derived from Sparkling's Apache-2.0 template
at commit `c4ce8d25c5ea277e13752d68ff1f2a66f5704240` and uses the locked Lynx
3.9.0 and PrimJS 3.8.0-alpha.6 dependencies.

Run `mise exec -- sh bootstrap.sh` from this directory to fetch the pinned
Sparkling source, install `cocoapods-lynx-library`, and resolve the CocoaPods
workspace. The local Sparkling source dependency is intentional because the
template's router pod is not published by the CDN.

The production application's native code only starts Sparkling, supplies native
identity and embedded-release configuration, and mounts the packaged
`HotUpdaterSparklingHost`. The `HotUpdaterLynxArtifact` and
`HotUpdaterLynxSparkling` pods own catalog state, archive and delta installation,
integrity and compatibility checks, release-scoped resource loaders, startup
confirmation, recovery, and same-process reconstruction of all managed views.
The `SparklingGo` target contains no manual artifact placement, custom OTA
controller, crash journal, resource fallback, timer-based readiness, or process
restart workaround.

Build the production simulator application:

```sh
pnpm validate:lynx:scaffold-native -- --platform ios
```

The scaffold validation command deterministically generates, validates, and
embeds the ordinary React SDK3 A tree under `ProductionEmbedded/Public`, builds
`SparklingGo`, scans it for diagnostics code, and writes
`scaffold-native-artifacts.json`.

The result is under
`ios/build/Build/Products/Release-iphonesimulator/SparklingGo.app`.
It embeds the production scaffold's compatible ReactLynx A artifact.

## Shipped E2E application

`SparklingGoE2E` contains the shipped E2E main/detail bundles and diagnostics
module:

```sh
pnpm build:lynx:e2e-native -- --platform ios
```

The application is written to
`ios/build/e2e/Build/Products/Release-iphonesimulator/SparklingGoE2E.app` and
the command writes `e2e-native-artifacts.json`. Its generated React SDK3 A tree
lives under `Embedded/Public`.

## Nonproduction matrix target

`SparklingMatrixHarness` is a separate QA scheme with bundle ID
`com.hotupdater.lynxmatrix`. It creates primary and secondary views through the
packaged host and exposes matrix-only controls for primary removal, stale native
authority, and secondary fatal recovery. Its structured diagnostics are not
members of the `SparklingGo` production target.

```sh
pnpm build:lynx:matrix-native -- --platform ios
```

The matrix application is written below
`ios/build/matrix/Build/Products/Release-iphonesimulator/`. Run it through the
root `pnpm e2e:lynx:matrix` command so the unchanged binary hash, process and
generation identities, release resources, origin-off restart, BSDIFF, readiness,
and recovery evidence are validated together. A successful Xcode build alone is
not device acceptance.

The matrix build consumes the prevalidated React, Vue, and Octane SDK3 A trees
produced by the public acceptance workflow. They are generated compiler output
and are not application-owned OTA logic.

The production and matrix iOS simulator schemes currently build successfully.
The real six-cell device matrix and the current full `hot-updater-agent` run
remain pending.

See [third-party notices](../THIRD_PARTY_NOTICES.md) for the Sparkling source
license.
