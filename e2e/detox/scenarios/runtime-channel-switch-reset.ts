import type { DetoxScenarioDefinition } from "./types.ts";

export const runtimeChannelSwitchResetScenario: DetoxScenarioDefinition = {
  name: "runtime-channel-switch-reset",
  run: async (app) => {
    await app.launch("launch default channel");
    await app.control(
      "capture built-in bundle id",
      "/e2e/capture-built-in-bundle-id",
      {},
      {
        saveResultAs: "builtInBundleId",
      },
    );
    await app.control(
      "deploy runtime channel bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "beta",
        marker: "runtime-channel-beta-detox",
        message: "Detox runtime channel bundle",
        mode: "reset",
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "runtimeBundleId",
      },
    );
    await app.tap(
      "install runtime channel update",
      "action-install-runtime-channel-update",
      "$runtimeBundleId",
    );
    await app.control(
      "wait runtime channel metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$runtimeBundleId",
        relaunchLimit: 0,
        verificationPending: true,
      },
    );
    await app.assertText(
      "assert runtime channel result",
      "channel-action-result",
      "runtime-channel -> beta",
    );
    await app.reload("reload runtime channel update");
    await app.assertText(
      "assert runtime channel bundle",
      "runtime-bundle-id",
      "$runtimeBundleId",
    );
    await app.tap("reset runtime channel", "action-reset-runtime-channel");
    await app.assertText(
      "assert runtime channel reset",
      "channel-action-result",
      "reset -> true",
    );
    await app.reload("reload default channel");
    await app.assertText(
      "assert reset built-in bundle",
      "runtime-bundle-id",
      "$builtInBundleId",
    );
  },
};
