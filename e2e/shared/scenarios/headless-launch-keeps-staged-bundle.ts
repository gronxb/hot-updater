import type { ScenarioDefinition } from "./types.ts";

export const headlessLaunchKeepsStagedBundleScenario: ScenarioDefinition = {
  name: "headless-launch-keeps-staged-bundle",
  run: async (app) => {
    await app.control(
      "deploy headless stable",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "headless-stable-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "headlessStableBundleId",
        saveResultFieldsAs: { releaseId: "headlessStableReleaseId" },
      },
    );
    await app.launch("launch headless stable installer");
    await app.tap(
      "install headless stable",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert headless stable installed",
      "update-action-result",
      "current-channel -> installed ID $headlessStableReleaseId",
      { exactText: true },
    );
    await app.control(
      "wait headless stable installed",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$headlessStableBundleId",
        verificationPending: true,
      },
    );
    await app.reload("load headless stable");
    await app.control(
      "verify headless stable first render",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$headlessStableBundleId",
        verificationPending: false,
      },
    );

    await app.control(
      "deploy headless staged bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "headless-staged-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "headlessStagedBundleId",
        saveResultFieldsAs: { releaseId: "headlessStagedReleaseId" },
      },
    );
    await app.launch("refresh headless staged update check");
    await app.tap(
      "stage headless bundle without loading it",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert headless bundle staged",
      "update-action-result",
      "current-channel -> installed ID $headlessStagedReleaseId",
      { exactText: true },
    );
    await app.control(
      "wait headless bundle staged",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$headlessStagedBundleId",
        verificationPending: true,
      },
    );
    await app.terminate("stop the app before the headless task");
    await app.control(
      "run the staged bundle in a headless task",
      "/e2e/launch-headless-task",
      {
        bundleId: "$headlessStagedBundleId",
      },
    );
    await app.terminate("reclaim the headless process");
    await app.launch("open the app after the headless task");
    await app.control(
      "verify staged bundle first render after the headless task",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$headlessStagedBundleId",
        releaseId: "$headlessStagedReleaseId",
        verificationPending: false,
      },
    );
    await app.control(
      "assert staged bundle applied, not recovered",
      "/e2e/assert-launch-report",
      {
        status: "UPDATE_APPLIED",
        fromBundleId: "$headlessStableBundleId",
        fromReleaseId: "$headlessStableReleaseId",
        toBundleId: "$headlessStagedBundleId",
        toReleaseId: "$headlessStagedReleaseId",
      },
    );
    await app.assertText(
      "staged Bundle runs after the headless task",
      "runtime-bundle-id",
      "$headlessStagedBundleId",
    );
    await app.assertText(
      "staged Release runs after the headless task",
      "runtime-release-state",
      "$headlessStagedReleaseId",
    );
    await app.assertText(
      "staged marker runs after the headless task",
      "runtime-scenario-marker",
      "headless-staged-detox",
    );
    await app.assertText(
      "headless task leaves no crash history",
      "crash-history-count",
      "0",
    );
  },
};
