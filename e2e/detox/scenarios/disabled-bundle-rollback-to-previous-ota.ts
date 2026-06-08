import type { DetoxScenarioDefinition } from "./types.ts";

export const disabledBundleRollbackToPreviousOtaScenario: DetoxScenarioDefinition =
  {
    name: "disabled-bundle-rollback-to-previous-ota",
    run: async (app) => {
      await app.control(
        "capture built-in bundle",
        "/e2e/capture-built-in-bundle-id",
        {},
        {
          saveResultAs: "builtInBundleId",
        },
      );
      await app.launch("launch built-in previous rollback app");
      await app.assertText(
        "assert previous rollback built-in marker",
        "runtime-scenario-marker",
        "$initialMarker",
      );
      await app.control(
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
      await app.launch("launch previous bundle app");
      await app.tap(
        "install previous bundle",
        "action-install-current-channel-update",
      );
      await app.control(
        "wait previous bundle metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$previousBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
      );
      await app.reload("reload previous bundle");
      await app.control(
        "wait previous bundle metadata stable",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$previousBundleId",
          verificationPending: false,
        },
      );
      await app.assertText(
        "assert previous bundle marker",
        "runtime-scenario-marker",
        "previous-ota-detox",
      );
      await app.assertText(
        "assert previous bundle launch status",
        "launch-status-result",
        "Current Launch Status: STABLE",
      );
      await app.control(
        "assert previous bundle active",
        "/e2e/assert-metadata-active",
        {
          bundleId: "$previousBundleId",
        },
      );
      await app.control(
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
      await app.launch("launch next bundle app");
      await app.tap(
        "install next bundle",
        "action-install-current-channel-update",
      );
      await app.control(
        "wait next bundle metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$nextBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
      );
      await app.reload("reload next bundle");
      await app.control(
        "wait next bundle metadata stable",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$nextBundleId",
          verificationPending: false,
        },
      );
      await app.assertText(
        "assert next bundle marker",
        "runtime-scenario-marker",
        "disabled-next-detox",
      );
      await app.assertText(
        "assert next bundle launch status",
        "launch-status-result",
        "Current Launch Status: STABLE",
      );
      await app.control(
        "assert next bundle active",
        "/e2e/assert-metadata-active",
        {
          bundleId: "$nextBundleId",
        },
      );
      await app.control("disable next bundle", "/e2e/jobs/patch-bundle", {
        bundleId: "$nextBundleId",
        enabled: false,
      });
      await app.launch("launch rollback to previous app");
      await app.control(
        "wait previous rollback metadata stable",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$previousBundleId",
          verificationPending: false,
        },
      );
      await app.assertText(
        "assert previous ota rollback marker",
        "runtime-scenario-marker",
        "previous-ota-detox",
      );
      await app.assertText(
        "assert previous ota rollback launch status",
        "launch-status-result",
        "Current Launch Status: STABLE",
      );
      await app.assertText(
        "assert previous ota rollback crashed bundle",
        "launch-crashed-bundle-result",
        "Current Crashed Bundle ID: null",
      );
      await app.assertText(
        "assert previous ota rollback crash history empty",
        "crash-history-summary",
        "No crashed bundles recorded.",
      );
      await app.control(
        "capture previous ota rollback state",
        "/e2e/capture-state",
        {
          prefix: "rollback-to-previous",
        },
      );
      await app.control(
        "assert previous ota active",
        "/e2e/assert-metadata-active",
        {
          bundleId: "$previousBundleId",
        },
      );
    },
  };
