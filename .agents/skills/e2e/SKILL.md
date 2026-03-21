---
name: e2e
description: Run end-to-end OTA verification for `examples/v0.81.0` with `agent-device`. Use when validating iOS or Android release builds, deploying OTA bundles with `pnpm hot-updater deploy`, checking stable update application, reproducing rollback after a crash bundle, or reading bundle-store metadata and crash history for the v0.81.0 example app.
---

# Hot Updater V0.81 E2E

Use this skill for `examples/v0.81.0` OTA verification only.

Always load and follow [$agent-device](../agent-device/SKILL.md) for device interaction.

Do not encode a fixed test scenario in this skill. The caller provides the scenario. This skill only supplies fixed targets, guardrails, command templates, and inspection helpers for `examples/v0.81.0`.

## Rules

- Run iOS and Android sequentially. Do not overlap platform runs.
- Complete the full iOS flow or the full Android flow first, then move to the other platform. Never execute both platforms at the same time.
- Use `agent-device snapshot`; do not use screenshots unless the user explicitly asks.
- Do not register bundles directly in the standalone DB. Create test bundles only through `pnpm hot-updater deploy ...`.
- Use release binaries only for OTA validation. Do not use debug builds or Metro-attached runs for this skill.
- Rebuild the native app after native package changes. `pnpm -w build` alone is not enough for simulator/device validation.
- Treat `notifyAppReady` as read-only. It must not affect crash detection, rollback, or promotion.
- Public launch status should only be `STABLE` or `RECOVERED`.
- For crash-bundle scenarios, the crash must happen at module top level, outside
  the React component. Do not rely on `useEffect`, render-time component code,
  or UI-triggered throws for rollback validation.

## Fixed Targets

Read [references/runtime-targets.md](references/runtime-targets.md) before running anything.

## Prerequisites

Before running any caller-provided scenario:

1. Run `pnpm -w build`.
2. Confirm the standalone update server is running by checking `http://localhost:3007/hot-updater/version`.
3. Use the exact example workspace: `examples/v0.81.0`.
4. Use release artifacts only.
5. Choose one platform first. Finish that platform end-to-end before starting the other one.

## Command Templates

Use these as building blocks. Pick only what the caller's scenario needs.

Run these templates for one platform at a time. Do not keep iOS and Android sessions active in parallel.

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

### Snapshot And State Inspection

```bash
agent-device snapshot -i
agent-device diff snapshot -i
<repo-root>/.agents/skills/e2e/scripts/inspect_ios_state.sh
<repo-root>/.agents/skills/e2e/scripts/inspect_android_state.sh
```

## Assertions

Apply these assertions only when they match the caller's scenario:

- Only expect public status values `STABLE` or `RECOVERED`.
- Do not expect `PROMOTED`. Promotion is native-only and should not be surfaced to JS anymore.
- `reload` must not affect launch outcome state.
- `notifyAppReady` must be read-only.
- Prefer asserting both UI snapshot and bundle-store metadata when possible.
- For rollback checks, verify `crashedBundleId` and `crashed-history.json` together.

## Optional Crash Patch Pattern

If the caller explicitly asks for a crash bundle, use a temporary patch like this and revert it immediately after deploy:

```ts
const E2E_SAFE_BUNDLE_IDS = new Set([
  "<built-in-bundle-id>",
  "<current-stable-bundle-id>",
]);

const E2E_CURRENT_BUNDLE_ID = HotUpdater.getBundleId();

if (!E2E_SAFE_BUNDLE_IDS.has(E2E_CURRENT_BUNDLE_ID)) {
  throw new Error("hot-updater e2e crash bundle");
}
```

Place this patch at module scope, outside `App`, so the OTA bundle crashes
while the JS module is being evaluated. A crash patch inside `App`,
`useEffect`, or a button handler is not reliable enough for this rollback
scenario and may fail to produce the intended crashing bundle.

## Reporting

If the caller asks for a report, include:

- Platform
- Binary type used. This should always be `Release`.
- Relevant deployed bundle ids
- Final visible `status`
- Final visible `crashedBundleId`, if any
- Final metadata summary
- Crash history summary
- Whether the assertions came from UI snapshot, metadata, or both

## Notes

- In this skill, `<repo-root>` means the checked-out repository root.
- The example app already renders launch status and crash history in `examples/v0.81.0/App.tsx`.
- The iOS installed bundle id is `org.reactjs.native.example.HotUpdaterExample`, even though `hot-updater.config.ts` uses `com.hotupdaterexample` for build config.
