import type { DetoxScenarioDefinition } from "./types.ts";

export const bspatchConsecutiveDiffOtaScenario: DetoxScenarioDefinition = {
  name: "bspatch-consecutive-diff-ota",
  run: async (scenario) => {
    await scenario.control(
      "deploy first diff bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "diff-a-detox",
        mode: "reset",
        patchMaxBaseBundles: 1,
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "firstBundleId",
      },
    );
    await scenario.tap(
      "install first diff bundle",
      "action-install-current-channel-update",
    );
    await scenario.control(
      "wait first diff metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$firstBundleId",
        relaunchLimit: 0,
        verificationPending: true,
      },
    );
    await scenario.reload("reload first diff bundle");
    await scenario.control(
      "wait first diff metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$firstBundleId",
        verificationPending: false,
      },
    );
    await scenario.control(
      "deploy second diff bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        diffBaseBundleId: "$firstBundleId",
        marker: "diff-b-detox",
        mode: "reset",
        patchMaxBaseBundles: 1,
        safeBundleIds: ["$firstBundleId"],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "secondBundleId",
      },
    );
    await scenario.tap(
      "install second diff bundle",
      "action-install-current-channel-update",
    );
    await scenario.control(
      "wait second diff metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$secondBundleId",
        relaunchLimit: 0,
        verificationPending: true,
      },
    );
    await scenario.reload("reload second diff bundle");
    await scenario.control(
      "wait second diff metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$secondBundleId",
        verificationPending: false,
      },
    );
    await scenario.control(
      "assert consecutive diff patch",
      "/e2e/assert-bsdiff-patch-applied",
      {
        assetPath: "$diffPatchAssetPath",
        baseBundleId: "$firstBundleId",
        bundleId: "$secondBundleId",
      },
    );
  },
};
