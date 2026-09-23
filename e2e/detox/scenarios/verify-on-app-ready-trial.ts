import type { DetoxScenarioDefinition } from "./types.ts";

export const verifyOnAppReadyTrialScenario: DetoxScenarioDefinition = {
  name: "verify-on-app-ready-trial",
  run: async (app) => {
    await app.control(
      "capture built-in bundle id",
      "/e2e/capture-built-in-bundle-id",
      {},
      {
        saveResultAs: "builtInBundleId",
      },
    );
    await app.control(
      "deploy skip-init stable bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "skip-init-stable-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "stableBundleId",
      },
    );
    await app.launch("launch skip-init stable installer");
    await app.tap(
      "install skip-init stable",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert skip-init stable installed",
      "update-action-result",
      "current-channel -> installed $stableBundleId",
      { exactText: true },
    );
    await app.control(
      "wait skip-init stable installed",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$stableBundleId",
        verificationPending: true,
      },
    );
    await app.reload("load skip-init stable");
    await app.control(
      "wait skip-init stable promoted",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$stableBundleId",
        verificationPending: false,
      },
    );

    // This bundle renders normally but never calls HotUpdater.init(), so
    // notifyAppReady() never runs. Without verifyOnAppReady, its first content
    // would promote it.
    await app.control(
      "deploy skip-init bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "skip-init-detox",
        mode: "skip-init",
        safeBundleIds: ["$builtInBundleId", "$stableBundleId"],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "skipInitBundleId",
      },
    );
    await app.launch("refresh skip-init update check");
    await app.tap(
      "install skip-init bundle",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert skip-init bundle installed",
      "update-action-result",
      "current-channel -> installed $skipInitBundleId",
      { exactText: true },
    );
    await app.control(
      "wait skip-init bundle installed",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$skipInitBundleId",
        verificationPending: true,
      },
    );
    await app.reload("load skip-init bundle");
    await app.assertText(
      "skip-init bundle renders its first screen",
      "runtime-scenario-marker",
      "skip-init-detox",
    );
    await app.control(
      "first content leaves the bundle on trial",
      "/e2e/assert-metadata-on-trial",
      {
        bundleId: "$skipInitBundleId",
      },
    );
    await app.control("capture skip-init trial", "/e2e/capture-state", {
      prefix: "skip-init-trial",
    });

    await app.terminate("stop the process before notifyAppReady");
    await app.launch("cold start the bundle still on trial");
    await app.assertText(
      "bundle on trial launches again",
      "runtime-scenario-marker",
      "skip-init-detox",
    );
    await app.assertText(
      "bundle on trial is not in crash history",
      "crash-history-count",
      "0",
    );
    await app.control(
      "bundle stays on trial after a cold start",
      "/e2e/assert-metadata-on-trial",
      {
        bundleId: "$skipInitBundleId",
      },
    );
  },
};
