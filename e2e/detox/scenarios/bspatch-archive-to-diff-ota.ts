import type { DetoxScenarioDefinition } from "./types.ts";

export const bspatchArchiveToDiffOtaScenario: DetoxScenarioDefinition = {
  name: "bspatch-archive-to-diff-ota",
  run: async (scenario) => {
    await scenario.control(
      "deploy archive base bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "archive-base-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "archiveBundleId",
      },
    );
    await scenario.launch("launch archive base app");
    await scenario.tap(
      "install archive base update",
      "action-install-current-channel-update",
    );
    await scenario.control(
      "wait archive base metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$archiveBundleId",
        relaunchLimit: 0,
        verificationPending: true,
      },
    );
    await scenario.control(
      "assert first ota uses archive",
      "/e2e/assert-first-ota-uses-archive",
      {
        bundleId: "$archiveBundleId",
      },
    );
    await scenario.reload("reload archive base update");
    await scenario.control(
      "wait archive base metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$archiveBundleId",
        verificationPending: false,
      },
    );
    await scenario.assertText(
      "assert archive base bundle id",
      "runtime-bundle-id",
      "$archiveBundleId",
    );
    await scenario.assertText(
      "assert archive base marker",
      "runtime-scenario-marker",
      "archive-base-detox",
    );
    await scenario.assertText(
      "assert archive base stable launch",
      "launch-status-result",
      "Current Launch Status: STABLE",
    );
    await scenario.control(
      "deploy diff bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        diffBaseBundleId: "$archiveBundleId",
        marker: "archive-diff-detox",
        mode: "reset",
        patchMaxBaseBundles: 1,
        safeBundleIds: ["$archiveBundleId"],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "diffBundleId",
      },
    );
    await scenario.control(
      "assert archive diff bases",
      "/e2e/assert-bundle-patch-bases",
      {
        bundleId: "$diffBundleId",
        expectedBaseBundleIds: ["$archiveBundleId"],
      },
    );
    await scenario.launch("launch archive diff app");
    await scenario.tap(
      "install archive diff update",
      "action-install-current-channel-update",
    );
    await scenario.control(
      "wait archive diff metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$diffBundleId",
        relaunchLimit: 0,
        verificationPending: true,
      },
    );
    await scenario.reload("reload archive diff update");
    await scenario.control(
      "wait archive diff metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$diffBundleId",
        verificationPending: false,
      },
    );
    await scenario.control(
      "assert archive diff patch",
      "/e2e/assert-bsdiff-patch-applied",
      {
        assetPath: "$diffPatchAssetPath",
        baseBundleId: "$archiveBundleId",
      },
    );
    await scenario.assertText(
      "assert archive diff bundle id",
      "runtime-bundle-id",
      "$diffBundleId",
    );
    await scenario.assertText(
      "assert archive diff marker",
      "runtime-scenario-marker",
      "archive-diff-detox",
    );
    await scenario.assertText(
      "assert archive diff stable launch",
      "launch-status-result",
      "Current Launch Status: STABLE",
    );
  },
};
