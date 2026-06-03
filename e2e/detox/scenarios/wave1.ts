import type { DetoxScenarioDefinition } from "./types.ts";

export const wave1Scenarios: readonly DetoxScenarioDefinition[] = [
  {
    name: "release-ota-recovery",
    wave: 1,
    steps: [
      { action: "launch", kind: "device", stage: "launch built-in app" },
      {
        kind: "control",
        pathName: "/e2e/capture-built-in-bundle-id",
        saveResultAs: "builtInBundleId",
        stage: "capture built-in bundle id",
      },
      {
        body: {
          channel: "production",
          marker: "stable-detox-recovery",
          message: "Detox recovery stable bundle",
          mode: "reset",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        kind: "control",
        pathName: "/e2e/jobs/deploy-bundle",
        saveResultAs: "stableBundleId",
        stage: "deploy stable bundle",
      },
      { action: "launch", kind: "device", stage: "launch stable update app" },
      {
        expectResultContains: "$stableBundleId",
        kind: "tap",
        stage: "install stable update",
        testID: "action-install-current-channel-update",
      },
      {
        body: { bundleId: "$stableBundleId", verificationPending: true },
        kind: "control",
        pathName: "/e2e/jobs/wait-for-metadata",
        stage: "wait stable metadata pending",
      },
      { action: "reload", kind: "device", stage: "reload stable bundle" },
      {
        body: { bundleId: "$stableBundleId", verificationPending: false },
        kind: "control",
        pathName: "/e2e/jobs/wait-for-metadata",
        stage: "wait stable metadata active",
      },
      {
        contains: "Current Launch Status: STABLE",
        kind: "assertText",
        stage: "assert stable launch",
        testID: "launch-status-result",
      },
      {
        body: {
          channel: "production",
          marker: "crash-detox-recovery",
          message: "Detox recovery crash bundle",
          mode: "crash",
          safeBundleIds: ["$builtInBundleId", "$stableBundleId"],
          targetAppVersion: "1.0.x",
        },
        kind: "control",
        pathName: "/e2e/jobs/deploy-bundle",
        saveResultAs: "crashBundleId",
        stage: "deploy crash bundle",
      },
      { action: "launch", kind: "device", stage: "launch crash update app" },
      {
        expectResultContains: "$crashBundleId",
        kind: "tap",
        stage: "install crash update",
        testID: "action-install-current-channel-update",
      },
      {
        body: {
          bundleId: "$crashBundleId",
          recoveredStableBundleId: "$stableBundleId",
          verificationPending: true,
        },
        kind: "control",
        pathName: "/e2e/jobs/wait-for-metadata",
        stage: "wait crash metadata pending",
      },
      { action: "launch", kind: "device", stage: "launch crash bundle" },
      {
        body: {
          crashedBundleId: "$crashBundleId",
          stableBundleId: "$stableBundleId",
        },
        kind: "control",
        pathName: "/e2e/wait-for-crash-recovery",
        stage: "wait crash recovery",
      },
      {
        contains: "Current Launch Status: RECOVERED",
        kind: "assertText",
        stage: "assert recovered launch",
        testID: "launch-status-result",
      },
    ],
  },
];
