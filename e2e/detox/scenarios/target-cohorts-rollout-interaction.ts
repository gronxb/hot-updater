import type { DetoxScenarioDefinition } from "./types.ts";

export const targetCohortsRolloutInteractionScenario: DetoxScenarioDefinition =
  {
    name: "target-cohorts-rollout-interaction",
    run: async (app) => {
      await app.control(
        "deploy cohort rollout bundle",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          marker: "cohort-rollout-detox",
          mode: "reset",
          rollout: 50,
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
          targetCohorts: ["qa"],
        },
        {
          saveResultAs: "bundleId",
        },
      );
      await app.typeText("enter qa cohort", "cohort-input", "qa");
      await app.tap("apply qa cohort", "action-apply-cohort-input");
      await app.tap(
        "install cohort rollout update",
        "action-install-current-channel-update",
        "$bundleId",
      );
      await app.control(
        "wait cohort rollout metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$bundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
      );
      await app.reload("reload cohort rollout update");
      await app.control(
        "wait cohort rollout metadata stable",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$bundleId",
          verificationPending: false,
        },
      );
      await app.control(
        "assert cohort rollout active",
        "/e2e/assert-metadata-active",
        {
          bundleId: "$bundleId",
        },
      );
    },
  };
