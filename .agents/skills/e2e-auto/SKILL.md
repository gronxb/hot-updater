---
name: e2e-auto
description: "Run a fixed OTA regression flow for `examples/v0.81.0` with `agent-device`. Use when the caller wants a built-in end-to-end scenario instead of defining one manually: deploy a known-good OTA bundle, verify a visible UI change plus the deployed `bundleId`, then deploy an intentionally crashing OTA bundle and verify rollback to the previous stable bundle with `RECOVERED` and `crashedBundleId` evidence."
---

# Hot Updater V0.81 E2E Auto

Use this skill for `examples/v0.81.0` only.

Always load and follow [$agent-device](../agent-device/SKILL.md).
Read [../e2e/references/runtime-targets.md](../e2e/references/runtime-targets.md) before running anything.

This skill owns the scenario. Do not ask the caller to provide the test steps.

## Rules

- Run iOS and Android sequentially. Never overlap platform runs.
- If the caller does not choose a platform, run iOS first, then Android.
- Use release binaries only. Do not use debug builds or Metro-attached sessions.
- Do not register bundles directly in the standalone DB. Create test bundles only through `pnpm hot-updater deploy ...`.
- Keep the example source clean. Revert every temporary patch immediately after its deploy finishes.
- Use `examples/v0.81.0/dist/manifest.json` as the source of truth for each deployed bundle id. Capture it immediately after each deploy because the next deploy overwrites it.
- Use `agent-device snapshot -i`; do not use screenshots unless the caller explicitly asks.
- Keep the success marker out of the crash bundle. The success marker must reappear only if rollback returns to the previous stable bundle.
- Public launch status should only be `STABLE` or `RECOVERED`.

## Fixed Scenario

Run this exact two-phase flow per platform:

1. Build and install the baseline release app.
2. Capture the built-in bundle id from the first clean launch.
3. Deploy a known-good OTA bundle with a visible marker.
4. Verify the app shows the marker and the deployed bundle id.
5. Deploy an intentionally crashing OTA bundle.
6. Verify the app recovers to the previous stable bundle and reports the crashed bundle id.

## Preflight

Before phase 1:

1. Run `pnpm -w build`.
2. Confirm the standalone update server is reachable at `http://localhost:3007/hot-updater/version`.
3. Use the exact workspace: `<repo-root>/examples/v0.81.0`.
4. Build and install the release app for one platform.
5. Launch the app and capture a baseline snapshot.
6. Record the first clean-launch bundle id shown in the UI as `BUILTIN_BUNDLE_ID`.
7. Confirm the crash history section is empty before continuing.

## Command Templates

Use these for one platform at a time.

### iOS Build And Install

```bash
agent-device ensure-simulator --platform ios --device "iPhone 16" --boot

cd <repo-root>/examples/v0.81.0/ios

pnpx pod-install

xcodebuild -workspace HotUpdaterExample.xcworkspace \
  -scheme HotUpdaterExample \
  -configuration Release \
  -sdk iphonesimulator \
  -destination 'id=<simulator-udid>' \
  -derivedDataPath /tmp/hotupdater-v081-ios-e2e build

agent-device reinstall HotUpdaterExample \
  /tmp/hotupdater-v081-ios-e2e/Build/Products/Release-iphonesimulator/HotUpdaterExample.app \
  --platform ios \
  --device "iPhone 16"

agent-device open org.reactjs.native.example.HotUpdaterExample \
  --platform ios \
  --device "iPhone 16" \
  --session qa-ios-v081 \
  --relaunch
```

### Android Build And Install

```bash
cd <repo-root>/examples/v0.81.0/android

./gradlew :app:assembleRelease --rerun-tasks

agent-device reinstall com.hotupdaterexample \
  <repo-root>/examples/v0.81.0/android/app/build/outputs/apk/release/app-release.apk \
  --platform android \
  --serial <serial>

agent-device open com.hotupdaterexample \
  --platform android \
  --serial <serial> \
  --session qa-android-v081 \
  --relaunch
```

### OTA Deploy

Run deploy from `<repo-root>/examples/v0.81.0`.

```bash
pnpm hot-updater deploy -p ios -t 1.0.x
pnpm hot-updater deploy -p android -t 1.0.x
```

### Capture Deployed Bundle ID

Run this from `<repo-root>/examples/v0.81.0` immediately after each deploy:

```bash
node -p "require('./dist/manifest.json').bundleId"
```

### Snapshot And State Inspection

```bash
agent-device snapshot -i
agent-device diff snapshot -i
<repo-root>/.agents/skills/e2e/scripts/inspect_ios_state.sh
<repo-root>/.agents/skills/e2e/scripts/inspect_android_state.sh
```

## Phase 1: Stable Bundle

Create a temporary visible marker in `examples/v0.81.0/App.tsx`.

Use this exact marker text:

```tsx
const AUTO_E2E_SUCCESS_MARKER = "E2E AUTO SUCCESS";
```

Render it in the `Runtime Snapshot` section with:

```tsx
<InfoRow label="Scenario Marker" value={AUTO_E2E_SUCCESS_MARKER} />
```

Recommended placement:

- Add the constant near `readRuntimeSnapshot`.
- Add the `InfoRow` next to the other bundle metadata rows in `Runtime Snapshot`.

Then:

1. Deploy OTA for the active platform.
2. Capture the deployed id as `STABLE_BUNDLE_ID` from `dist/manifest.json`.
3. Revert the temporary success patch immediately after deploy.
4. Relaunch the app.
5. Capture a fresh snapshot and optional local state dump.

Phase 1 passes only if all of these are true:

- The UI shows `Scenario Marker` and `E2E AUTO SUCCESS`.
- `Bundle ID` equals `STABLE_BUNDLE_ID`.
- `Manifest Bundle ID` equals `STABLE_BUNDLE_ID`.
- The visible status JSON contains `"status": "STABLE"`.
- The crash history section is still empty.
- If you inspect local files, `metadata.json` references `STABLE_BUNDLE_ID` as the stable bundle and is not verification-pending.

## Phase 2: Crash Bundle

Start from the clean baseline source with the success patch already reverted.

Add this temporary crash patch inside `App` with the real values substituted:

```tsx
useEffect(() => {
  const currentBundleId = HotUpdater.getBundleId();
  const safeBundleIds = new Set([
    "<BUILTIN_BUNDLE_ID>",
    "<STABLE_BUNDLE_ID>",
  ]);

  if (!safeBundleIds.has(currentBundleId)) {
    throw new Error("hot-updater e2e-auto crash bundle");
  }
}, []);
```

Recommended placement:

- Add this `useEffect` after the existing `BootSplash.hide` effect.
- Do not keep the success marker in this crash bundle patch.

Then:

1. Deploy OTA for the active platform.
2. Capture the deployed id as `CRASH_BUNDLE_ID` from `dist/manifest.json`.
3. Revert the temporary crash patch immediately after deploy.
4. Relaunch the app once to let the bad bundle apply.
5. If the app terminates or the session drops, reopen the app once more. The first failing launch is expected.
6. Capture a fresh snapshot and local state dump after the recovered launch.

Phase 2 passes only if all of these are true:

- The final recovered UI still shows `Scenario Marker` and `E2E AUTO SUCCESS`.
- The final `Bundle ID` equals `STABLE_BUNDLE_ID`, not `CRASH_BUNDLE_ID`.
- The final `Manifest Bundle ID` equals `STABLE_BUNDLE_ID`, not `CRASH_BUNDLE_ID`.
- The visible status JSON contains `"status": "RECOVERED"`.
- The visible status JSON contains `"crashedBundleId": "<CRASH_BUNDLE_ID>"`.
- The crash history section contains `CRASH_BUNDLE_ID`.
- `launch-report.json` reports `RECOVERED` with `crashedBundleId = CRASH_BUNDLE_ID`.
- `metadata.json` is no longer verification-pending and still points at `STABLE_BUNDLE_ID` as the stable bundle.

Treat recovery to the built-in bundle as a failure for this scenario. The required behavior is rollback to the previous stable OTA bundle.

## Platform Metadata Keys

Use the platform-native JSON keys when checking raw files:

- iOS metadata: `stable_bundle_id`, `staging_bundle_id`, `verification_pending`
- Android metadata: `stableBundleId`, `stagingBundleId`, `verificationPending`
- iOS and Android launch report: `status`, `crashedBundleId`

## Reporting

If the caller asks for a report, include:

- Platform
- Binary type used. This should always be `Release`.
- `BUILTIN_BUNDLE_ID`
- `STABLE_BUNDLE_ID`
- `CRASH_BUNDLE_ID`
- Whether the success marker appeared after the stable deploy
- Whether the success marker reappeared after recovery
- Final visible `status`
- Final visible `crashedBundleId`
- Metadata summary
- Launch report summary
- Crash history summary
- Whether each assertion came from UI snapshot, local metadata, or both

## Notes

- In this skill, `<repo-root>` means the checked-out repository root.
- The example app already renders `Bundle ID`, `Manifest Bundle ID`, status JSON, and crash history in `examples/v0.81.0/App.tsx`.
- The installed iOS app id is `org.reactjs.native.example.HotUpdaterExample`, even though `hot-updater.config.ts` uses `com.hotupdaterexample` for native build config.
