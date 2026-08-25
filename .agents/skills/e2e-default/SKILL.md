---
name: e2e-default
description: Run the repository's fixed `release-ota-recovery` scenario manually on `examples/v0.85.0` through `../manual-qa`.
---

# Hot Updater V0.85 Default Manual QA

Always load and follow [$manual-qa](../manual-qa/SKILL.md). Pass it the exact
scenario name `release-ota-recovery`. Run iOS, then Android unless the caller
narrows the platform. The checked-out
`e2e/detox/scenarios/release-ota-recovery.ts` file is authoritative if this
summary drifts.

## Scenario

For each platform, execute `release-ota-recovery` through `manual-qa`. Its
expected high-level flow is:

1. Install the prepared release artifact and capture `BUILTIN_BUNDLE_ID`.
2. Deploy the scenario's stable marker bundle; record `STABLE_BUNDLE_ID` and
   `STABLE_RELEASE_ID`.
3. Install/reload it and verify:
   - `runtime-bundle-id` is `STABLE_BUNDLE_ID`;
   - `runtime-release-state` contains `STABLE_RELEASE_ID`, kind `BUNDLE`, the
     authority/scope/generation/high-water/channel/context receipt;
   - marker and manifest bytes belong to `STABLE_BUNDLE_ID`;
   - launch status is `UPDATE_APPLIED` or, on an already-reported process,
     `UNCHANGED`;
   - crash history is empty.
4. Use the scenario's `mode: "crash"` deploy with the built-in and stable
   Bundle IDs in `safeBundleIds`; record `CRASH_BUNDLE_ID` plus
   `CRASH_RELEASE_ID`.
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

## Evidence Routes

Use the route/testID table in `../manual-qa/references/runtime-targets.md`. The
required routes are:

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
