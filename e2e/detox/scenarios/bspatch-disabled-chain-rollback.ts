import type { DetoxScenarioDefinition } from "./types.ts";

export const bspatchDisabledChainRollbackScenario: DetoxScenarioDefinition = {
  name: "bspatch-disabled-chain-rollback",
  run: async (app) => {
    await app.control(
      "deploy chain base bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "chain-base-detox",
        mode: "reset",
        patchMaxBaseBundles: 2,
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "baseBundleId",
      },
    );
    await app.control("disable chain base bundle", "/e2e/jobs/patch-bundle", {
      bundleId: "$baseBundleId",
      enabled: false,
    });
    await app.control(
      "assert disabled chain bases",
      "/e2e/assert-bundle-patch-bases",
      {
        bundleId: "$baseBundleId",
      },
    );
  },
};
