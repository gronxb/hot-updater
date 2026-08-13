import type { DetoxScenarioDefinition } from "./types.ts";

export const slowOldArtifactAfterNewerInstallScenario: DetoxScenarioDefinition =
  {
    name: "slow-old-artifact-after-newer-install",
    run: async (app) => {
      await app.control(
        "deploy old artifact Release",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          marker: "slow-old-artifact-detox",
          mode: "reset",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "oldArtifactBundleId",
          saveResultFieldsAs: { releaseId: "oldArtifactReleaseId" },
        },
      );
      await app.launch("launch old artifact app");
      await app.tap(
        "capture old artifact update",
        "action-capture-current-channel-update",
      );
      await app.assertText(
        "assert old update captured",
        "update-action-result",
        "captured-update -> Release $oldArtifactReleaseId",
        { exactText: true },
      );
      await app.control(
        "deploy newer artifact Release",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          marker: "slow-old-artifact-newer-detox",
          mode: "reset",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "newArtifactBundleId",
          saveResultFieldsAs: { releaseId: "newArtifactReleaseId" },
        },
      );
      await app.control("reset artifact race proxy", "/e2e/proxy-control", {
        reset: true,
      });
      await app.tap(
        "install newer artifact Release",
        "action-install-current-channel-update",
      );
      await app.control(
        "wait newer artifact pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$newArtifactBundleId",
          releaseId: "$newArtifactReleaseId",
          verificationPending: true,
        },
      );
      await app.control("delay old artifact completion", "/e2e/proxy-control", {
        artifactDelayMs: 750,
      });
      await app.tap(
        "apply captured old update",
        "action-apply-captured-update",
      );
      await app.assertText(
        "assert old artifact CAS rejected",
        "update-action-result",
        "captured-update -> skipped",
        { exactText: true },
      );
      await app.control(
        "assert newer artifact still pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$newArtifactBundleId",
          releaseId: "$newArtifactReleaseId",
          verificationPending: true,
        },
      );
      await app.control("assert artifact race transport", "/e2e/assert-proxy", {
        artifactRequests: 1,
        catalogRequests: 1,
      });
    },
  };
