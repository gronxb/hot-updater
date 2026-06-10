import type { DetoxScenarioDefinition } from "./types.ts";

export const bspatchManifestDiffFallbackScenario: DetoxScenarioDefinition = {
  name: "bspatch-manifest-diff-fallback",
  run: async (app) => {
    await app.control(
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
    await app.reload("restart manifest base app");
    await app.control(
      "wait manifest base metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$previousBundleId",
        verificationPending: true,
      },
    );
    await app.reload("reload manifest base update");
    await app.control(
      "wait manifest base metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$previousBundleId",
        verificationPending: false,
      },
    );
    await app.control(
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
    await app.control(
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
    await app.control(
      "assert manifest fallback patch bases",
      "/e2e/assert-bundle-patch-bases",
      {
        absentBaseBundleIds: ["$previousBundleId"],
        bundleId: "$bundleId",
        expectedBaseBundleIds: ["$intermediateBundleId"],
      },
    );
    await app.reload("restart manifest fallback app");
    await app.control(
      "wait manifest fallback metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleId",
        verificationPending: true,
      },
    );
    await app.reload("reload manifest fallback update");
    await app.control(
      "wait manifest fallback metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleId",
        verificationPending: false,
      },
    );
    await app.control(
      "assert manifest diff fallback",
      "/e2e/assert-manifest-diff-applied",
      {
        bundleId: "$bundleId",
        previousBundleId: "$previousBundleId",
      },
    );
  },
};
