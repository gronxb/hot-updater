import type { DetoxScenarioDefinition } from "./types.ts";

export const bspatchConsecutiveDiffOtaScenario: DetoxScenarioDefinition = {
  name: "bspatch-consecutive-diff-ota",
  run: async (app) => {
    await app.control(
      "deploy diff bundle A",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "diff-a-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "bundleA",
      },
    );
    await app.reload("restart diff bundle A app");
    await app.control(
      "wait diff bundle A metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleA",
        verificationPending: true,
      },
    );
    await app.control(
      "assert diff bundle A uses archive",
      "/e2e/assert-first-ota-uses-archive",
      {
        bundleId: "$bundleA",
      },
    );
    await app.reload("reload diff bundle A");
    await app.control(
      "wait diff bundle A metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleA",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert diff bundle A launch",
      "runtime-bundle-id",
      "$bundleA",
    );

    await app.control(
      "deploy diff bundle B",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "diff-b-detox",
        mode: "reset",
        safeBundleIds: ["$bundleA"],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "bundleB",
      },
    );
    await app.reload("restart diff bundle B app");
    await app.control(
      "wait diff bundle B metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleB",
        verificationPending: true,
      },
    );
    await app.reload("reload diff bundle B");
    await app.control(
      "wait diff bundle B metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleB",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert diff bundle B launch",
      "runtime-bundle-id",
      "$bundleB",
    );

    await app.control(
      "deploy diff bundle C",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        diffBaseBundleId: "$bundleB",
        marker: "diff-c-detox",
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
      "assert diff bundle C bases",
      "/e2e/assert-bundle-patch-bases",
      {
        bundleId: "$bundleC",
        expectedBaseBundleIds: ["$bundleB", "$bundleA"],
      },
    );
    await app.reload("restart diff bundle C app");
    await app.control(
      "wait diff bundle C metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleC",
        verificationPending: true,
      },
    );
    await app.reload("reload diff bundle C");
    await app.control(
      "wait diff bundle C metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleC",
        verificationPending: false,
      },
    );
    await app.control(
      "assert diff bundle C patch",
      "/e2e/assert-bsdiff-patch-applied",
      {
        assetPath: "$diffPatchAssetPath",
        baseBundleId: "$bundleB",
        bundleId: "$bundleC",
      },
    );
    await app.assertText(
      "assert diff bundle C launch",
      "runtime-bundle-id",
      "$bundleC",
    );

    await app.control(
      "deploy diff bundle D",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        diffBaseBundleId: "$bundleC",
        marker: "diff-d-detox",
        mode: "reset",
        patchMaxBaseBundles: 2,
        safeBundleIds: ["$bundleB", "$bundleC"],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "bundleD",
      },
    );
    await app.control(
      "assert diff bundle D bases",
      "/e2e/assert-bundle-patch-bases",
      {
        bundleId: "$bundleD",
        expectedBaseBundleIds: ["$bundleC", "$bundleB"],
      },
    );
    await app.reload("restart diff bundle D app");
    await app.control(
      "wait diff bundle D metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleD",
        verificationPending: true,
      },
    );
    await app.reload("reload diff bundle D");
    await app.control(
      "wait diff bundle D metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleD",
        verificationPending: false,
      },
    );
    await app.control(
      "assert diff bundle D patch",
      "/e2e/assert-bsdiff-patch-applied",
      {
        assetPath: "$diffPatchAssetPath",
        baseBundleId: "$bundleC",
        bundleId: "$bundleD",
      },
    );
    await app.assertText(
      "assert diff bundle D launch",
      "runtime-bundle-id",
      "$bundleD",
    );
  },
};
