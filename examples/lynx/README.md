# Lynx example and acceptance matrix

This example starts from the official Sparkling application structure and uses
the packaged `@hot-updater/lynx` host integration. ReactLynx, VueLynx, and
OctaneLynx are equal Lynx-engine targets on iOS and Android.

The repository keeps two native targets per platform:

| Purpose | iOS | Android |
| --- | --- | --- |
| Production scaffold | `SparklingGo` | `:app` (`com.hotupdater.lynxexample`) |
| Nonproduction matrix harness | `SparklingMatrixHarness` | `:matrix-app` (`com.hotupdater.lynxmatrix`) |

The production scaffold contains native identity and embedded-release
configuration, module registration, and one packaged host/view attachment. Its
application sources do not implement OTA selection, download, verification,
recovery, resource loading, crash policy, or restart behavior. Those behaviors
live in the optional Sparkling integration shipped by `@hot-updater/lynx`.

The matrix targets are separate QA applications. They expose multi-container,
primary-removal, secondary-failure, stale-context, and diagnostic controls while
still delegating every lifecycle operation to the packaged host API. Matrix-only
controls do not ship in the production target.

## Build framework output

The public compiler wrapper emits a main template, image, font, external
background JavaScript, and native dynamic component under one release-owned
tree. It is shared by ordinary builds and the Hot Updater build callback.

```sh
HOT_UPDATER_SDK_BASE_URL=https://updates.example.com/hot-updater \
  pnpm --filter @hot-updater/example-lynx build:public react A

HOT_UPDATER_SDK_BASE_URL=https://updates.example.com/hot-updater \
  pnpm --filter @hot-updater/example-lynx build:public vue A

HOT_UPDATER_SDK_BASE_URL=https://updates.example.com/hot-updater \
  pnpm --filter @hot-updater/example-lynx build:public \
  octane A /absolute/path/to/pinned/octane
```

The Octane path must point to the pinned source checkout at commit
`c31f629185f7d768c821557f6fb49dc46daf671c`. The build script rejects a wrong
commit or tracked source changes. It invokes the real Octane compiler without
patching the upstream renderer.

The application compiler owns framework details. The shared
`@hot-updater/lynx/build` adapter receives only the selected output tree, entry,
platform, and native runtime identity. It preserves portable relative names and
bytes, creates `hot-updater-lynx.json`, and declares the entry as the manifest's
delta patch asset.

Managed application files use `hot-updater:///` URLs. The packaged host resolves
the entry, image, font, external JavaScript, and dynamic component against one
verified installation. A missing managed dependency fails that release instead
of reading another installed or embedded release.

The tested VueLynx and OctaneLynx framework-generated `import()` output calls
`lynx.loadLazyBundle`, which those runtimes do not currently expose. The example
therefore uses an independently compiled background module through the Lynx core
API and a native dynamic component. This is a documented upstream output
limitation; it does not reduce VueLynx or OctaneLynx's OTA support scope.

## Build the native targets

Install workspace and iOS dependencies first:

```sh
pnpm install
pnpm --filter @hot-updater/example-lynx test:type
```

Build the production Sparkling scaffold on both platforms:

```sh
pnpm validate:lynx:scaffold-native
```

Native builds consume already validated embedded A trees under the platform
fixture directories. The acceptance workflow creates those trees with the public
compiler and `scripts/ota-embedded.mjs` before invoking the native build; they
are generated evidence and are not committed application source.

Build one matrix binary per OS. Each binary is reused for ReactLynx, VueLynx,
and OctaneLynx cells:

```sh
pnpm build:lynx:matrix-native
```

The build writes native artifact receipts below
`.hot-updater/public-matrix/`. See the [iOS](./ios/README.md) and
[Android](./android/README.md) guides for the production integration boundary.
Both production and matrix iOS schemes and Android applications currently build;
that is native build verification rather than device acceptance.

## Run the public six-cell matrix

Inspect the exact six cells and required phases without using devices:

```sh
pnpm e2e:lynx:matrix -- --dry-run
```

A real run requires the built matrix artifacts, an iOS simulator, an Android
emulator, the pinned Octane checkout, and an explicit results directory:

```sh
pnpm e2e:lynx:matrix -- \
  --native-artifacts examples/lynx/.hot-updater/public-matrix/matrix-native-artifacts.json \
  --ios-device IOS_SIMULATOR_UDID \
  --android-serial ANDROID_SERIAL \
  --octane-source /absolute/path/to/pinned/octane \
  --results-dir /absolute/path/to/lynx-matrix-results
```

The runner installs each native binary once per platform and validates all three
frameworks. Every cell must prove embedded A, archive A-to-B, B activation and
retention with the delivery origin unavailable, a real B-to-C BSDIFF, same-process
managed-generation reload, stale-context rejection, primary replacement,
secondary fatal recovery, and unconfirmed-candidate recovery. It accepts only
correlated native events and writes one receipt per cell plus a summary.

The real six-cell device run for the current implementation is still pending.
A dry run, compiler output, native build, historical probe, or synthetic receipt
does not close this acceptance gate.

## Run the shared Lynx E2E suite

The Lynx suite uses every shared default OTA scenario except
`metadata-v1-migration`. That scenario migrates React Native's legacy metadata
store and does not apply to Lynx. Delta, channel, fingerprint, stale-catalog,
recovery, and crash-history scenarios remain enabled.

```sh
hot-updater-agent verify \
  -platform full \
  -profile standalone-kysely \
  -env-target examples/lynx/.env.hotupdater
```

The full `hot-updater-agent` run for the current implementation is still
pending. Its ReactLynx host path is an additional gate and does not replace the
VueLynx and OctaneLynx matrix cells.

## Delivery and activation behavior

`checkForUpdate()` performs catalog authorization and nonretained native
compatibility validation. `update.updateBundle()` performs the actual download,
delta/archive verification, and atomic staging. A selected update becomes active
on the next launch or after `HotUpdater.reload()`.

Reload keeps the OS process foregrounded and reconstructs every library-managed
runtime and view. The old generation stops accepting work, drains its resource
leases, and loses native authority before a fresh primary and its secondaries
evaluate one release. Startup is confirmed only after actual first content, all
declared startup resources, and application readiness. Native returns the launch
transition once; repeated readiness cannot replay it.

An explicit `channel` on `checkForUpdate()` authorizes and persists the channel
switch atomically with catalog acceptance. A second cross-channel switch is
rejected until `HotUpdater.resetChannel()` returns the host to its configured
default scope.

See the [PRD](../../plans/lynx-support/prd.md),
[execution ledger](../../plans/lynx-support/execution.md), and
[current evidence reconciliation](../../plans/lynx-support/evidence/reconciliation-2026-09-13.md)
for the acceptance status. Historical G1 probe artifacts remain evidence of
earlier feasibility work, but they are not commands for the production scaffold.

See [third-party notices](./THIRD_PARTY_NOTICES.md) for Sparkling and fixture
licenses.
