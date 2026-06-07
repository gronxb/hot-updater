import type { DetoxScenarioDefinition } from "./types.ts";

export const numericCohortRolloutScenario: DetoxScenarioDefinition = {
  name: "numeric-cohort-rollout",
  run: async (app) => {
    await app.launch("launch built-in app");
    await app.control(
      "capture built-in bundle id",
      "/e2e/capture-built-in-bundle-id",
      {},
      {
        saveResultAs: "builtInBundleId",
      },
    );
    await app.control(
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
    await app.control(
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
      "install rollout update",
      "action-install-current-channel-update",
      "$bundleId",
    );
    await app.control(
      "wait rollout metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleId",
        relaunchLimit: 0,
        verificationPending: true,
      },
    );
    await app.assertText(
      "assert rollout action result",
      "update-action-result",
      "current-channel",
    );
    await app.reload("reload rollout update");
    await app.control(
      "wait rollout metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleId",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert rollout launch",
      "runtime-bundle-id",
      "$bundleId",
    );
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
      "no-update",
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
  },
};
