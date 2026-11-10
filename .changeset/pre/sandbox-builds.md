---
"hot-updater": minor
"@hot-updater/plugin-core": minor
"@hot-updater/protocol": minor
"@hot-updater/apple-helper": minor
"@hot-updater/android-helper": minor
"@hot-updater/react-native": minor
---

Add sandbox builds: `sandbox: true` on a `nativeBuild` scheme builds the app with a native layer for testing, which no other build compiles. `@hot-updater/react-native` gets no new API and no new bridge method. See the Sandbox builds guide.

- iOS: the layer's sources stay excluded unless the CLI's build xcconfig brings them back, and the CLI patches the archive's Info.plist before the export: a dedicated URL scheme and the default channel `sandbox-<scheme>`. The bundle ID stays what Xcode builds: the store app's by default, or a separate configuration's, which `bundleIdentifier` must name. The `.ipa` is for TestFlight internal testing only: the CLI checks it before the upload and reads `buildAudienceType` after it. A closed version train raises the sandbox build's version under the fingerprint strategy, and stops with a next step under `appVersion`.
- A normal build excludes the layer again over a scheme's own `xcconfig`, which would otherwise replace the podspec's exclusion.
- Android: `-PhotUpdaterSandbox=<scheme>` attaches `src/sandbox`, and a CLI-written init script adds `.sandbox` to the application ID and a manifest overlay for the channel. No project file changes. AGP 9's default DSL and a project's own build type manifest are refused.
- Registry: the channel `sandbox-<scheme>` is reserved, with no new column. Before a build is tracked or uploaded, and in `native-build import`, the CLI reads the artifact: a sandbox build must hold the layer and embed a normal build's fingerprint, and a normal build must hold none of it.
- `hot-updater doctor` reports what a sandbox scheme can't build with, a `google-services.json` with no client for the real application ID, and what no sandbox build has been tested with.
- Fix a repeat `assembleRelease` failing with `it is internal in file` on Kotlin 2: every build's `MIN_BUNDLE_ID` changes a generated Java class, so the SDK's module no longer compiles Kotlin incrementally.
