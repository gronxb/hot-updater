import type { DetoxScenarioDefinition } from "./types.ts";

export const disabledBundleRollbackToPreviousOtaScenario: DetoxScenarioDefinition =
  {
    name: "disabled-bundle-rollback-to-previous-ota",
    run: async (app) => {
      await app.control(
        "deploy previous bundle",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          marker: "previous-ota-detox",
          mode: "reset",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "previousBundleId",
        },
      );
      await app.tap(
        "install previous bundle",
        "action-install-current-channel-update",
        "$previousBundleId",
      );
      await app.control(
        "wait previous bundle metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$previousBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
      );
      await app.reload("reload previous bundle");
      await app.control(
        "wait previous bundle metadata stable",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$previousBundleId",
          verificationPending: false,
        },
      );
      await app.control(
        "assert previous bundle active",
        "/e2e/assert-metadata-active",
        {
          bundleId: "$previousBundleId",
        },
      );
      await app.control(
        "deploy next bundle",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          marker: "disabled-next-detox",
          mode: "reset",
          safeBundleIds: ["$previousBundleId"],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "nextBundleId",
        },
      );
      await app.tap(
        "install next bundle",
        "action-install-current-channel-update",
        "$nextBundleId",
      );
      await app.control(
        "wait next bundle metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$nextBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
      );
      await app.reload("reload next bundle");
      await app.control(
        "wait next bundle metadata stable",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$nextBundleId",
          verificationPending: false,
        },
      );
      await app.control(
        "assert next bundle active",
        "/e2e/assert-metadata-active",
        {
          bundleId: "$nextBundleId",
        },
      );
      await app.control("disable next bundle", "/e2e/jobs/patch-bundle", {
        bundleId: "$nextBundleId",
        enabled: false,
      });
      await app.tap(
        "install rollback to previous bundle",
        "action-install-current-channel-update",
        "$previousBundleId",
      );
      await app.control(
        "wait previous rollback metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$previousBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
      );
      await app.reload("reload previous bundle");
      await app.control(
        "wait previous rollback metadata stable",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$previousBundleId",
          verificationPending: false,
        },
      );
      await app.control(
        "assert previous ota active",
        "/e2e/assert-metadata-active",
        {
          bundleId: "$previousBundleId",
        },
      );
    },
  };
