# Runtime Targets

Use these fixed values for `examples/v0.81.0`.

## Workspace

- Repo root: `<repo-root>`
- Example root: `<repo-root>/examples/v0.81.0`
- E2E policy: use release binaries only. Do not validate OTA with debug builds or Metro-attached sessions.

## OTA Server

- Standalone base URL: `http://localhost:3007/hot-updater`
- Deploy from the example root with:
  - iOS: `pnpm hot-updater deploy -p ios -t 1.0.x`
  - Android: `pnpm hot-updater deploy -p android -t 1.0.x`

## iOS

- Preferred simulator: `iPhone 16`
- Built app identifier used by `agent-device` and `simctl`: `org.reactjs.native.example.HotUpdaterExample`
- Xcode workspace: `<repo-root>/examples/v0.81.0/ios/HotUpdaterExample.xcworkspace`
- Scheme: `HotUpdaterExample`
- Release derived data default for E2E: `/tmp/hotupdater-v081-ios-e2e`

Important:

- `hot-updater.config.ts` lists `com.hotupdaterexample` for native build config.
- The actual simulator app identifier comes from the Xcode target and resolves to `org.reactjs.native.example.HotUpdaterExample`.
- Use the actual installed identifier for `agent-device open`, `agent-device install`, and `xcrun simctl get_app_container`.

## Android

- Package name: `com.hotupdaterexample`
- App module dir: `<repo-root>/examples/v0.81.0/android`
- Release APK path: `<repo-root>/examples/v0.81.0/android/app/build/outputs/apk/release/app-release.apk`

## UI Assertions

The example app exposes these useful texts in snapshots:

- `Runtime Snapshot`
- `Bundle ID`
- `Manifest Bundle ID`
- `Launch Status`
- pretty-printed status JSON
- `Crash History`
- crash history entries, or `No crashed bundles recorded.`
- `OTA Asset Preview`
- `Manifest Assets`
- `Runtime Details`
- `Actions`
- `Refresh Runtime Snapshot`
- `Reload App`
- `Clear Crash History`

Notes:

- The example UI is intentionally scrollable. Start with a top-of-screen
  snapshot, then use `agent-device scrollintoview "<section title>"` and
  re-snapshot as each target section becomes visible.
- For OTA verdicts, the usual snapshot order is: `Runtime Snapshot` ->
  `Launch Status` -> `Crash History` -> optional deeper sections such as
  `Manifest Assets`, `Runtime Details`, and `Actions`.

## Local State Files

### iOS

Under the simulator data container:

- `Documents/bundle-store/metadata.json`
- `Documents/bundle-store/launch-report.json`
- `Documents/bundle-store/crashed-history.json`
- `Documents/bundle-store/<bundle-id>/...`

### Android

Under the app external files directory:

- `bundle-store/metadata.json`
- `bundle-store/launch-report.json`
- `bundle-store/crashed-history.json`
- `bundle-store/<bundle-id>/...`
