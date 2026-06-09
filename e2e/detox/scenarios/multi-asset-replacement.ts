import type { DetoxScenarioDefinition } from "./types.ts";

export const multiAssetReplacementScenario: DetoxScenarioDefinition = {
  name: "multi-asset-replacement",
  run: async (app) => {
    await app.control(
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
    await app.launch("launch first multi-asset app");
    await app.tap(
      "install first multi-asset update",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert first multi-asset action result",
      "update-action-result",
      "current-channel -> installed $firstBundleId",
      { exactText: true },
    );
    await app.control(
      "wait first multi-asset metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$firstBundleId",
        relaunchLimit: 0,
        verificationPending: true,
      },
    );
    await app.reload("reload first multi-asset update");
    await app.control(
      "wait first multi-asset metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$firstBundleId",
        verificationPending: false,
      },
    );
    await app.control(
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
    await app.control(
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
    await app.launch("launch second multi-asset app");
    await app.tap(
      "install second multi-asset update",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert second multi-asset action result",
      "update-action-result",
      "current-channel -> installed $secondBundleId",
      { exactText: true },
    );
    await app.control(
      "wait second multi-asset metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$secondBundleId",
        relaunchLimit: 0,
        verificationPending: true,
      },
    );
    await app.reload("reload second multi-asset update");
    await app.control(
      "wait second multi-asset metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$secondBundleId",
        verificationPending: false,
      },
    );
    await app.control(
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
