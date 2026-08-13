import type { DetoxScenarioDefinition } from "./types.ts";

export const forwardReleaseRollbackOldBundleScenario: DetoxScenarioDefinition =
  {
    name: "forward-release-rollback-old-bundle",
    run: async (app) => {
      await app.control(
        "deploy rollback base",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          marker: "forward-rollback-base-detox",
          mode: "reset",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "rollbackBaseBundleId",
          saveResultFieldsAs: { releaseId: "rollbackBaseReleaseId" },
        },
      );
      await app.launch("launch rollback base");
      await app.tap(
        "install rollback base",
        "action-install-current-channel-update",
      );
      await app.control(
        "wait rollback base pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$rollbackBaseBundleId",
          verificationPending: true,
        },
      );
      await app.reload("reload rollback base");
      await app.control(
        "wait rollback base active",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$rollbackBaseBundleId",
          verificationPending: false,
        },
      );
      await app.control(
        "deploy rollback source",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          marker: "forward-rollback-source-detox",
          mode: "reset",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "rollbackSourceBundleId",
          saveResultFieldsAs: { releaseId: "rollbackSourceReleaseId" },
        },
      );
      await app.launch("launch rollback source");
      await app.tap(
        "install rollback source",
        "action-install-current-channel-update",
      );
      await app.control(
        "wait rollback source pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$rollbackSourceBundleId",
          verificationPending: true,
        },
      );
      await app.reload("reload rollback source");
      await app.control(
        "wait rollback source active",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$rollbackSourceBundleId",
          verificationPending: false,
        },
      );
      await app.control(
        "create forward rollback Release",
        "/e2e/jobs/create-rollback-release",
        {
          sourceReleaseId: "$rollbackSourceReleaseId",
          toBundleId: "$rollbackBaseBundleId",
        },
        { saveResultFieldsAs: { releaseId: "forwardRollbackReleaseId" } },
      );
      await app.tap(
        "apply forward rollback Release",
        "action-install-current-channel-update",
      );
      await app.assertText(
        "assert forward rollback action",
        "update-action-result",
        "current-channel -> installed Release $forwardRollbackReleaseId / Bundle $rollbackBaseBundleId",
        { exactText: true },
      );
      await app.control(
        "wait forward rollback pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$rollbackBaseBundleId",
          releaseId: "$forwardRollbackReleaseId",
          verificationPending: true,
        },
      );
      await app.reload("reload forward rollback");
      await app.assertText(
        "assert old Bundle active",
        "runtime-bundle-id",
        "$rollbackBaseBundleId",
      );
      await app.assertText(
        "assert forward Release active",
        "runtime-release-state",
        "$forwardRollbackReleaseId",
      );
    },
  };
