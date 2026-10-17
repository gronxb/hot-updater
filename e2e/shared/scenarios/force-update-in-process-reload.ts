import type { ScenarioDefinition } from "./types.ts";

// setReloadBehavior("reload") applies a force update without a process
// restart. React Native's in-process reload restarts the surfaces it already
// has, so the reloaded bundle must still log its first content and stay active
// after the next cold start.
export const forceUpdateInProcessReloadScenario: ScenarioDefinition = {
  name: "force-update-in-process-reload",
  run: async (app) => {
    await app.control("use in-process reload", "/e2e/screen-state", {
      reloadBehavior: "reload",
    });
    await app.control(
      "deploy in-process force update bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        forceUpdate: true,
        marker: "in-process-reload-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "reloadBundleId",
        saveResultFieldsAs: {
          releaseId: "reloadReleaseId",
        },
      },
    );
    await app.launch("launch in-process force update app", {
      allowDisconnect: true,
    });
    await app.control(
      "wait in-process reload verified",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$reloadBundleId",
        releaseId: "$reloadReleaseId",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert in-process reload marker",
      "runtime-scenario-marker",
      "in-process-reload-detox",
    );
    await app.reload("cold start after in-process reload");
    await app.assertText(
      "assert reloaded bundle survives cold start",
      "runtime-bundle-id",
      "$reloadBundleId",
    );
    await app.assertText(
      "assert reloaded bundle crash history empty",
      "crash-history-count",
      "0",
    );
    await app.control(
      "assert reloaded bundle active",
      "/e2e/assert-metadata-active",
      {
        bundleId: "$reloadBundleId",
      },
    );
  },
};
