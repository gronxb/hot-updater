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
      await app.launch("launch built-in rollback app");
      await app.assertText(
        "assert rollback built-in marker",
        "runtime-scenario-marker",
        "$initialMarker",
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
      await app.launch("launch current bundle app");
      await app.tap(
        "install current bundle",
        "action-install-current-channel-update",
      );
      await app.assertText(
        "assert current bundle action result",
        "update-action-result",
        "current-channel -> installed $currentBundleId",
        { exactText: true },
      );
      await app.control(
        "wait current bundle metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$currentBundleId",
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
      await app.assertText(
        "assert current bundle marker",
        "runtime-scenario-marker",
        "disabled-current-detox",
      );
      await app.assertStableLaunch("assert current bundle launch status");
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
      );
      await app.assertText(
        "assert rollback to built-in action result",
        "update-action-result",
        "current-channel -> installed 00000000-0000-0000-0000-000000000000",
        { exactText: true },
      );
      await app.control(
        "assert rollback metadata reset",
        "/e2e/assert-metadata-reset",
      );
      await app.reload("reload rollback to built-in app");
      await app.assertText(
        "assert rollback built-in bundle",
        "runtime-bundle-id",
        "$builtInBundleId",
      );
      await app.assertText(
        "assert rollback built-in marker",
        "runtime-scenario-marker",
        "$initialMarker",
      );
      await app.assertStableLaunch("assert rollback launch status");
      await app.assertText(
        "assert no crashed bundle",
        "launch-crashed-bundle-result",
        "Current Crashed Bundle ID: null",
      );
      await app.assertText(
        "assert rollback crash history empty",
        "crash-history-count",
        "0",
      );
      await app.control(
        "capture rollback built-in state",
        "/e2e/capture-state",
        {
          prefix: "rollback-to-builtin",
        },
      );
      await app.control(
        "assert rollback metadata reset again",
        "/e2e/assert-metadata-reset",
      );
    },
  };
