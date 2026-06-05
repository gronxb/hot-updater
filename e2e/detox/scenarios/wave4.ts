import type { DetoxScenarioDefinition } from "./types.ts";

export const wave4Scenarios: readonly DetoxScenarioDefinition[] = [
  {
    name: "force-update-auto-reload",
    wave: 4,
    run: async (scenario) => {
      await scenario.control(
        "deploy force update bundle",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          forceUpdate: true,
          marker: "force-update-detox",
          mode: "reset",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "forceBundleId",
        },
      );
      await scenario.tap(
        "install force update",
        "action-install-current-channel-update",
      );
      await scenario.control(
        "wait force update metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$forceBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
      );
      await scenario.reload("reload force update");
      await scenario.control(
        "wait force update metadata stable",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$forceBundleId",
          verificationPending: false,
        },
      );
      await scenario.assertText(
        "assert force update launch",
        "launch-status-result",
        "Current Launch Status: STABLE",
      );
    },
  },
  {
    name: "disabled-bundle-rollback-to-builtin",
    wave: 4,
    run: async (scenario) => {
      await scenario.control(
        "capture built-in bundle",
        "/e2e/capture-built-in-bundle-id",
        {},
        {
          saveResultAs: "builtInBundleId",
        },
      );
      await scenario.control(
        "deploy current bundle",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          marker: "disabled-current-detox",
          mode: "reset",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "currentBundleId",
        },
      );
      await scenario.tap(
        "install current bundle",
        "action-install-current-channel-update",
      );
      await scenario.control(
        "wait current bundle metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$currentBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
      );
      await scenario.reload("reload current bundle");
      await scenario.control(
        "wait current bundle metadata stable",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$currentBundleId",
          verificationPending: false,
        },
      );
      await scenario.control(
        "assert current bundle active",
        "/e2e/assert-metadata-active",
        {
          bundleId: "$currentBundleId",
        },
      );
      await scenario.control(
        "disable current bundle",
        "/e2e/jobs/patch-bundle",
        {
          bundleId: "$currentBundleId",
          enabled: false,
        },
      );
      await scenario.tap(
        "install rollback to built-in",
        "action-install-current-channel-update",
      );
      await scenario.reload("reload to built-in");
      await scenario.control(
        "assert metadata reset",
        "/e2e/assert-metadata-reset",
        {},
      );
      await scenario.assertText(
        "assert no crashed bundle",
        "launch-crashed-bundle-result",
        "Current Crashed Bundle ID: null",
      );
    },
  },
  {
    name: "disabled-bundle-rollback-to-previous-ota",
    wave: 4,
    run: async (scenario) => {
      await scenario.control(
        "deploy previous bundle",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          marker: "previous-ota-detox",
          mode: "reset",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "previousBundleId",
        },
      );
      await scenario.tap(
        "install previous bundle",
        "action-install-current-channel-update",
      );
      await scenario.control(
        "wait previous bundle metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$previousBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
      );
      await scenario.reload("reload previous bundle");
      await scenario.control(
        "wait previous bundle metadata stable",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$previousBundleId",
          verificationPending: false,
        },
      );
      await scenario.control(
        "assert previous bundle active",
        "/e2e/assert-metadata-active",
        {
          bundleId: "$previousBundleId",
        },
      );
      await scenario.control(
        "deploy next bundle",
        "/e2e/jobs/deploy-bundle",
        {
          channel: "production",
          marker: "disabled-next-detox",
          mode: "reset",
          safeBundleIds: ["$previousBundleId"],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: "nextBundleId",
        },
      );
      await scenario.tap(
        "install next bundle",
        "action-install-current-channel-update",
      );
      await scenario.control(
        "wait next bundle metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$nextBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
      );
      await scenario.reload("reload next bundle");
      await scenario.control(
        "wait next bundle metadata stable",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$nextBundleId",
          verificationPending: false,
        },
      );
      await scenario.control(
        "assert next bundle active",
        "/e2e/assert-metadata-active",
        {
          bundleId: "$nextBundleId",
        },
      );
      await scenario.control("disable next bundle", "/e2e/jobs/patch-bundle", {
        bundleId: "$nextBundleId",
        enabled: false,
      });
      await scenario.tap(
        "install rollback to previous bundle",
        "action-install-current-channel-update",
      );
      await scenario.control(
        "wait previous rollback metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$previousBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
      );
      await scenario.reload("reload previous bundle");
      await scenario.control(
        "wait previous rollback metadata stable",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$previousBundleId",
          verificationPending: false,
        },
      );
      await scenario.control(
        "assert previous ota active",
        "/e2e/assert-metadata-active",
        {
          bundleId: "$previousBundleId",
        },
      );
    },
  },
];
