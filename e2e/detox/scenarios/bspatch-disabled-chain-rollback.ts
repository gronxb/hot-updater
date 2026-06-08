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
      "assert chain bundle A launch",
      "runtime-bundle-id",
      "$bundleA",
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
      "assert chain bundle B launch",
      "runtime-bundle-id",
      "$bundleB",
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
      "assert chain bundle C launch",
      "runtime-bundle-id",
      "$bundleC",
    );

    await app.control("disable chain bundle C", "/e2e/jobs/patch-bundle", {
      bundleId: "$bundleC",
      enabled: false,
    });
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
      "assert chain bundle B rollback launch",
      "runtime-bundle-id",
      "$bundleB",
    );

    await app.control("disable chain bundle B", "/e2e/jobs/patch-bundle", {
      bundleId: "$bundleB",
      enabled: false,
    });
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
      "assert chain bundle A rollback launch",
      "runtime-bundle-id",
      "$bundleA",
    );

    await app.control("disable chain bundle A", "/e2e/jobs/patch-bundle", {
      bundleId: "$bundleA",
      enabled: false,
    });
    await app.reload("reload rollback to built-in chain");
    await app.control(
      "assert chain built-in metadata reset",
      "/e2e/assert-metadata-reset",
    );
    await app.assertText(
      "assert chain built-in bundle",
      "runtime-bundle-id",
      "$builtInBundleId",
    );
  },
};
