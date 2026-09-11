# Android native feasibility host

This private G1 host uses Sparkling's native `HybridKit` and Lynx's resource and
module hooks. It is an executable feasibility fixture, not a production OTA
installer. Manual placement and trusted launch receipts are intentionally used
before the public integration and catalog engine exist.

The Gradle wrapper and initial project settings were adapted from the Apache-2.0
[Sparkling template](https://github.com/tiktok/sparkling/tree/c4ce8d25c5ea277e13752d68ff1f2a66f5704240/template/sparkling-app-template/android).
The published Sparkling 2.1.0-rc.12 AAR uses older Lynx dependencies and lacks the
source tree's view-created listener. This host pins Lynx 3.9.0 and PrimJS
3.8.0-alpha.6 explicitly, and uses the public `LynxViewBuilder` with Sparkling's `SimpleLynxKitView`
constructor so resource hooks are installed before native engine creation.

Build with JDK 17 and Android SDK 34. Native fixture staging under
`.hot-updater/embedded/<framework>/A` must include the manifest and metadata
produced by the repository's private `scripts/lynx-g1-stage.mjs` helper. Only
embedded A belongs in APK assets. B is manually placed in the application's internal
`staged/<framework>/<slot>` directory via the shell-only G1 content provider,
copied to immutable internal storage, and checked against the trusted Bundle ID and manifest hash before evaluation.
The release build is not debuggable; the development signing key is solely for
this local feasibility app.

`hot-updater:///` resource paths resolve within the process's selected installation.
Image paths become release-specific `file:///` paths before the Fresco cache.
The module receives the actual Lynx context, and readiness requires both the
app's essential-bootstrap signal and native initial-content observation. The
resource probe also requires a real native font load. Confirmation is persisted
before the success callback; a second primary is rejected in the same process.
The journal distinguishes fatal Bundle failures from unknown Release exits.

The G1-only `noPrimary`, `secondary` and `readyDelayMs` intent parameters drive
context scenarios. The exported staging provider and trusted intent receipts
are private probe infrastructure and must not enter the public native package.

See [Android evidence](../../../plans/lynx-support/evidence/android.md) for the
commands actually run and remaining gaps. Do not infer OTA completion from a
successful APK build.
