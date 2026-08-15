import type { DetoxScenarioDefinition } from "./types.ts";

export const republishedCrashedBundleSkippedScenario: DetoxScenarioDefinition =
  {
    name: "republished-crashed-bundle-skipped",
    run: async (app) => {
      await app.control(
        "capture republish built-in Bundle",
        "/e2e/capture-built-in-bundle-id",
        {},
        { saveResultAs: "republishBuiltInBundleId" },
      );
      await app.control(
        "deploy republish stable",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          marker: "republish-stable-detox",
          mode: "reset",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "republishStableBundleId",
          saveResultFieldsAs: { releaseId: "republishStableReleaseId" },
        },
      );
      await app.launch("launch republish stable");
      await app.tap(
        "install republish stable",
        "action-install-current-channel-update",
      );
      await app.control(
        "wait republish stable pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$republishStableBundleId",
          verificationPending: true,
        },
      );
      await app.reload("reload republish stable");
      await app.control(
        "wait republish stable active",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$republishStableBundleId",
          verificationPending: false,
        },
      );
      await app.control(
        "deploy republish crash",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          marker: "republish-crash-detox",
          mode: "crash",
          safeBundleIds: [
            "$republishBuiltInBundleId",
            "$republishStableBundleId",
          ],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "republishedCrashBundleId",
          saveResultFieldsAs: { releaseId: "republishedCrashReleaseId" },
        },
      );
      await app.launch("launch republish crash update");
      await app.tap(
        "install republish crash",
        "action-install-current-channel-update",
      );
      await app.control(
        "wait republish crash pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$republishedCrashBundleId",
          recoveredStableBundleId: "$republishStableBundleId",
          verificationPending: true,
        },
      );
      await app.launch("launch republished crash Bundle");
      await app.control(
        "wait republished crash recovery",
        "/e2e/wait-for-crash-recovery",
        {
          crashedBundleId: "$republishedCrashBundleId",
          stableBundleId: "$republishStableBundleId",
        },
      );
      await app.control(
        "republish crashed Bundle",
        "/e2e/jobs/create-rollback-release",
        {
          sourceReleaseId: "$republishedCrashReleaseId",
          toBundleId: "$republishedCrashBundleId",
        },
        { saveResultFieldsAs: { releaseId: "republishedReleaseId" } },
      );
      await app.control("guard republished artifact", "/e2e/proxy-control", {
        artifactFailures: 1,
      });
      await app.tap(
        "check republished crashed Bundle",
        "action-install-current-channel-update",
      );
      await app.assertText(
        "assert republished crash skipped",
        "update-action-result",
        "current-channel -> adopted Release $republishStableReleaseId / Bundle $republishStableBundleId",
        { exactText: true },
      );
      await app.assertText(
        "assert republish stable retained",
        "runtime-release-state",
        "$republishStableReleaseId",
      );
      await app.control(
        "assert republished crash remains recorded",
        "/e2e/assert-crash-history",
        { bundleId: "$republishedCrashBundleId" },
      );
      await app.control(
        "assert republished artifact skipped",
        "/e2e/assert-proxy",
        { artifactFailuresRemaining: 1 },
      );
    },
  };
