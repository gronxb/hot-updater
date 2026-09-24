import type { DetoxScenarioDefinition } from "./types.ts";

export const renderErrorRollbackScenario: DetoxScenarioDefinition = {
  name: "render-error-rollback",
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
      "deploy render-error stable bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "render-error-stable-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "stableBundleId",
      },
    );
    await app.launch("launch render-error stable installer");
    await app.tap(
      "install render-error stable",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert render-error stable installed",
      "update-action-result",
      "current-channel -> installed $stableBundleId",
      { exactText: true },
    );
    await app.control(
      "wait render-error stable installed",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$stableBundleId",
        verificationPending: true,
      },
    );
    await app.reload("load render-error stable");
    await app.control(
      "wait render-error stable promoted",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$stableBundleId",
        verificationPending: false,
      },
    );

    await app.control(
      "deploy render-error bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "render-error-detox",
        mode: "render-error",
        safeBundleIds: ["$builtInBundleId", "$stableBundleId"],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "renderErrorBundleId",
      },
    );
    await app.launch("refresh render-error update check");
    await app.tap(
      "install render-error bundle",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert render-error bundle installed",
      "update-action-result",
      "current-channel -> installed $renderErrorBundleId",
      { exactText: true },
    );
    await app.control(
      "wait render-error bundle installed",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$renderErrorBundleId",
        recoveredStableBundleId: "$stableBundleId",
        verificationPending: true,
      },
    );
    await app.terminate("stop stable process before render-error launch");
    // The error boundary reloads the app mid-launch. The driver tolerates a
    // launch that ends early only when the stage name contains "crash".
    await app.launch("launch render-error bundle until crash recovery reload");
    await app.control(
      "wait render-error recovery",
      "/e2e/wait-for-crash-recovery",
      {
        crashedBundleId: "$renderErrorBundleId",
        stableBundleId: "$stableBundleId",
      },
    );
    await app.control(
      "assert render-error recovery report",
      "/e2e/assert-launch-report",
      {
        crashedBundleId: "$renderErrorBundleId",
        stableBundleId: "$stableBundleId",
        status: "RECOVERED",
      },
    );
    await app.control(
      "assert render-error bundle recorded",
      "/e2e/assert-crash-history",
      {
        bundleId: "$renderErrorBundleId",
      },
    );
    await app.control("capture render-error recovery", "/e2e/capture-state", {
      prefix: "render-error-recovered",
    });

    await app.terminate("stop recovered process");
    await app.launch("cold start once more after render-error recovery");
    await app.assertText(
      "stable marker survives another cold start",
      "runtime-scenario-marker",
      "render-error-stable-detox",
    );
    await app.assertText(
      "stable bundle survives another cold start",
      "runtime-bundle-id",
      "$stableBundleId",
    );
    await app.control(
      "assert stable metadata after another cold start",
      "/e2e/assert-metadata-active",
      {
        bundleId: "$stableBundleId",
      },
    );
  },
};
