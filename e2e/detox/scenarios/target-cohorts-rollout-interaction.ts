import type { DetoxScenarioDefinition } from "./types.ts";

export const targetCohortsRolloutInteractionScenario: DetoxScenarioDefinition =
  {
    name: "target-cohorts-rollout-interaction",
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
        "deploy cohort rollout bundle",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          marker: "cohort-rollout-detox",
          mode: "reset",
          rollout: 0,
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
          targetCohorts: ["qa"],
        },
        {
          saveResultAs: "bundleId",
        },
      );
      await app.control(
        "expand cohort rollout bundle",
        "/e2e/jobs/patch-bundle",
        {
          bundleId: "$bundleId",
          rolloutCohortCount: 500,
          targetCohorts: ["qa"],
        },
      );
      await app.control(
        "compute cohort rollout sample",
        "/e2e/compute-rollout-sample",
        {
          bundleId: "$bundleId",
        },
        {
          saveResultFieldsAs: {
            excludedCohort: "excludedCohort",
            includedCohort: "includedCohort",
          },
        },
      );

      await app.launch("launch cohort rollout app");
      await app.typeText(
        "enter excluded cohort",
        "cohort-input",
        "$excludedCohort",
      );
      await app.tap("apply excluded cohort", "action-apply-cohort-input");
      await app.assertText(
        "assert excluded cohort applied",
        "cohort-action-result",
        "set -> $excludedCohort",
      );
      await app.tap(
        "install excluded cohort update",
        "action-install-current-channel-update",
      );
      await app.assertText(
        "assert excluded cohort no update",
        "update-action-result",
        "current-channel -> no-update",
      );
      await app.control(
        "assert excluded metadata reset",
        "/e2e/assert-metadata-reset",
      );
      await app.reload("reload excluded cohort state");
      await app.assertText(
        "assert excluded cohort built-in bundle",
        "runtime-bundle-id",
        "$builtInBundleId",
      );

      await app.typeText(
        "enter included cohort",
        "cohort-input",
        "$includedCohort",
      );
      await app.tap("apply included cohort", "action-apply-cohort-input");
      await app.assertText(
        "assert included cohort applied",
        "cohort-action-result",
        "set -> $includedCohort",
      );
      await app.tap(
        "install included cohort update",
        "action-install-current-channel-update",
      );
      await app.assertText(
        "assert included cohort action result",
        "update-action-result",
        "current-channel -> installed $bundleId",
      );
      await app.control(
        "wait included cohort metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$bundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
      );
      await app.reload("reload included cohort update");
      await app.control(
        "wait included cohort metadata stable",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$bundleId",
          verificationPending: false,
        },
      );
      await app.assertText(
        "assert included cohort bundle",
        "runtime-bundle-id",
        "$bundleId",
      );

      await app.typeText(
        "restore excluded cohort",
        "cohort-input",
        "$excludedCohort",
      );
      await app.tap(
        "apply restored excluded cohort",
        "action-apply-cohort-input",
      );
      await app.assertText(
        "assert restored excluded cohort applied",
        "cohort-action-result",
        "set -> $excludedCohort",
      );
      await app.tap(
        "install restored excluded cohort update",
        "action-install-current-channel-update",
      );
      await app.assertText(
        "assert restored excluded cohort no update",
        "update-action-result",
        "current-channel -> no-update",
      );
      await app.control(
        "assert restored excluded metadata reset",
        "/e2e/assert-metadata-reset",
      );
      await app.reload("reload restored excluded cohort state");
      await app.assertText(
        "assert restored excluded built-in bundle",
        "runtime-bundle-id",
        "$builtInBundleId",
      );

      await app.tap("apply qa cohort", "action-set-cohort-qa");
      await app.assertText(
        "assert qa cohort applied",
        "cohort-action-result",
        "set -> qa",
      );
      await app.tap(
        "install qa cohort update",
        "action-install-current-channel-update",
      );
      await app.assertText(
        "assert qa cohort action result",
        "update-action-result",
        "current-channel -> installed $bundleId",
      );
      await app.control(
        "wait qa cohort metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$bundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
      );
      await app.reload("reload qa cohort update");
      await app.control(
        "wait qa cohort metadata stable",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$bundleId",
          verificationPending: false,
        },
      );
      await app.assertText(
        "assert qa cohort bundle",
        "runtime-bundle-id",
        "$bundleId",
      );
      await app.control(
        "assert qa cohort active",
        "/e2e/assert-metadata-active",
        {
          bundleId: "$bundleId",
        },
      );
    },
  };
