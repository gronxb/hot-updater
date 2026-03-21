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
- For the crash phase, the crash patch must live at module top level, outside
  `App`, so the OTA bundle fails during JS module evaluation. Do not use
  `useEffect`, component-body throws, or button-driven crashes for this skill.

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

## UI Funnel And Snapshot Playbook

The example app now uses a non-scroll home screen plus modal panels.
In this skill, the home screen is the primary evidence for pass/fail.
Only open a modal when you need extra detail that is not already visible on the
home screen.

### Home Screen First

After every clean launch or relaunch:

1. Run `agent-device snapshot -i` on the home screen before pressing anything.
2. Use this first home snapshot as the primary checkpoint for:
   - `Bundle ID`
   - `Manifest Bundle ID`
   - `Scenario Marker` when the temporary success patch is present
   - pretty-printed status JSON
   - crash history summary
3. Do not start by opening a modal. The built-in scenario should prove the main
   OTA outcome from the home screen whenever possible.

The home screen always exposes these tappable entry points:

- `Runtime Details`
- `Manifest Inspector`
- `Crash Timeline`
- `Actions`

### Modal Usage Rules

- Press `Runtime Details` only when you need channel, app version, fingerprint,
  or base URL details. After the modal opens, run `agent-device snapshot -i`,
  verify the values, then press `Close`.
- Press `Manifest Inspector` only when you need per-asset inspection. After the
  modal opens, run `agent-device snapshot -i`, verify `Manifest Bundle ID`,
  `Manifest Asset Count`, and the currently visible asset entry. Use
  `Previous Asset` or `Next Asset` only if you need another asset, then
  re-snapshot after each press.
- Press `Crash Timeline` only when you need a focused view of crash entries.
  After the modal opens, run `agent-device snapshot -i`, verify `Crash Count`
  and the currently selected crash entry, then press `Close`.
- Press `Actions` only to use `Refresh Runtime Snapshot`, `Reload App`, or
  `Clear Crash History`. If you open it, capture a snapshot of the modal first
  so the replay clearly shows which action was available and pressed.
- After closing any modal, return to the home screen and run
  `agent-device snapshot -i` again before making a pass/fail decision.

### Baseline Snapshot Expectations

For the first clean launch after install:

1. Stay on the home screen.
2. Run `agent-device snapshot -i`.
3. Record `BUILTIN_BUNDLE_ID` from the `Bundle ID` row.
4. Confirm `Manifest Bundle ID` matches the same built-in id.
5. Confirm the crash history area shows `No crashed bundles recorded.`
6. Treat this home snapshot as the baseline reference before any OTA deploy.

### Phase 1 Snapshot Flow

After the stable OTA deploy and app relaunch:

1. Stay on the home screen and run `agent-device snapshot -i`.
2. Verify directly on this home snapshot:
   - `Scenario Marker`
   - `E2E AUTO SUCCESS`
   - `Bundle ID = STABLE_BUNDLE_ID`
   - `Manifest Bundle ID = STABLE_BUNDLE_ID`
   - status JSON contains `"status": "STABLE"`
   - crash history still shows `No crashed bundles recorded.`
3. Only if asset evidence is needed, press `Manifest Inspector`, snapshot the
   modal, and verify `Manifest Bundle ID` plus the visible asset hash there.
4. Press `Close`, then take one more home snapshot if you need a final clean
   evidence frame for reporting.

### Phase 2 Snapshot Flow

After the crash OTA deploy and the recovered relaunch:

1. Stay on the recovered home screen and run `agent-device snapshot -i`.
2. Verify directly on this home snapshot:
   - `Scenario Marker`
   - `E2E AUTO SUCCESS`
   - `Bundle ID = STABLE_BUNDLE_ID`
   - `Manifest Bundle ID = STABLE_BUNDLE_ID`
   - status JSON contains `"status": "RECOVERED"`
   - status JSON contains `"crashedBundleId": "<CRASH_BUNDLE_ID>"`
   - the crash history section visibly includes `CRASH_BUNDLE_ID`
3. If the home crash history is truncated or ambiguous, press `Crash Timeline`,
   snapshot the modal, and verify `Crash Count` plus the selected crash entry.
4. Press `Close`, then take one more home snapshot if you need the clean final
   recovered frame for the report.

### Diff Guidance

- Use `agent-device diff snapshot -i` immediately after opening a modal or
  after recovery relaunch when you want a compact confirmation of what changed.
- Do not use diff output as the only evidence for ids or statuses. The final
  verdict must still come from a readable full snapshot and optional local
  metadata files.

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

Add this temporary crash patch at module scope, outside `App`, with the real
values substituted:

```tsx
const AUTO_E2E_SAFE_BUNDLE_IDS = new Set([
  "<BUILTIN_BUNDLE_ID>",
  "<STABLE_BUNDLE_ID>",
]);

const AUTO_E2E_CURRENT_BUNDLE_ID = HotUpdater.getBundleId();

if (!AUTO_E2E_SAFE_BUNDLE_IDS.has(AUTO_E2E_CURRENT_BUNDLE_ID)) {
  throw new Error("hot-updater e2e-auto crash bundle");
}
```

Recommended placement:

- Add this patch near the other module-level helpers, before `function App()`.
- Do not keep the success marker in this crash bundle patch.
- Do not put the crash logic inside `App`, `useEffect`, or any UI event
  handler. Those patterns do not reliably produce the crashing OTA bundle this
  scenario needs.

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
