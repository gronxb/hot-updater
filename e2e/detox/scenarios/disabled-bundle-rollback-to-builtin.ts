import type { DetoxScenarioDefinition } from "./types.ts";

export const disabledBundleRollbackToBuiltinScenario: DetoxScenarioDefinition =
  {
    name: "disabled-bundle-rollback-to-builtin",
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
  };
