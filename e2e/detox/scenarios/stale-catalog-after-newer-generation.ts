import type { DetoxScenarioDefinition } from "./types.ts";

export const staleCatalogAfterNewerGenerationScenario: DetoxScenarioDefinition =
  {
    name: "stale-catalog-after-newer-generation",
    run: async (app) => {
      await app.control(
        "deploy stale-catalog baseline",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          marker: "stale-catalog-baseline-detox",
          mode: "reset",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "staleBaselineBundleId",
          saveResultFieldsAs: {
            generation: "staleGeneration",
            releaseId: "staleBaselineReleaseId",
          },
        },
      );
      await app.launch("launch stale-catalog baseline");
      await app.tap(
        "install stale-catalog baseline",
        "action-install-current-channel-update",
      );
      await app.control(
        "wait stale-catalog baseline pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$staleBaselineBundleId",
          verificationPending: true,
        },
      );
      await app.reload("reload stale-catalog baseline");
      await app.control(
        "wait stale-catalog baseline active",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$staleBaselineBundleId",
          verificationPending: false,
        },
      );
      await app.control(
        "deploy newer catalog generation",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          marker: "stale-catalog-newer-detox",
          mode: "reset",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "newerBundleId",
          saveResultFieldsAs: { releaseId: "newerReleaseId" },
        },
      );
      await app.launch("launch newer catalog generation");
      await app.tap(
        "install newer catalog generation",
        "action-install-current-channel-update",
      );
      await app.control(
        "wait newer catalog pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$newerBundleId",
          releaseId: "$newerReleaseId",
          verificationPending: true,
        },
      );
      await app.reload("reload newer catalog generation");
      await app.control(
        "wait newer catalog active",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$newerBundleId",
          releaseId: "$newerReleaseId",
          verificationPending: false,
        },
      );
      await app.control("replay delayed stale catalog", "/e2e/proxy-control", {
        artifactFailures: 1,
        catalogDelayMs: 500,
        catalogMode: "replay",
        replayGeneration: "$staleGeneration",
      });
      await app.tap(
        "check delayed stale catalog",
        "action-install-current-channel-update",
      );
      await app.assertText(
        "assert stale catalog rejected",
        "update-action-result",
        "current-channel -> no-update",
        { exactText: true },
      );
      await app.assertText(
        "assert newer Bundle retained",
        "runtime-bundle-id",
        "$newerBundleId",
      );
      await app.assertText(
        "assert newer Release retained",
        "runtime-release-state",
        "$newerReleaseId",
      );
      await app.control(
        "assert stale catalog no artifact",
        "/e2e/assert-proxy",
        {
          artifactFailuresRemaining: 1,
        },
      );
    },
  };
