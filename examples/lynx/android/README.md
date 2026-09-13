# Android Sparkling host

The `:app` module is the production Sparkling scaffold for
`com.hotupdater.lynxexample`. It is derived from Sparkling's Apache-2.0 template
at commit `c4ce8d25c5ea277e13752d68ff1f2a66f5704240` and pins Lynx 3.9.0 and
PrimJS 3.8.0-alpha.6.

Its application-owned native code has two responsibilities:

- `LynxApplication` initializes Sparkling and registers the packaged
  `HotUpdaterLynx` module.
- `OtaActivity` supplies the native runtime identity, embedded release
  descriptor, channel, app version, cohort, signing key, fingerprint, and
  required startup resources, then mounts `HotUpdaterSparklingHost`.

The packaged `hot-updater-lynx` and `hot-updater-lynx-sparkling` modules own
catalog state, archive and delta installation, integrity and compatibility
checks, release-scoped resources, startup confirmation, recovery, and
same-process managed-generation recreation. The app does not contain a staging
provider, custom resource loader, crash journal, controller probe, process-exit
restart, or restart activity.

Build the production release APK with JDK 17 and Android SDK 34:

```sh
pnpm validate:lynx:scaffold-native -- --platform android
```

The scaffold validation command deterministically generates, validates, and
embeds the React SDK3 A tree at
`.hot-updater/embedded/ota/react/A` from a clean checkout. The explicit matrix
build consumes the prevalidated React, Vue, and Octane SDK3 A trees produced by
the public acceptance workflow. They are generated compiler output and are not
application-owned OTA logic.

The APK is written to `app/build/outputs/apk/release/app-release.apk` and embeds
only the compatible ReactLynx A artifact. OTA files are never copied into the app
by an application-owned provider.

## Nonproduction matrix target

`:matrix-app` is a separate QA application with package ID
`com.hotupdater.lynxmatrix`. It mounts a primary and secondary packaged view and
exposes buttons for primary removal, stale-authority verification, and secondary
fatal failure. The target records structured native events required by the
six-cell acceptance contract. None of its diagnostics are compiled into `:app`.

```sh
pnpm build:lynx:matrix-native -- --platform android
```

The matrix APK is written to
`matrix-app/build/outputs/apk/release/matrix-app-release.apk`. Use it through the
root `pnpm e2e:lynx:matrix` runner so deployment, origin-off launches, BSDIFF,
generation identity, resource leases, and recovery are correlated in one
receipt. A successful APK build alone is not device acceptance.

The production and matrix Android targets currently assemble successfully in
debug and release configurations. The real six-cell device matrix and the
current full `hot-updater-agent` run remain pending.
