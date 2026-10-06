import type { ScenarioDefinition } from "./types.ts";

// A user leaves during the first launch of a healthy bundle, before it renders.
export const interruptedLaunchRetriesBundleScenario: ScenarioDefinition = {
  name: "interrupted-launch-retries-bundle",
  run: async (app) => {
    await app.control(
      "deploy interrupted-launch stable",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "interrupted-stable-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "interruptedStableBundleId",
        saveResultFieldsAs: { releaseId: "interruptedStableReleaseId" },
      },
    );
    await app.launch("launch interrupted-launch stable installer");
    await app.tap(
      "install interrupted-launch stable",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert interrupted-launch stable installed",
      "update-action-result",
      "current-channel -> installed ID $interruptedStableReleaseId",
      { exactText: true },
    );
    await app.control(
      "wait interrupted-launch stable installed",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$interruptedStableBundleId",
        verificationPending: true,
      },
    );
    await app.reload("load interrupted-launch stable");
    await app.control(
      "verify interrupted-launch stable first render",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$interruptedStableBundleId",
        verificationPending: false,
      },
    );

    // Healthy, but its first render takes a while.
    await app.control(
      "deploy slow-starting bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "interrupted-slow-detox",
        mode: "slow-start",
        safeBundleIds: ["$interruptedStableBundleId"],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "slowBundleId",
        saveResultFieldsAs: { releaseId: "slowReleaseId" },
      },
    );
    await app.launch("refresh slow-starting update check");
    await app.tap(
      "install slow-starting bundle",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert slow-starting bundle installed",
      "update-action-result",
      "current-channel -> installed ID $slowReleaseId",
      { exactText: true },
    );
    await app.control(
      "wait slow-starting bundle installed",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$slowBundleId",
        verificationPending: true,
      },
    );
    await app.terminate("stop stable process before the slow launch");
    await app.control(
      "start the slow-starting bundle",
      "/e2e/launch-startup-hang",
      {
        bundleId: "$slowBundleId",
      },
    );
    await app.terminate("leave the app before its first render");
    await app.launch("cold start after the interrupted launch");
    await app.control(
      "recover stable bundle after the interrupted launch",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$interruptedStableBundleId",
        releaseId: "$interruptedStableReleaseId",
        verificationPending: false,
        attempts: 120,
      },
    );
    await app.control(
      "assert interrupted-launch recovery report",
      "/e2e/assert-launch-report",
      {
        status: "RECOVERED",
        fromBundleId: "$slowBundleId",
        fromReleaseId: "$slowReleaseId",
        toBundleId: "$interruptedStableBundleId",
        toReleaseId: "$interruptedStableReleaseId",
      },
    );
    await app.control(
      "assert slow-starting bundle awaits its retry",
      "/e2e/assert-crash-history",
      {
        bundleId: "$slowBundleId",
        awaitingRetry: true,
      },
    );
    await app.tap(
      "check for updates in the session that recovered",
      "action-install-current-channel-update",
    );
    // The changed crash history re-adopts the running Release with a fresh
    // receipt; the slow-starting bundle must not be staged.
    await app.assertText(
      "the session that recovered re-adopts the stable Release",
      "update-action-result",
      "current-channel -> adopted ID $interruptedStableReleaseId",
      { exactText: true },
    );
    await app.control(
      "the session that recovered keeps the bundle out",
      "/e2e/assert-metadata-active",
      {
        bundleId: "$interruptedStableBundleId",
      },
    );

    await app.terminate("stop the session that recovered");
    await app.launch("open the app again");
    await app.tap(
      "install slow-starting bundle for its retry",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert slow-starting bundle installed for its retry",
      "update-action-result",
      "current-channel -> installed ID $slowReleaseId",
      { exactText: true },
    );
    await app.control(
      "wait slow-starting bundle installed for its retry",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$slowBundleId",
        verificationPending: true,
      },
    );
    await app.terminate("stop stable process before the retry");
    // The bundle holds its first render for 30 seconds.
    await app.launch("open the app with the retried bundle");
    await app.control(
      "verify the retried bundle's first render",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$slowBundleId",
        releaseId: "$slowReleaseId",
        verificationPending: false,
        attempts: 240,
      },
    );
    await app.control(
      "assert the retried bundle applied",
      "/e2e/assert-launch-report",
      {
        status: "UPDATE_APPLIED",
        fromBundleId: "$interruptedStableBundleId",
        fromReleaseId: "$interruptedStableReleaseId",
        toBundleId: "$slowBundleId",
        toReleaseId: "$slowReleaseId",
      },
    );
    await app.assertText(
      "retried Bundle runs",
      "runtime-bundle-id",
      "$slowBundleId",
    );
    await app.assertText(
      "retried Release runs",
      "runtime-release-state",
      "$slowReleaseId",
    );
    await app.assertText(
      "retried marker runs",
      "runtime-scenario-marker",
      "interrupted-slow-detox",
    );
    await app.assertText(
      "the retried bundle leaves no crash history",
      "crash-history-count",
      "0",
    );
  },
};
