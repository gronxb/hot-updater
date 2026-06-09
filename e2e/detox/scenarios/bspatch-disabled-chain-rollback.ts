import type { DetoxScenarioDefinition } from "./types.ts";

export const bspatchDisabledChainRollbackScenario: DetoxScenarioDefinition = {
  name: "bspatch-disabled-chain-rollback",
  run: async (app) => {
    await app.control(
      "capture built-in bundle id",
      "/e2e/capture-built-in-bundle-id",
      {},
      {
        saveResultAs: "builtInBundleId",
      },
    );
    await app.launch("launch built-in chain app");
    await app.assertText(
      "assert chain built-in marker",
      "runtime-scenario-marker",
      "$initialMarker",
    );
    await app.control(
      "reset chain local app state",
      "/e2e/reset-local-app-state",
    );
    await app.control(
      "deploy chain bundle A",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "chain-a-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "bundleA",
      },
    );
    await app.launch("launch chain bundle A app");
    await app.tap(
      "install chain bundle A",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert chain bundle A action result",
      "update-action-result",
      "current-channel -> installed $bundleA",
    );
    await app.control(
      "wait chain bundle A metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleA",
        relaunchLimit: 0,
        verificationPending: true,
      },
    );
    await app.control(
      "assert chain bundle A uses archive",
      "/e2e/assert-first-ota-uses-archive",
      {
        bundleId: "$bundleA",
      },
    );
    await app.reload("reload chain bundle A");
    await app.control(
      "wait chain bundle A metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleA",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert chain bundle A marker",
      "runtime-scenario-marker",
      "chain-a-detox",
    );
    await app.assertText(
      "assert chain bundle A launch",
      "runtime-bundle-id",
      "$bundleA",
    );
    await app.assertText(
      "assert chain bundle A launch status",
      "launch-status-result",
      "Current Launch Status: STABLE",
    );

    await app.control(
      "deploy chain bundle B",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "chain-b-detox",
        mode: "reset",
        safeBundleIds: ["$bundleA"],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "bundleB",
      },
    );
    await app.launch("launch chain bundle B app");
    await app.tap(
      "install chain bundle B",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert chain bundle B action result",
      "update-action-result",
      "current-channel -> installed $bundleB",
    );
    await app.control(
      "wait chain bundle B metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleB",
        relaunchLimit: 0,
        verificationPending: true,
      },
    );
    await app.reload("reload chain bundle B");
    await app.control(
      "wait chain bundle B metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleB",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert chain bundle B marker",
      "runtime-scenario-marker",
      "chain-b-detox",
    );
    await app.assertText(
      "assert chain bundle B launch",
      "runtime-bundle-id",
      "$bundleB",
    );
    await app.assertText(
      "assert chain bundle B launch status",
      "launch-status-result",
      "Current Launch Status: STABLE",
    );

    await app.control(
      "deploy chain bundle C",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        diffBaseBundleId: "$bundleB",
        marker: "chain-c-detox",
        mode: "reset",
        patchMaxBaseBundles: 2,
        safeBundleIds: ["$bundleA", "$bundleB"],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "bundleC",
      },
    );
    await app.control(
      "assert chain bundle C bases",
      "/e2e/assert-bundle-patch-bases",
      {
        bundleId: "$bundleC",
        expectedBaseBundleIds: ["$bundleB", "$bundleA"],
      },
    );
    await app.launch("launch chain bundle C app");
    await app.tap(
      "install chain bundle C",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert chain bundle C action result",
      "update-action-result",
      "current-channel -> installed $bundleC",
    );
    await app.control(
      "wait chain bundle C metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleC",
        relaunchLimit: 0,
        verificationPending: true,
      },
    );
    await app.reload("reload chain bundle C");
    await app.control(
      "wait chain bundle C metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleC",
        verificationPending: false,
      },
    );
    await app.control(
      "assert chain bundle C patch",
      "/e2e/assert-bsdiff-patch-applied",
      {
        assetPath: "$diffPatchAssetPath",
        baseBundleId: "$bundleB",
        bundleId: "$bundleC",
      },
    );
    await app.assertText(
      "assert chain bundle C marker",
      "runtime-scenario-marker",
      "chain-c-detox",
    );
    await app.assertText(
      "assert chain bundle C launch",
      "runtime-bundle-id",
      "$bundleC",
    );
    await app.assertText(
      "assert chain bundle C launch status",
      "launch-status-result",
      "Current Launch Status: STABLE",
    );
    await app.assertText(
      "assert chain bundle C crash history empty",
      "crash-history-count",
      "0",
    );
    await app.control("capture chain bundle C state", "/e2e/capture-state", {
      prefix: "bspatch-b-to-c",
    });
    await app.control(
      "assert chain bundle C active",
      "/e2e/assert-metadata-active",
      {
        bundleId: "$bundleC",
      },
    );

    await app.control("disable chain bundle C", "/e2e/jobs/patch-bundle", {
      bundleId: "$bundleC",
      enabled: false,
    });
    await app.tap(
      "install rollback to chain bundle B",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert chain bundle B rollback action result",
      "update-action-result",
      "current-channel -> installed $bundleB",
    );
    await app.control(
      "wait chain bundle B rollback metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleB",
        relaunchLimit: 0,
        verificationPending: true,
      },
    );
    await app.reload("reload rollback to chain bundle B");
    await app.control(
      "wait chain bundle B rollback metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleB",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert chain bundle B rollback marker",
      "runtime-scenario-marker",
      "chain-b-detox",
    );
    await app.assertText(
      "assert chain bundle B rollback launch",
      "runtime-bundle-id",
      "$bundleB",
    );
    await app.assertText(
      "assert chain bundle B rollback launch status",
      "launch-status-result",
      "Current Launch Status: STABLE",
    );
    await app.assertText(
      "assert chain bundle B rollback crashed bundle",
      "launch-crashed-bundle-result",
      "Current Crashed Bundle ID: null",
    );
    await app.control(
      "assert chain bundle B rollback active",
      "/e2e/assert-metadata-active",
      {
        bundleId: "$bundleB",
      },
    );

    await app.control("disable chain bundle B", "/e2e/jobs/patch-bundle", {
      bundleId: "$bundleB",
      enabled: false,
    });
    await app.tap(
      "install rollback to chain bundle A",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert chain bundle A rollback action result",
      "update-action-result",
      "current-channel -> installed $bundleA",
    );
    await app.control(
      "wait chain bundle A rollback metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleA",
        relaunchLimit: 0,
        verificationPending: true,
      },
    );
    await app.reload("reload rollback to chain bundle A");
    await app.control(
      "wait chain bundle A rollback metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleA",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert chain bundle A rollback marker",
      "runtime-scenario-marker",
      "chain-a-detox",
    );
    await app.assertText(
      "assert chain bundle A rollback launch",
      "runtime-bundle-id",
      "$bundleA",
    );
    await app.assertText(
      "assert chain bundle A rollback launch status",
      "launch-status-result",
      "Current Launch Status: STABLE",
    );
    await app.assertText(
      "assert chain bundle A rollback crashed bundle",
      "launch-crashed-bundle-result",
      "Current Crashed Bundle ID: null",
    );
    await app.control(
      "assert chain bundle A rollback active",
      "/e2e/assert-metadata-active",
      {
        bundleId: "$bundleA",
      },
    );

    await app.control("disable chain bundle A", "/e2e/jobs/patch-bundle", {
      bundleId: "$bundleA",
      enabled: false,
    });
    await app.tap(
      "install rollback to built-in chain",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert chain built-in rollback no update",
      "update-action-result",
      "current-channel -> no-update",
    );
    await app.control(
      "assert chain built-in metadata reset",
      "/e2e/assert-metadata-reset",
    );
    await app.reload("reload rollback to built-in chain");
    await app.assertText(
      "assert chain built-in bundle",
      "runtime-bundle-id",
      "$builtInBundleId",
    );
    await app.assertText(
      "assert chain built-in marker after rollback",
      "runtime-scenario-marker",
      "$initialMarker",
    );
    await app.assertText(
      "assert chain built-in launch status",
      "launch-status-result",
      "Current Launch Status: STABLE",
    );
    await app.assertText(
      "assert chain built-in crashed bundle",
      "launch-crashed-bundle-result",
      "Current Crashed Bundle ID: null",
    );
    await app.assertText(
      "assert chain built-in crash history empty",
      "crash-history-count",
      "0",
    );
    await app.control(
      "capture chain built-in rollback state",
      "/e2e/capture-state",
      {
        prefix: "bspatch-disabled-chain-to-builtin",
      },
    );
    await app.control(
      "assert chain built-in metadata reset again",
      "/e2e/assert-metadata-reset",
    );
  },
};
