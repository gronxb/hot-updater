---
name: e2e
description: Run Release Catalog OTA verification for `examples/v0.85.0` with the route-based example and `agent-device`. Use for release builds, Release/Bundle selection, catalog policy, artifact install, rollout, runtime channels, and crash recovery.
---

# Hot Updater V0.85 Release Catalog E2E

Use this skill only for `examples/v0.85.0`. Always load and follow
[$agent-device](../agent-device/SKILL.md), then read
[references/runtime-targets.md](references/runtime-targets.md).

The caller supplies the scenario. Keep its intent and choose assertions at the
correct identity layer: Release for selection/policy, Bundle for bytes,
patches, manifests, storage, and crash history.

## Rules

- Run iOS and Android sequentially with release binaries. Never overlap runs or
  validate through Metro/debug builds.
- Run `pnpm -w build` and rebuild the native app after native package changes.
- Deploy only through `pnpm hot-updater deploy`; never seed Bundle or Release
  rows directly.
- Capture both `bundleId` and the Release created for it. The Bundle ID remains
  available in `dist/manifest.json`; resolve the Release through `hot-updater
  release list/show --json` or the Detox deploy result.
- Use `agent-device snapshot -i`; use screenshots only when asked.
- Public launch statuses are exactly `UNCHANGED | UPDATE_APPLIED | RECOVERED`.
  Directional identity is `fromReleaseId`, `fromBundleId`, `toReleaseId`, and
  `toBundleId`. Do not expect `STABLE`, `PROMOTED`, or `crashedBundleId`.
- `notifyAppReady` is read-only. It must not affect crash detection, rollback,
  or receipt promotion.
- Crash bundles must throw at module scope. Do not use `useEffect`, component
  rendering, or a UI action for the crash.

## Fixed Targets And Build Commands

Use the exact commands and app identifiers in `references/runtime-targets.md`.
The standalone server readiness URL is
`http://localhost:3007/hot-updater/version`.

Deploy from `<repo-root>/examples/v0.85.0`:

```bash
pnpm hot-updater deploy -p ios -t 1.0.x
pnpm hot-updater deploy -p android -t 1.0.x
```

## Route-Based Example Contract

The example has one focused target per deep-link route. Open the route that
owns the assertion and take a fresh snapshot; do not search a scroll-heavy
main page.

| Evidence | Deep link | testID |
| --- | --- | --- |
| Bundle identity | `hotupdaterexample://e2e/runtime-bundle` | `runtime-bundle-id` |
| Release receipt, selection kind, authority, scope, generation, high-water, channel, context | `hotupdaterexample://e2e/runtime-release-state` | `runtime-release-state` |
| Manifest bytes | `hotupdaterexample://e2e/runtime-large-asset` | `runtime-large-e2e-asset` |
| Scenario marker | `hotupdaterexample://e2e/runtime-marker` | `runtime-scenario-marker` |
| Launch status | `hotupdaterexample://e2e/launch-status` | `launch-status-result` |
| Directional launch IDs | `hotupdaterexample://e2e/launch-transition` | `launch-transition-result` |
| Crash history count | `hotupdaterexample://e2e/crash-history-count` | `crash-history-count` |
| Install current channel | `hotupdaterexample://e2e/action/install-current-channel-update` | `action-install-current-channel-update` |
| Install runtime channel | `hotupdaterexample://e2e/action/install-runtime-channel-update` | `action-install-runtime-channel-update` |
| Update action result | `hotupdaterexample://e2e/update-action-result` | `update-action-result` |

The action text distinguishes `installed Release <R> / Bundle <B>`, `adopted
Release <R> / Bundle <B>`, `selected EMBEDDED Release <R>`, `selected
BUILTIN`, `no-update`, and `skipped`.

## Detox Control Contract

When driving the repository harness, use:

- deploy: `POST /e2e/jobs/deploy-bundle`, returning `bundleId`, `releaseId`,
  `authorityId`, `scopeKey`, and `generation`;
- Release policy: `POST /e2e/jobs/patch-release` with `releaseId`;
- rollout samples: `POST /e2e/compute-rollout-sample` with `releaseId`;
- Bundle artifact assertions: keep using Bundle IDs;
- metadata waits/assertions: require Release receipts and catalog high-water;
- launch reports: assert directional Release and Bundle IDs;
- proxy controls: `/e2e/proxy-control`, `/e2e/proxy-state`, and
  `/e2e/assert-proxy` for counts, exact-generation capture/freeze/replay, path
  cardinality, zero-artifact assertions, and catalog/artifact delays.

Catalog URLs are shared scope URLs and must not contain current/minimum Release
or Bundle IDs, install ID, cohort, or crash state.

## Assertions

- Assert Release ID plus receipt fields for selection or policy behavior.
- Assert Bundle ID plus manifest/storage evidence for byte behavior.
- For same-Bundle adoption, assert a new Release receipt, no artifact request,
  and no reload.
- For BUILTIN/EMBEDDED, assert the persisted selection kind and full receipt;
  Bundle slots may be empty.
- For crash recovery, assert Bundle-keyed crash history, full restored receipt,
  retained high-water, and directional Release+Bundle launch report.
- For rollout/target changes, keep the Release ID stable while catalog
  generation advances and local context selection changes.
- For force update, observe the configured automatic reload; do not tap a
  manual install/reload action.

## Crash Patch Pattern

Use a temporary module-scope patch and revert it immediately after deploy:

```ts
const E2E_SAFE_BUNDLE_IDS = new Set([
  "<built-in-bundle-id>",
  "<stable-bundle-id>",
]);

if (!E2E_SAFE_BUNDLE_IDS.has(HotUpdater.getBundleId())) {
  throw new Error("hot-updater e2e crash bundle");
}
```

## Reporting

Report platform, release binary, deployed Release/Bundle pairs, final receipt
(kind/authority/scope/generation/high-water/channel/context), public status,
directional IDs, crash history, artifact evidence, and whether each assertion
came from a route snapshot, native metadata, or both.
