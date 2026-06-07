import type { DetoxScenarioDefinition } from "./types.ts";

export const disabledBundleRollbackToBuiltinScenario: DetoxScenarioDefinition =
  {
    name: "disabled-bundle-rollback-to-builtin",
    run: async (app) => {
      await app.control(
        "capture built-in bundle",
        "/e2e/capture-built-in-bundle-id",
        {},
        {
          saveResultAs: "builtInBundleId",
        },
      );
      await app.control(
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
      await app.tap(
        "install current bundle",
        "action-install-current-channel-update",
        "$currentBundleId",
      );
      await app.control(
        "wait current bundle metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$currentBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
      );
      await app.reload("reload current bundle");
      await app.control(
        "wait current bundle metadata stable",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$currentBundleId",
          verificationPending: false,
        },
      );
      await app.control(
        "assert current bundle active",
        "/e2e/assert-metadata-active",
        {
          bundleId: "$currentBundleId",
        },
      );
      await app.control("disable current bundle", "/e2e/jobs/patch-bundle", {
        bundleId: "$currentBundleId",
        enabled: false,
      });
      await app.tap(
        "install rollback to built-in",
        "action-install-current-channel-update",
        "00000000-0000-0000-0000-000000000000",
      );
      await app.reload("reload to built-in");
      await app.control(
        "assert metadata reset",
        "/e2e/assert-metadata-reset",
        {},
      );
      await app.assertText(
        "assert no crashed bundle",
        "launch-crashed-bundle-result",
        "Current Crashed Bundle ID: null",
      );
    },
  };
