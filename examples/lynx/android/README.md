# Android Sparkling host

The `:app` module is the production Sparkling scaffold for
`com.hotupdater.lynxexample`. It is derived from Sparkling's Apache-2.0 template
at commit `c4ce8d25c5ea277e13752d68ff1f2a66f5704240` and pins Lynx 3.9.0 and
PrimJS 3.8.0-alpha.6.

Its application-owned native code has two responsibilities:

- `LynxApplication` registers the packaged Hot Updater and managed-navigation
  services, then initializes Sparkling.
- `OtaActivity` supplies the native runtime identity, embedded release
  descriptor, channel, app version, cohort, signing key, and fingerprint, then
  mounts `HotUpdaterSparklingHost`.

The packaged `hot-updater-lynx` and `hot-updater-lynx-sparkling` modules own
catalog state, archive and delta installation, integrity and compatibility
checks, release-scoped resources, startup confirmation, recovery, and
same-process managed-generation recreation. The app does not contain a staging
provider, custom resource loader, crash journal, controller probe, process-exit
restart, or restart activity.

Managed navigation uses the unmodified Android source shipped by the exact npm
package `sparkling-navigation@2.1.0-rc.12`. Gradle verifies the following
provenance before compiling it:

- npm package Git tag commit:
  `bb066d6b45189fa123b8494d789429605ca1337e`
- `android/src/main` SHA-256:
  `937f70d7c3012a5a498a3984f94d269c01d7ba4fd5eed5cbc87410ba6fa94463`
- `src/navigate/navigate.ts` SHA-256:
  `a5e2dd1926904acddffde4e6d5c673a4ed49a5bf1b9d3050f6b77b2ffc6a3305`
- Sparkling core AAR SHA-256:
  `3f565f3a1e44ccc3c33d8a53e7ebd1af5e348e1aac3f4a8de83676e0080d64ea`
- Sparkling core POM / Gradle module SHA-256:
  `852ddb134a4f8534b648416594d8d4babb30ac43584e3423d4d1f8d3baf90880` /
  `7fd65ca2ef77deaa67102e3cfbf67a376ba95c35c5cdbc225e3ffd9cfa08b8c5`
- Sparkling Method AAR SHA-256:
  `2b5114e07640ff86ee43fc5ae0cd84cf98a53d2c40a19d432bf501496cc54b7a`
- Sparkling Method POM / Gradle module SHA-256:
  `5d42601a13e3ffcf92fc973248e50b342ad78aa72fc297c051707fca8f207a06` /
  `01fd39296eddb16f3ab50ed5efd0880737d29d98900d1d7564e9e18637599e17`
- excluded production transitive resolution graph SHA-256:
  `c68329c1968de962c8574f298ba46f43db016195bbbf4422b5e01145278aebe3`

The Android source digest reads files below `android/src/main` in sorted
source-root-relative UTF-8 path order and feeds each relative path, a NUL byte,
and the raw file bytes to SHA-256. The matching runtime identity is
`android-sparkling-2.1.0-rc.12-navsrc-937f70d7c3012a5a-lynx-3.9.0-primjs-3.8.0-alpha.6-managed-pages-v1`.
The graph digest hashes the sorted resolved `owner -> requested => selected`
edges, including a trailing newline, after applying the production devtool
exclusions.

Each pushed logical page is hosted by the packaged full-page
`HotUpdaterSparklingPageActivity`. Native owns the Activity back stack, binds
each page to its source context and generation, and rebuilds the ordered page
entries and string parameters together when a managed reload or recovery starts
a new generation.

The production `:app` consumes only
`.hot-updater/production-embedded/ota/react/A`; E2E compilation never writes
that directory. The production validation command materializes the ordinary
React SDK3 A artifact there, assembles `:app`, scans the APK for diagnostics,
and writes `scaffold-native-artifacts.json`:

```sh
pnpm validate:lynx:scaffold-native -- --platform android
```

The production APK is written to
`app/build/outputs/apk/release/app-release.apk` and embeds only the compatible
ordinary React artifact. OTA files are never copied into the app by an
application-owned provider.

## Shipped E2E application

The nonproduction `:e2e-app` has the same application ID, contains the shipped
E2E main/detail bundles and diagnostics module, and writes
`e2e-native-artifacts.json`:

```sh
pnpm build:lynx:e2e-native -- --platform android
```

The E2E APK is written to
`e2e-app/build/outputs/apk/release/e2e-app-release.apk`. It deterministically
generates, validates, and embeds the E2E React SDK3 A tree at
`.hot-updater/embedded/ota/react/A`.

## Nonproduction matrix target

`:matrix-app` is a separate QA application with package ID
`com.hotupdater.lynxmatrix`. It mounts the same packaged full-page host and emits
matrix event diagnostics. Framework and embedded-directory selection remain
build inputs for the six-cell acceptance contract. It does not implement a
custom router, resource loader, or restart mechanism, and its diagnostics are
not compiled into `:app`.

```sh
pnpm build:lynx:matrix-native -- --platform android
```

The matrix APK is written to
`matrix-app/build/outputs/apk/release/matrix-app-release.apk`. Use it through the
root `pnpm e2e:lynx:matrix` runner so deployment, origin-off launches, BSDIFF,
generation identity, resource leases, and recovery are correlated in one
receipt. A successful APK build alone is not device acceptance.

The matrix build consumes the prevalidated React, Vue, and Octane SDK3 A trees
produced by the public acceptance workflow. They are generated compiler output
and are not application-owned OTA logic.

The production and matrix Android targets currently assemble successfully in
debug and release configurations. The real six-cell device matrix and the
current full `hot-updater-agent` run remain pending.
