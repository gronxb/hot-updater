import type { DetoxScenarioDefinition } from "./types.ts";

export const wave3Scenarios: readonly DetoxScenarioDefinition[] = [
  {
    name: "runtime-channel-switch-reset",
    wave: 3,
    run: async (scenario) => {
      await scenario.launch("launch default channel");
      await scenario.control(
        "capture built-in bundle id",
        "/e2e/capture-built-in-bundle-id",
        {},
        {
          saveResultAs: "builtInBundleId",
        },
      );
      await scenario.control(
        "deploy runtime channel bundle",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "beta",
          marker: "runtime-channel-beta-detox",
          message: "Detox runtime channel bundle",
          mode: "reset",
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "runtimeBundleId",
        },
      );
      await scenario.tap(
        "install runtime channel update",
        "action-install-runtime-channel-update",
      );
      await scenario.control(
        "wait runtime channel metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$runtimeBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
      );
      await scenario.assertText(
        "assert runtime channel result",
        "channel-action-result",
        "runtime-channel -> beta",
      );
      await scenario.reload("reload runtime channel update");
      await scenario.assertText(
        "assert runtime channel bundle",
        "runtime-bundle-id",
        "$runtimeBundleId",
      );
      await scenario.tap(
        "reset runtime channel",
        "action-reset-runtime-channel",
      );
      await scenario.assertText(
        "assert runtime channel reset",
        "channel-action-result",
        "reset -> true",
      );
      await scenario.reload("reload default channel");
      await scenario.assertText(
        "assert reset built-in bundle",
        "runtime-bundle-id",
        "$builtInBundleId",
      );
    },
  },
  {
    name: "numeric-cohort-rollout",
    wave: 3,
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
  },
  {
    name: "target-cohorts-only",
    wave: 3,
    run: async (scenario) => {
      await scenario.control(
        "deploy target cohort bundle",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          marker: "target-cohorts-only-detox",
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
      await scenario.typeText("enter qa cohort", "cohort-input", "qa");
      await scenario.tap("apply qa cohort", "action-apply-cohort-input");
      await scenario.assertText(
        "assert qa cohort applied",
        "cohort-action-result",
        "set -> qa",
      );
      await scenario.tap(
        "install target cohort update",
        "action-install-current-channel-update",
      );
      await scenario.control(
        "wait target cohort metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$bundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
      );
      await scenario.reload("reload target cohort update");
      await scenario.control(
        "wait target cohort metadata stable",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$bundleId",
          verificationPending: false,
        },
      );
      await scenario.assertText(
        "assert target cohort launch",
        "launch-status-result",
        "Current Launch Status: STABLE",
      );
    },
  },
  {
    name: "target-cohorts-rollout-interaction",
    wave: 3,
    run: async (scenario) => {
      await scenario.control(
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
      await scenario.typeText("enter qa cohort", "cohort-input", "qa");
      await scenario.tap("apply qa cohort", "action-apply-cohort-input");
      await scenario.tap(
        "install cohort rollout update",
        "action-install-current-channel-update",
      );
      await scenario.control(
        "wait cohort rollout metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$bundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
      );
      await scenario.reload("reload cohort rollout update");
      await scenario.control(
        "wait cohort rollout metadata stable",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$bundleId",
          verificationPending: false,
        },
      );
      await scenario.control(
        "assert cohort rollout active",
        "/e2e/assert-metadata-active",
        {
          bundleId: "$bundleId",
        },
      );
    },
  },
  {
    name: "targeted-cohort-switchback",
    wave: 3,
    run: async (scenario) => {
      await scenario.control(
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
      await scenario.control(
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
      await scenario.control(
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
      await scenario.typeText(
        "enter numeric cohort",
        "cohort-input",
        "$numericIncludedCohort",
      );
      await scenario.tap("apply numeric cohort", "action-apply-cohort-input");
      await scenario.assertText(
        "assert numeric cohort applied",
        "cohort-action-result",
        "set -> $numericIncludedCohort",
      );
      await scenario.tap(
        "install numeric cohort update",
        "action-install-current-channel-update",
      );
      await scenario.control(
        "wait numeric cohort metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$numericBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
      );
      await scenario.reload("reload numeric cohort update");
      await scenario.control(
        "wait numeric cohort metadata stable",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$numericBundleId",
          verificationPending: false,
        },
      );
      await scenario.assertText(
        "assert numeric cohort launch",
        "runtime-bundle-id",
        "$numericBundleId",
      );
      await scenario.typeText("enter qa cohort", "cohort-input", "qa");
      await scenario.tap("apply qa cohort", "action-apply-cohort-input");
      await scenario.tap(
        "install qa cohort update",
        "action-install-current-channel-update",
      );
      await scenario.control(
        "wait qa cohort metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$qaBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
      );
      await scenario.reload("reload qa cohort update");
      await scenario.control(
        "wait qa cohort metadata stable",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$qaBundleId",
          verificationPending: false,
        },
      );
      await scenario.assertText(
        "assert qa cohort launch",
        "runtime-bundle-id",
        "$qaBundleId",
      );
      await scenario.typeText(
        "restore numeric cohort",
        "cohort-input",
        "$numericIncludedCohort",
      );
      await scenario.tap(
        "apply restored numeric cohort",
        "action-apply-cohort-input",
      );
      await scenario.assertText(
        "assert numeric cohort restored",
        "cohort-action-result",
        "set -> $numericIncludedCohort",
      );
      await scenario.tap(
        "install numeric cohort rollback",
        "action-install-current-channel-update",
      );
      await scenario.control(
        "wait numeric cohort rollback pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$numericBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
      );
      await scenario.reload("reload numeric cohort rollback");
      await scenario.control(
        "wait numeric cohort rollback stable",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$numericBundleId",
          verificationPending: false,
        },
      );
      await scenario.assertText(
        "assert numeric cohort rollback launch",
        "runtime-bundle-id",
        "$numericBundleId",
      );
    },
  },
];
