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
    await app.launch("launch force update app");
    await app.tap(
      "install force update",
      "action-install-current-channel-update",
    );
    await app.control(
      "wait force update metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$forceBundleId",
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
      "assert force update runtime bundle",
      "runtime-bundle-id",
      "$forceBundleId",
    );
    await app.assertText(
      "assert force update launch",
      "launch-status-result",
      "Current Launch Status: STABLE",
    );
    await app.assertText(
      "assert force update crash history empty",
      "crash-history-count",
      "0",
    );
    await app.control(
      "capture force update post-reload state",
      "/e2e/capture-state",
      {
        prefix: "force-update-post-reload",
      },
    );
    await app.control(
      "assert force update metadata active",
      "/e2e/assert-metadata-active",
      {
        bundleId: "$forceBundleId",
      },
    );
    await app.terminate("terminate force update app");
    await app.launch("cold relaunch force update app");
    await app.assertText(
      "assert force update cold runtime bundle",
      "runtime-bundle-id",
      "$forceBundleId",
    );
    await app.assertText(
      "assert force update cold launch",
      "launch-status-result",
      "Current Launch Status: STABLE",
    );
    await app.assertText(
      "assert force update cold crash history empty",
      "crash-history-count",
      "0",
    );
    await app.control("capture force update cold state", "/e2e/capture-state", {
      prefix: "force-update-cold-relaunch",
    });
    await app.control(
      "assert force update cold metadata active",
      "/e2e/assert-metadata-active",
      {
        bundleId: "$forceBundleId",
      },
    );
  },
};
