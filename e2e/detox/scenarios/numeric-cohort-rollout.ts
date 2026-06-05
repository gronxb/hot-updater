import type { DetoxScenarioDefinition } from "./types.ts";

export const numericCohortRolloutScenario: DetoxScenarioDefinition = {
  name: "numeric-cohort-rollout",
  run: async (scenario) => {
    await scenario.launch("launch built-in app");
    await scenario.control(
      "capture built-in bundle id",
      "/e2e/capture-built-in-bundle-id",
      {},
      {
        saveResultAs: "builtInBundleId",
      },
    );
    await scenario.control(
      "deploy numeric cohort bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "numeric-cohort-detox",
        mode: "reset",
        rollout: 10,
        safeBundleIds: ["$builtInBundleId"],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "bundleId",
      },
    );
    await scenario.control(
      "compute rollout sample",
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
    await scenario.typeText(
      "enter included cohort",
      "cohort-input",
      "$includedCohort",
    );
    await scenario.tap("apply included cohort", "action-apply-cohort-input");
    await scenario.assertText(
      "assert included cohort applied",
      "cohort-action-result",
      "set -> $includedCohort",
    );
    await scenario.tap(
      "install rollout update",
      "action-install-current-channel-update",
    );
    await scenario.control(
      "wait rollout metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleId",
        relaunchLimit: 0,
        verificationPending: true,
      },
    );
    await scenario.assertText(
      "assert rollout action result",
      "update-action-result",
      "current-channel",
    );
    await scenario.reload("reload rollout update");
    await scenario.control(
      "wait rollout metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleId",
        verificationPending: false,
      },
    );
    await scenario.assertText(
      "assert rollout launch",
      "runtime-bundle-id",
      "$bundleId",
    );
    await scenario.typeText(
      "enter excluded cohort",
      "cohort-input",
      "$excludedCohort",
    );
    await scenario.tap("apply excluded cohort", "action-apply-cohort-input");
    await scenario.assertText(
      "assert excluded cohort applied",
      "cohort-action-result",
      "set -> $excludedCohort",
    );
    await scenario.tap(
      "install excluded cohort update",
      "action-install-current-channel-update",
    );
    await scenario.control(
      "assert excluded metadata reset",
      "/e2e/assert-metadata-reset",
    );
    await scenario.reload("reload excluded cohort state");
    await scenario.assertText(
      "assert excluded cohort built-in bundle",
      "runtime-bundle-id",
      "$builtInBundleId",
    );
  },
};
