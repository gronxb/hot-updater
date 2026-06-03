import type { DetoxScenarioDefinition } from "./types.ts";

export const wave4Scenarios: readonly DetoxScenarioDefinition[] = [
  {
    name: "force-update-auto-reload",
    wave: 4,
    steps: [
      {
        body: {
          channel: "production",
          forceUpdate: true,
          marker: "force-update-detox",
          mode: "reset",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        kind: "control",
        pathName: "/e2e/jobs/deploy-bundle",
        saveResultAs: "forceBundleId",
        stage: "deploy force update bundle",
      },
      {
        kind: "tap",
        stage: "install force update",
        testID: "action-install-current-channel-update",
      },
      {
        body: {
          bundleId: "$forceBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
        kind: "control",
        pathName: "/e2e/jobs/wait-for-metadata",
        stage: "wait force update metadata pending",
      },
      { action: "reload", kind: "device", stage: "reload force update" },
      {
        body: { bundleId: "$forceBundleId", verificationPending: false },
        kind: "control",
        pathName: "/e2e/jobs/wait-for-metadata",
        stage: "wait force update metadata stable",
      },
      {
        contains: "Current Launch Status: STABLE",
        kind: "assertText",
        stage: "assert force update launch",
        testID: "launch-status-result",
      },
    ],
  },
  {
    name: "disabled-bundle-rollback-to-builtin",
    wave: 4,
    steps: [
      {
        kind: "control",
        pathName: "/e2e/capture-built-in-bundle-id",
        saveResultAs: "builtInBundleId",
        stage: "capture built-in bundle",
      },
      {
        body: {
          channel: "production",
          marker: "disabled-current-detox",
          mode: "reset",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        kind: "control",
        pathName: "/e2e/jobs/deploy-bundle",
        saveResultAs: "currentBundleId",
        stage: "deploy current bundle",
      },
      {
        kind: "tap",
        stage: "install current bundle",
        testID: "action-install-current-channel-update",
      },
      {
        body: {
          bundleId: "$currentBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
        kind: "control",
        pathName: "/e2e/jobs/wait-for-metadata",
        stage: "wait current bundle metadata pending",
      },
      {
        action: "reload",
        kind: "device",
        stage: "reload current bundle",
      },
      {
        body: { bundleId: "$currentBundleId", verificationPending: false },
        kind: "control",
        pathName: "/e2e/jobs/wait-for-metadata",
        stage: "wait current bundle metadata stable",
      },
      {
        body: { bundleId: "$currentBundleId" },
        kind: "control",
        pathName: "/e2e/assert-metadata-active",
        stage: "assert current bundle active",
      },
      {
        body: { bundleId: "$currentBundleId", enabled: false },
        kind: "control",
        pathName: "/e2e/jobs/patch-bundle",
        stage: "disable current bundle",
      },
      {
        kind: "tap",
        stage: "install rollback to built-in",
        testID: "action-install-current-channel-update",
      },
      { action: "reload", kind: "device", stage: "reload to built-in" },
      {
        body: {},
        kind: "control",
        pathName: "/e2e/assert-metadata-reset",
        stage: "assert metadata reset",
      },
      {
        contains: "Current Crashed Bundle ID: null",
        kind: "assertText",
        stage: "assert no crashed bundle",
        testID: "launch-crashed-bundle-result",
      },
    ],
  },
  {
    name: "disabled-bundle-rollback-to-previous-ota",
    wave: 4,
    steps: [
      {
        body: {
          channel: "production",
          marker: "previous-ota-detox",
          mode: "reset",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        kind: "control",
        pathName: "/e2e/jobs/deploy-bundle",
        saveResultAs: "previousBundleId",
        stage: "deploy previous bundle",
      },
      {
        kind: "tap",
        stage: "install previous bundle",
        testID: "action-install-current-channel-update",
      },
      {
        body: {
          bundleId: "$previousBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
        kind: "control",
        pathName: "/e2e/jobs/wait-for-metadata",
        stage: "wait previous bundle metadata pending",
      },
      {
        action: "reload",
        kind: "device",
        stage: "reload previous bundle",
      },
      {
        body: { bundleId: "$previousBundleId", verificationPending: false },
        kind: "control",
        pathName: "/e2e/jobs/wait-for-metadata",
        stage: "wait previous bundle metadata stable",
      },
      {
        body: { bundleId: "$previousBundleId" },
        kind: "control",
        pathName: "/e2e/assert-metadata-active",
        stage: "assert previous bundle active",
      },
      {
        body: {
          channel: "production",
          marker: "disabled-next-detox",
          mode: "reset",
          safeBundleIds: ["$previousBundleId"],
          targetAppVersion: "1.0.x",
        },
        kind: "control",
        pathName: "/e2e/jobs/deploy-bundle",
        saveResultAs: "nextBundleId",
        stage: "deploy next bundle",
      },
      {
        kind: "tap",
        stage: "install next bundle",
        testID: "action-install-current-channel-update",
      },
      {
        body: {
          bundleId: "$nextBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
        kind: "control",
        pathName: "/e2e/jobs/wait-for-metadata",
        stage: "wait next bundle metadata pending",
      },
      {
        action: "reload",
        kind: "device",
        stage: "reload next bundle",
      },
      {
        body: { bundleId: "$nextBundleId", verificationPending: false },
        kind: "control",
        pathName: "/e2e/jobs/wait-for-metadata",
        stage: "wait next bundle metadata stable",
      },
      {
        body: { bundleId: "$nextBundleId" },
        kind: "control",
        pathName: "/e2e/assert-metadata-active",
        stage: "assert next bundle active",
      },
      {
        body: { bundleId: "$nextBundleId", enabled: false },
        kind: "control",
        pathName: "/e2e/jobs/patch-bundle",
        stage: "disable next bundle",
      },
      {
        kind: "tap",
        stage: "install rollback to previous bundle",
        testID: "action-install-current-channel-update",
      },
      {
        body: {
          bundleId: "$previousBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
        kind: "control",
        pathName: "/e2e/jobs/wait-for-metadata",
        stage: "wait previous rollback metadata pending",
      },
      { action: "reload", kind: "device", stage: "reload previous bundle" },
      {
        body: { bundleId: "$previousBundleId", verificationPending: false },
        kind: "control",
        pathName: "/e2e/jobs/wait-for-metadata",
        stage: "wait previous rollback metadata stable",
      },
      {
        body: { bundleId: "$previousBundleId" },
        kind: "control",
        pathName: "/e2e/assert-metadata-active",
        stage: "assert previous ota active",
      },
    ],
  },
];
