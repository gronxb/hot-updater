import type { DetoxScenarioDefinition } from "./types.ts";

export const bspatchManifestDiffFallbackScenario: DetoxScenarioDefinition = {
  name: "bspatch-manifest-diff-fallback",
  run: async (scenario) => {
    await scenario.control(
      "deploy manifest base bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "manifest-base-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "previousBundleId",
      },
    );
    await scenario.launch("launch manifest base app");
    await scenario.tap(
      "install manifest base update",
      "action-install-current-channel-update",
    );
    await scenario.control(
      "wait manifest base metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$previousBundleId",
        relaunchLimit: 0,
        verificationPending: true,
      },
    );
    await scenario.reload("reload manifest base update");
    await scenario.control(
      "wait manifest base metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$previousBundleId",
        verificationPending: false,
      },
    );
    await scenario.control(
      "deploy manifest intermediate bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "manifest-intermediate-detox",
        mode: "reset",
        safeBundleIds: ["$previousBundleId"],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "intermediateBundleId",
      },
    );
    await scenario.control(
      "deploy manifest fallback bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "manifest-fallback-detox",
        mode: "reset",
        patchMaxBaseBundles: 1,
        safeBundleIds: ["$previousBundleId", "$intermediateBundleId"],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "bundleId",
      },
    );
    await scenario.control(
      "assert manifest fallback patch bases",
      "/e2e/assert-bundle-patch-bases",
      {
        absentBaseBundleIds: ["$previousBundleId"],
        bundleId: "$bundleId",
        expectedBaseBundleIds: ["$intermediateBundleId"],
      },
    );
    await scenario.launch("launch manifest fallback app");
    await scenario.tap(
      "install manifest fallback update",
      "action-install-current-channel-update",
    );
    await scenario.control(
      "wait manifest fallback metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleId",
        relaunchLimit: 0,
        verificationPending: true,
      },
    );
    await scenario.reload("reload manifest fallback update");
    await scenario.control(
      "wait manifest fallback metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleId",
        verificationPending: false,
      },
    );
    await scenario.control(
      "assert manifest diff fallback",
      "/e2e/assert-manifest-diff-applied",
      {
        bundleId: "$bundleId",
        previousBundleId: "$previousBundleId",
      },
    );
  },
};
