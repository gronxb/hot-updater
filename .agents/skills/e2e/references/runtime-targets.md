# Runtime Targets

Use release binaries for `examples/v0.85.0`; never validate OTA through Metro.

## Workspace And Server

- Repo: `<repo-root>`
- Example: `<repo-root>/examples/v0.85.0`
- Standalone base URL: `http://localhost:3007/hot-updater`
- Readiness: `http://localhost:3007/hot-updater/version`
- Deploy from the example root:
  - `pnpm hot-updater deploy -p ios -t 1.0.x`
  - `pnpm hot-updater deploy -p android -t 1.0.x`

## iOS

- Simulator: `iPhone 16`
- Installed identifier: `org.reactjs.native.example.HotUpdaterExample`
- Workspace: `ios/HotUpdaterExample.xcworkspace`
- Scheme/configuration: `HotUpdaterExample` / `Release`
- Derived data: `/tmp/hotupdater-v085-ios-e2e`

## Android

- Package: `com.hotupdaterexample`
- Build: `android/gradlew :app:assembleRelease --rerun-tasks`
- APK: `android/app/build/outputs/apk/release/app-release.apk`

## Route-Based Evidence

The app exposes focused deep links, not one scroll page:

- `hotupdaterexample://e2e/runtime-bundle`
- `hotupdaterexample://e2e/runtime-release-state`
- `hotupdaterexample://e2e/runtime-marker`
- `hotupdaterexample://e2e/runtime-large-asset`
- `hotupdaterexample://e2e/launch-status`
- `hotupdaterexample://e2e/launch-transition`
- `hotupdaterexample://e2e/crash-history-count`
- `hotupdaterexample://e2e/action/install-current-channel-update`
- `hotupdaterexample://e2e/update-action-result`

Take a fresh `agent-device snapshot -i` after opening each target.

## Native State

iOS container:

- `Documents/bundle-store/metadata.json`
- `Documents/bundle-store/launch-report.json`
- `Documents/bundle-store/crashed-history.json`
- `Documents/bundle-store/<bundle-id>/...`

Android app files:

- `bundle-store/metadata.json`
- `bundle-store/launch-report.json`
- `bundle-store/crashed-history.json`
- `bundle-store/<bundle-id>/...`

Metadata-v2 contains stable/staging selection receipts plus authority/scope
catalog high-water. Launch reports contain directional Release and Bundle IDs.
