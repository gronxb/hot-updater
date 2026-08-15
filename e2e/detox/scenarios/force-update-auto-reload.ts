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
        saveResultFieldsAs: {
          releaseId: "forceReleaseId",
        },
      },
    );
    await app.launch("launch force update app", { allowDisconnect: true });
    await app.control(
      "prove force update native reload",
      "/e2e/jobs/wait-for-android-restart",
      {
        bundleId: "$forceBundleId",
        releaseId: "$forceReleaseId",
      },
    );
    await app.control(
      "wait force update automatic reload",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$forceBundleId",
        releaseId: "$forceReleaseId",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert force update Bundle",
      "runtime-bundle-id",
      "$forceBundleId",
    );
    await app.assertText(
      "assert force update Release",
      "runtime-release-state",
      "$forceReleaseId",
    );
    await app.assertText(
      "assert force update marker",
      "runtime-scenario-marker",
      "force-update-detox",
    );
    await app.assertText("assert force update launch", "launch-status-result", [
      "Current Launch Status: UNCHANGED",
      "Current Launch Status: UPDATE_APPLIED",
    ]);
  },
};
