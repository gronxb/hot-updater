import type { ScenarioDefinition } from "./types.ts";

export const failedDownloadSameGenerationRetryScenario: ScenarioDefinition = {
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
    // Keep the download unavailable until the SDK reports failure, regardless
    // of its internal retry policy. Preserve catalog evidence when restoring it.
    await app.control(
      "fail every attempt of the first download",
      "/e2e/proxy-control",
      {
        downloadAvailable: false,
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
    await app.control(
      "verify the first attempt reached an unavailable download",
      "/e2e/assert-proxy",
      { minFailedDownloads: 1 },
    );
    await app.control(
      "restore downloads without resetting catalog evidence",
      "/e2e/proxy-control",
      { downloadAvailable: true },
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
