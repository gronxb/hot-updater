import type { DetoxScenarioDefinition } from "./types.ts";

export const forceUpdateAutoReloadScenario: DetoxScenarioDefinition = {
  name: "force-update-auto-reload",
  run: async (app) => {
    await app.control(
      "deploy force update bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        forceUpdate: true,
        marker: "force-update-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "forceBundleId",
      },
    );
    await app.tap(
      "install force update",
      "action-install-current-channel-update",
      "$forceBundleId",
    );
    await app.control(
      "wait force update metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$forceBundleId",
        relaunchLimit: 0,
        verificationPending: true,
      },
    );
    await app.reload("reload force update");
    await app.control(
      "wait force update metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$forceBundleId",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert force update launch",
      "launch-status-result",
      "Current Launch Status: STABLE",
    );
  },
};
