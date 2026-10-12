import type { ScenarioDefinition } from "./types.ts";

export const skippedForceUpdatePropagatesScenario: ScenarioDefinition = {
  name: "skipped-force-update-propagates",
  run: async (app) => {
    await app.control(
      "deploy skipped force base bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "skipped-force-base-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "baseBundleId",
        saveResultFieldsAs: {
          releaseId: "baseReleaseId",
        },
      },
    );
    await app.launch("launch skipped force base app");
    await app.tap(
      "install skipped force base bundle",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert skipped force base action result",
      "update-action-result",
      "current-channel -> installed ID $baseReleaseId",
      { exactText: true },
    );
    await app.control(
      "wait skipped force base metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$baseBundleId",
        verificationPending: true,
      },
    );
    await app.reload("reload skipped force base bundle");
    await app.control(
      "wait skipped force base metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$baseBundleId",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert skipped force base marker",
      "runtime-scenario-marker",
      "skipped-force-base-detox",
    );
    await app.control(
      "deploy skipped forced bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        forceUpdate: true,
        marker: "skipped-force-forced-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "forcedBundleId",
      },
    );
    await app.control(
      "deploy unforced latest bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "skipped-force-latest-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "latestBundleId",
        saveResultFieldsAs: {
          releaseId: "latestReleaseId",
        },
      },
    );
    await app.launch("launch app past skipped force update", {
      allowDisconnect: true,
    });
    await app.control(
      "prove skipped force update native reload",
      "/e2e/jobs/wait-for-android-restart",
      {
        bundleId: "$latestBundleId",
        releaseId: "$latestReleaseId",
        runtimeScenarioMarker: "skipped-force-latest-detox",
      },
    );
    await app.control(
      "wait skipped force update automatic reload",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$latestBundleId",
        releaseId: "$latestReleaseId",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert skipped force update Bundle",
      "runtime-bundle-id",
      "$latestBundleId",
    );
    await app.assertText(
      "assert skipped force update Release",
      "runtime-release-state",
      "$latestReleaseId",
    );
    await app.assertText(
      "assert skipped force update marker",
      "runtime-scenario-marker",
      "skipped-force-latest-detox",
    );
    await app.assertText(
      "assert skipped force update launch",
      "launch-status-result",
      [
        "Current Launch Status: UNCHANGED",
        "Current Launch Status: UPDATE_APPLIED",
      ],
    );
  },
};
