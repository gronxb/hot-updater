import type { DetoxScenarioDefinition } from "./types.ts";

export const compatibleUpdateColdRestartScenario: DetoxScenarioDefinition = {
  name: "compatible-update-cold-restart",
  run: async (app) => {
    await app.control(
      "deploy compatible update bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "compatible-cold-restart-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "bundleId",
      },
    );
    await app.launch("launch compatible update app");
    await app.tap(
      "install compatible update",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert compatible update action result",
      "update-action-result",
      "current-channel -> installed $bundleId",
      { exactText: true },
    );
    await app.control(
      "wait compatible metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleId",
        verificationPending: true,
      },
    );
    await app.reload("reload compatible update");
    await app.control(
      "wait compatible metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleId",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert compatible runtime bundle",
      "runtime-bundle-id",
      "$bundleId",
    );
    await app.assertText(
      "assert compatible launch",
      "launch-status-result",
      "Current Launch Status: STABLE",
    );
    await app.assertText(
      "assert compatible crash history empty",
      "crash-history-count",
      "0",
    );
    await app.control(
      "capture compatible post-reload state",
      "/e2e/capture-state",
      {
        prefix: "compatible-update-post-reload",
      },
    );
    await app.control(
      "assert compatible metadata active",
      "/e2e/assert-metadata-active",
      {
        bundleId: "$bundleId",
      },
    );
    await app.terminate("terminate compatible update app");
    await app.launch("cold relaunch compatible update app");
    await app.assertText(
      "assert compatible cold runtime bundle",
      "runtime-bundle-id",
      "$bundleId",
    );
    await app.assertText(
      "assert compatible cold launch",
      "launch-status-result",
      "Current Launch Status: STABLE",
    );
    await app.assertText(
      "assert compatible cold crash history empty",
      "crash-history-count",
      "0",
    );
    await app.control("capture compatible cold state", "/e2e/capture-state", {
      prefix: "compatible-update-cold-relaunch",
    });
    await app.control(
      "assert compatible cold metadata active",
      "/e2e/assert-metadata-active",
      {
        bundleId: "$bundleId",
      },
    );
  },
};
