import type { DetoxScenarioDefinition } from "./types.ts";

export const targetedCohortSwitchbackScenario: DetoxScenarioDefinition = {
  name: "targeted-cohort-switchback",
  run: async (app) => {
    await app.control(
      "deploy numeric cohort bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "targeted-numeric-rollout-detox",
        mode: "reset",
        rollout: 10,
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "numericBundleId",
      },
    );
    await app.control(
      "compute numeric rollout sample",
      "/e2e/compute-rollout-sample",
      {
        bundleId: "$numericBundleId",
      },
      {
        saveResultFieldsAs: {
          includedCohort: "numericIncludedCohort",
          rolloutCohortCount: "numericRolloutCohortCount",
        },
      },
    );
    await app.control(
      "deploy qa cohort bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "targeted-qa-detox",
        mode: "reset",
        rollout: 0,
        safeBundleIds: ["$numericBundleId"],
        targetAppVersion: "1.0.x",
        targetCohorts: ["qa"],
      },
      {
        saveResultAs: "qaBundleId",
      },
    );
    await app.launch("launch targeted cohort app");
    await app.typeText(
      "enter numeric cohort",
      "cohort-input",
      "$numericIncludedCohort",
    );
    await app.tap("apply numeric cohort", "action-apply-cohort-input");
    await app.assertText(
      "assert numeric cohort applied",
      "cohort-action-result",
      "set -> $numericIncludedCohort",
    );
    await app.tap(
      "install numeric cohort update",
      "action-install-current-channel-update",
      "$numericBundleId",
    );
    await app.control(
      "wait numeric cohort metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$numericBundleId",
        relaunchLimit: 0,
        verificationPending: true,
      },
    );
    await app.reload("reload numeric cohort update");
    await app.control(
      "wait numeric cohort metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$numericBundleId",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert numeric cohort launch",
      "runtime-bundle-id",
      "$numericBundleId",
    );
    await app.typeText("enter qa cohort", "cohort-input", "qa");
    await app.tap("apply qa cohort", "action-apply-cohort-input");
    await app.tap(
      "install qa cohort update",
      "action-install-current-channel-update",
      "$qaBundleId",
    );
    await app.control(
      "wait qa cohort metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$qaBundleId",
        relaunchLimit: 0,
        verificationPending: true,
      },
    );
    await app.reload("reload qa cohort update");
    await app.control(
      "wait qa cohort metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$qaBundleId",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert qa cohort launch",
      "runtime-bundle-id",
      "$qaBundleId",
    );
    await app.typeText(
      "restore numeric cohort",
      "cohort-input",
      "$numericIncludedCohort",
    );
    await app.tap("apply restored numeric cohort", "action-apply-cohort-input");
    await app.assertText(
      "assert numeric cohort restored",
      "cohort-action-result",
      "set -> $numericIncludedCohort",
    );
    await app.tap(
      "install numeric cohort rollback",
      "action-install-current-channel-update",
      "$numericBundleId",
    );
    await app.control(
      "wait numeric cohort rollback pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$numericBundleId",
        relaunchLimit: 0,
        verificationPending: true,
      },
    );
    await app.reload("reload numeric cohort rollback");
    await app.control(
      "wait numeric cohort rollback stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$numericBundleId",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert numeric cohort rollback launch",
      "runtime-bundle-id",
      "$numericBundleId",
    );
  },
};
