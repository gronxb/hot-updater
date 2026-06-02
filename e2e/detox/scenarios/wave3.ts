import type { DetoxScenarioDefinition } from "./types.ts";

export const wave3Scenarios: readonly DetoxScenarioDefinition[] = [
  {
    name: "runtime-channel-switch-reset",
    wave: 3,
    steps: [
      { action: "launch", kind: "device", stage: "launch default channel" },
      {
        kind: "typeText",
        stage: "enter runtime channel",
        testID: "runtime-channel-input",
        text: "qa-runtime",
      },
      {
        kind: "tap",
        stage: "install runtime channel update",
        testID: "action-install-runtime-channel-update",
      },
      {
        contains: "runtime-channel:qa-runtime",
        kind: "assertText",
        stage: "assert runtime channel result",
        testID: "update-action-result",
      },
      {
        kind: "tap",
        stage: "reset runtime channel",
        testID: "action-reset-runtime-channel",
      },
      {
        contains: "runtime-channel -> reset",
        kind: "assertText",
        stage: "assert runtime channel reset",
        testID: "channel-action-result",
      },
    ],
  },
  {
    name: "numeric-cohort-rollout",
    wave: 3,
    steps: [
      {
        body: {
          channel: "production",
          marker: "numeric-cohort-detox",
          mode: "reset",
          rollout: 50,
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        kind: "control",
        pathName: "/e2e/jobs/deploy-bundle",
        saveResultAs: "bundleId",
        stage: "deploy numeric cohort bundle",
      },
      {
        body: { bundleId: "$bundleId" },
        kind: "control",
        pathName: "/e2e/compute-rollout-sample",
        saveResultAs: "rolloutSample",
        stage: "compute rollout sample",
      },
      {
        kind: "tap",
        stage: "install rollout update",
        testID: "action-install-current-channel-update",
      },
      {
        contains: "current-channel",
        kind: "assertText",
        stage: "assert rollout action result",
        testID: "update-action-result",
      },
    ],
  },
  {
    name: "target-cohorts-only",
    wave: 3,
    steps: [
      {
        body: {
          channel: "production",
          marker: "target-cohorts-only-detox",
          mode: "reset",
          rollout: 0,
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
          targetCohorts: ["qa"],
        },
        kind: "control",
        pathName: "/e2e/jobs/deploy-bundle",
        saveResultAs: "bundleId",
        stage: "deploy target cohort bundle",
      },
      {
        kind: "typeText",
        stage: "enter qa cohort",
        testID: "cohort-input",
        text: "qa",
      },
      {
        kind: "tap",
        stage: "apply qa cohort",
        testID: "action-apply-cohort-input",
      },
      {
        contains: "set -> qa",
        kind: "assertText",
        stage: "assert qa cohort applied",
        testID: "cohort-action-result",
      },
      {
        kind: "tap",
        stage: "install target cohort update",
        testID: "action-install-current-channel-update",
      },
      {
        body: {
          bundleId: "$bundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
        kind: "control",
        pathName: "/e2e/jobs/wait-for-metadata",
        stage: "wait target cohort metadata pending",
      },
      {
        contains: "current-channel -> installed $bundleId (UPDATE)",
        kind: "assertText",
        stage: "assert target cohort install result",
        testID: "update-action-result",
      },
      {
        action: "reload",
        kind: "device",
        stage: "reload target cohort update",
      },
      {
        body: { bundleId: "$bundleId", verificationPending: false },
        kind: "control",
        pathName: "/e2e/jobs/wait-for-metadata",
        stage: "wait target cohort metadata stable",
      },
      {
        contains: "Current Launch Status: STABLE",
        kind: "assertText",
        stage: "assert target cohort launch",
        testID: "launch-status-result",
      },
    ],
  },
  {
    name: "target-cohorts-rollout-interaction",
    wave: 3,
    steps: [
      {
        body: {
          channel: "production",
          marker: "cohort-rollout-detox",
          mode: "reset",
          rollout: 50,
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
          targetCohorts: ["qa"],
        },
        kind: "control",
        pathName: "/e2e/jobs/deploy-bundle",
        saveResultAs: "bundleId",
        stage: "deploy cohort rollout bundle",
      },
      {
        kind: "typeText",
        stage: "enter qa cohort",
        testID: "cohort-input",
        text: "qa",
      },
      {
        kind: "tap",
        stage: "apply qa cohort",
        testID: "action-apply-cohort-input",
      },
      {
        kind: "tap",
        stage: "install cohort rollout update",
        testID: "action-install-current-channel-update",
      },
      {
        body: { bundleId: "$bundleId" },
        kind: "control",
        pathName: "/e2e/assert-metadata-active",
        stage: "assert cohort rollout active",
      },
    ],
  },
  {
    name: "targeted-cohort-switchback",
    wave: 3,
    steps: [
      {
        kind: "typeText",
        stage: "enter qa cohort",
        testID: "cohort-input",
        text: "qa",
      },
      {
        kind: "tap",
        stage: "apply qa cohort",
        testID: "action-apply-cohort-input",
      },
      {
        kind: "tap",
        stage: "restore initial cohort",
        testID: "action-restore-initial-cohort",
      },
      {
        contains: "restore-initial",
        kind: "assertText",
        stage: "assert cohort switchback",
        testID: "cohort-action-result",
      },
    ],
  },
];
