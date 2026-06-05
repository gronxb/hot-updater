import type { DetoxScenarioDefinition } from "./types.ts";

export const multiAssetReplacementScenario: DetoxScenarioDefinition = {
  name: "multi-asset-replacement",
  run: async (scenario) => {
    await scenario.launch("launch built-in app");
    await scenario.control(
      "deploy first multi-asset bundle",
      "/e2e/jobs/deploy-bundle",
      {
        bundleProfile: "multiAssetReplacement",
        channel: "production",
        marker: "multi-assets-a-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "firstBundleId",
      },
    );
    await scenario.tap(
      "install first multi-asset update",
      "action-install-current-channel-update",
    );
    await scenario.control(
      "wait first multi-asset metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$firstBundleId",
        relaunchLimit: 0,
        verificationPending: true,
      },
    );
    await scenario.reload("reload first multi-asset update");
    await scenario.control(
      "wait first multi-asset metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$firstBundleId",
        verificationPending: false,
      },
    );
    await scenario.control(
      "assert first multi-assets stored",
      "/e2e/assert-bundle-assets-stored",
      {
        assetPaths: [
          "assets/src/test/_fixture-multi-asset-a.bmp",
          "assets/src/test/_fixture-multi-asset-b.bmp",
          "assets/src/test/_fixture-multi-asset-c.bmp",
        ],
        bundleId: "$firstBundleId",
      },
    );
    await scenario.control(
      "deploy second multi-asset bundle",
      "/e2e/jobs/deploy-bundle",
      {
        bundleProfile: "multiAssetReplacement",
        channel: "production",
        marker: "multi-assets-b-detox",
        mode: "reset",
        safeBundleIds: ["$firstBundleId"],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "secondBundleId",
      },
    );
    await scenario.tap(
      "install second multi-asset update",
      "action-install-current-channel-update",
    );
    await scenario.control(
      "wait second multi-asset metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$secondBundleId",
        relaunchLimit: 0,
        verificationPending: true,
      },
    );
    await scenario.reload("reload second multi-asset update");
    await scenario.control(
      "wait second multi-asset metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$secondBundleId",
        verificationPending: false,
      },
    );
    await scenario.control(
      "assert multi-assets replaced",
      "/e2e/assert-multiple-assets-replaced",
      {
        assetPaths: [
          "assets/src/test/_fixture-multi-asset-a.bmp",
          "assets/src/test/_fixture-multi-asset-b.bmp",
          "assets/src/test/_fixture-multi-asset-c.bmp",
        ],
        bundleId: "$secondBundleId",
        previousBundleId: "$firstBundleId",
      },
    );
  },
};
