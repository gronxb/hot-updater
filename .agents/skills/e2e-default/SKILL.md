---
name: e2e-default
description: Run the fixed `examples/v0.85.0` Release Catalog regression: install a good Release/Bundle, then crash a newer Release/Bundle and prove full-receipt recovery with directional IDs.
---

# Hot Updater V0.85 Default Release E2E

Always load and follow [$agent-device](../agent-device/SKILL.md) and
[$e2e](../e2e/SKILL.md). This skill owns the scenario. Run iOS, then Android,
unless the caller narrows the platform.

## Scenario

For each platform:

1. Build/reinstall a clean release binary and record `BUILTIN_BUNDLE_ID`.
2. Deploy a good marker bundle; record `STABLE_BUNDLE_ID` and
   `STABLE_RELEASE_ID`.
3. Install/reload it and verify:
   - `runtime-bundle-id` is `STABLE_BUNDLE_ID`;
   - `runtime-release-state` contains `STABLE_RELEASE_ID`, kind `BUNDLE`, the
     authority/scope/generation/high-water/channel/context receipt;
   - marker and manifest bytes belong to `STABLE_BUNDLE_ID`;
   - launch status is `UPDATE_APPLIED` or, on an already-reported process,
     `UNCHANGED`;
   - crash history is empty.
4. Revert the marker patch, add a module-scope crash patch that treats the
   built-in and stable Bundle IDs as safe, deploy it, and record
   `CRASH_BUNDLE_ID` plus `CRASH_RELEASE_ID`. Revert immediately.
5. Install and launch the crash bundle, then relaunch for recovery.
6. Verify:
   - `runtime-bundle-id` returns to `STABLE_BUNDLE_ID`;
   - `runtime-release-state` restores `STABLE_RELEASE_ID` and retains the newer
     catalog high-water;
   - marker/manifest bytes are the stable Bundle's bytes;
   - launch status is `RECOVERED`;
   - launch transition reports
     `CRASH_RELEASE_ID/CRASH_BUNDLE_ID -> STABLE_RELEASE_ID/STABLE_BUNDLE_ID`;
   - Bundle-keyed crash history contains `CRASH_BUNDLE_ID`;
   - native metadata is not verification-pending and contains full stable and
     staging selection receipts.

Recovery to BUILTIN fails this scenario.

## Temporary Patches

Good deploy: make the smallest visible module-scope marker change already
supported by `src/e2eApp/patchSurface.ts`. Do not add a new page.

Crash deploy:

```ts
const E2E_SAFE_BUNDLE_IDS = new Set([
  "<BUILTIN_BUNDLE_ID>",
  "<STABLE_BUNDLE_ID>",
]);

if (!E2E_SAFE_BUNDLE_IDS.has(HotUpdater.getBundleId())) {
  throw new Error("hot-updater e2e-default crash bundle");
}
```

The crash check must execute at module scope, outside `App`.

## Evidence Routes

Use the route/testID table in `../e2e/SKILL.md`. The required routes are:

- `/e2e/runtime-bundle`;
- `/e2e/runtime-release-state`;
- `/e2e/runtime-marker`;
- `/e2e/launch-status`;
- `/e2e/launch-transition`;
- `/e2e/crash-history-count`.

Do not look for `STABLE`, `PROMOTED`, or `crashedBundleId`. The public status
contract is `UNCHANGED | UPDATE_APPLIED | RECOVERED`, with directional Release
and Bundle IDs.

## Raw Native State

- iOS uses snake_case metadata keys (`stable_selection`,
  `staging_selection`, `highest_seen_catalogs`, `verification_pending`).
- Android uses camelCase (`stableSelection`, `stagingSelection`,
  `highestSeenCatalogs`, `verificationPending`).
- Launch reports use `status`, `fromReleaseId`, `fromBundleId`, `toReleaseId`,
  and `toBundleId`.

## Report

Include the built-in Bundle ID, stable/crash Release+Bundle pairs, stable and
recovered receipt/high-water summaries, marker evidence, final public status,
directional launch IDs, crash history, and evidence origin.
