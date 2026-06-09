import { installRuntimeChannelUpdate } from "./install-actions.ts";
import type { DetoxScenarioDefinition } from "./types.ts";

export const runtimeChannelSwitchResetScenario: DetoxScenarioDefinition = {
  name: "runtime-channel-switch-reset",
  run: async (app) => {
    await app.control(
      "capture built-in bundle id",
      "/e2e/capture-built-in-bundle-id",
      {},
      {
        saveResultAs: "builtInBundleId",
      },
    );
    await app.launch("launch built-in runtime channel app");
    await app.assertText(
      "assert runtime channel built-in marker",
      "runtime-scenario-marker",
      "$initialMarker",
    );
    await app.assertText(
      "assert runtime channel initial current",
      "runtime-current-channel",
      "production",
    );
    await app.assertText(
      "assert runtime channel initial default",
      "runtime-default-channel",
      "production",
    );
    await app.assertText(
      "assert runtime channel initially not switched",
      "runtime-channel-switched",
      "false",
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
    await app.launch("launch runtime channel app");
    await installRuntimeChannelUpdate(app, "install runtime channel update");
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
    await app.tap("reload runtime channel update", "action-reload-app");
    await app.assertText(
      "assert runtime channel bundle",
      "runtime-bundle-id",
      "$runtimeBundleId",
    );
    await app.assertText(
      "assert runtime channel marker",
      "runtime-scenario-marker",
      "runtime-channel-beta-detox",
    );
    await app.assertText(
      "assert runtime channel launch status",
      "launch-status-result",
      "Current Launch Status: STABLE",
    );
    await app.assertText(
      "assert runtime channel switched current",
      "runtime-current-channel",
      "beta",
    );
    await app.assertText(
      "assert runtime channel switched default",
      "runtime-default-channel",
      "production",
    );
    await app.assertText(
      "assert runtime channel switched",
      "runtime-channel-switched",
      "true",
    );
    await app.tap("reset runtime channel", "action-reset-runtime-channel");
    await app.assertText(
      "assert runtime channel reset",
      "channel-action-result",
      "reset -> true",
    );
    await app.tap("reload default channel", "action-reload-app");
    await app.assertText(
      "assert reset built-in bundle",
      "runtime-bundle-id",
      "$builtInBundleId",
    );
    await app.assertText(
      "assert reset built-in marker",
      "runtime-scenario-marker",
      "$initialMarker",
    );
    await app.assertText(
      "assert reset launch status",
      "launch-status-result",
      "Current Launch Status: STABLE",
    );
    await app.assertText(
      "assert reset current channel",
      "runtime-current-channel",
      "production",
    );
    await app.assertText(
      "assert reset default channel",
      "runtime-default-channel",
      "production",
    );
    await app.assertText(
      "assert reset channel not switched",
      "runtime-channel-switched",
      "false",
    );
    await app.assertText(
      "assert reset crash history empty",
      "crash-history-count",
      "0",
    );
  },
};
