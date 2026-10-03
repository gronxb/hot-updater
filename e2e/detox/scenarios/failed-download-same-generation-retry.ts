import type { DetoxScenarioDefinition } from "./types.ts";

export const failedDownloadSameGenerationRetryScenario: DetoxScenarioDefinition =
  {
    name: "failed-download-same-generation-retry",
    run: async (app) => {
      await app.control(
        "deploy retry Release",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          marker: "same-generation-retry-detox",
          mode: "reset",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "retryBundleId",
          saveResultFieldsAs: { releaseId: "retryReleaseId" },
        },
      );
      await app.launch("launch retry app");
      // Native downloads try a 503 three times, so the first install fails
      // only when every attempt at its manifest fails.
      await app.control(
        "fail every attempt of the first download",
        "/e2e/proxy-control",
        {
          artifactFailures: 3,
          reset: true,
        },
      );
      await app.tap(
        "attempt failing download",
        "action-install-current-channel-update",
        { allowErrorResult: true },
      );
      await app.assertText(
        "assert first download failed",
        "update-action-result",
        "current-channel -> error",
      );
      await app.tap(
        "retry same generation download",
        "action-install-current-channel-update",
      );
      await app.assertText(
        "assert same generation retry installed",
        "update-action-result",
        "current-channel -> installed ID $retryReleaseId",
        { exactText: true },
      );
      await app.control(
        "wait retry metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$retryBundleId",
          releaseId: "$retryReleaseId",
          verificationPending: true,
        },
      );
      await app.control("assert retry transport", "/e2e/assert-proxy", {
        artifactFailuresRemaining: 0,
        artifactRequests: 2,
        catalogRequests: 2,
      });
    },
  };
