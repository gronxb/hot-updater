import type { DetoxScenarioDefinition } from "./types.ts";

export const runtimeChannelSwitchResetScenario: DetoxScenarioDefinition = {
  name: "runtime-channel-switch-reset",
  run: async (scenario) => {
    await scenario.launch("launch default channel");
    await scenario.control(
      "capture built-in bundle id",
      "/e2e/capture-built-in-bundle-id",
      {},
      {
        saveResultAs: "builtInBundleId",
      },
    );
    await scenario.control(
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
    await scenario.tap(
      "install runtime channel update",
      "action-install-runtime-channel-update",
    );
    await scenario.control(
      "wait runtime channel metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$runtimeBundleId",
        relaunchLimit: 0,
        verificationPending: true,
      },
    );
    await scenario.assertText(
      "assert runtime channel result",
      "channel-action-result",
      "runtime-channel -> beta",
    );
    await scenario.reload("reload runtime channel update");
    await scenario.assertText(
      "assert runtime channel bundle",
      "runtime-bundle-id",
      "$runtimeBundleId",
    );
    await scenario.tap("reset runtime channel", "action-reset-runtime-channel");
    await scenario.assertText(
      "assert runtime channel reset",
      "channel-action-result",
      "reset -> true",
    );
    await scenario.reload("reload default channel");
    await scenario.assertText(
      "assert reset built-in bundle",
      "runtime-bundle-id",
      "$builtInBundleId",
    );
  },
};
