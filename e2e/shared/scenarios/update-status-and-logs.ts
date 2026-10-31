import type { ScenarioDefinition } from "./types.ts";

// The diagnostics screen must say what the app actually does. Each expected
// value comes from what the control server deployed and read from the app's
// native metadata, never from the API under test.
export const updateStatusAndLogsScenario: ScenarioDefinition = {
  name: "update-status-and-logs",
  run: async (app) => {
    await app.control(
      "capture the built-in Bundle",
      "/e2e/capture-built-in-bundle-id",
      {},
      { saveResultAs: "diagnosticsBuiltInBundleId" },
    );
    await app.control(
      "deploy the update",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "update-diagnostics-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      { saveResultAs: "diagnosticsBundleId" },
    );
    await app.launch("launch the built-in bundle");
    await app.tap("start from an empty log", "action-clear-update-logs");
    await app.assertText("the log is empty", "update-logs-result", "none", {
      exactText: true,
    });
    await app.assertText(
      "updates are on and nothing waits for a restart",
      "update-status-result",
      [
        "isEnabled=true",
        "disabledReason=none",
        "isUpdatePending=false",
        "pendingBundleId=none",
        "bundleId=$diagnosticsBuiltInBundleId",
        "channel=production",
      ],
    );

    await app.tap(
      "download the update",
      "action-install-current-channel-update",
    );
    await app.control(
      "native metadata has the update waiting",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$diagnosticsBundleId",
        verificationPending: true,
      },
    );
    await app.assertText(
      "the update waits for a restart, and the built-in bundle still runs",
      "update-status-result",
      [
        "isUpdatePending=true",
        "pendingBundleId=$diagnosticsBundleId",
        "bundleId=$diagnosticsBuiltInBundleId",
      ],
    );
    await app.assertText(
      "the log has the check and the download",
      "update-logs-result",
      [
        "CHECK UPDATE_AVAILABLE $diagnosticsBundleId production",
        "DOWNLOAD STAGED $diagnosticsBundleId production",
      ],
    );

    await app.terminate("stop the session that downloaded the update");
    await app.launch("restart into the update");
    await app.control(
      "native metadata verified the update",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$diagnosticsBundleId",
        verificationPending: false,
      },
    );
    await app.assertText(
      "the update runs and nothing waits for a restart",
      "update-status-result",
      [
        "isUpdatePending=false",
        "pendingBundleId=none",
        "bundleId=$diagnosticsBundleId",
      ],
    );
    await app.assertText(
      "the log has the applied update",
      "update-logs-result",
      "APPLY APPLIED $diagnosticsBundleId production",
    );

    await app.control(
      "deploy a bundle that crashes",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "update-diagnostics-crash-detox",
        mode: "crash",
        safeBundleIds: ["$diagnosticsBuiltInBundleId", "$diagnosticsBundleId"],
        targetAppVersion: "1.0.x",
      },
      { saveResultAs: "diagnosticsCrashBundleId" },
    );
    await app.launch("launch before the crashing bundle");
    await app.tap(
      "download the crashing bundle",
      "action-install-current-channel-update",
    );
    await app.control(
      "native metadata has the crashing bundle waiting",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$diagnosticsCrashBundleId",
        recoveredStableBundleId: "$diagnosticsBundleId",
        verificationPending: true,
      },
    );
    await app.launch("launch the crashing bundle", { expectCrash: true });
    await app.control(
      "native recovery rolled the crashing bundle back",
      "/e2e/wait-for-crash-recovery",
      {
        crashedBundleId: "$diagnosticsCrashBundleId",
        stableBundleId: "$diagnosticsBundleId",
      },
    );
    await app.assertText(
      "the stable bundle runs and nothing waits for a restart",
      "update-status-result",
      [
        "isUpdatePending=false",
        "pendingBundleId=none",
        "bundleId=$diagnosticsBundleId",
      ],
    );
    await app.assertText(
      "the log has the rollback",
      "update-logs-result",
      "CRASH_RECOVERY ROLLED_BACK_AFTER_CRASH $diagnosticsBundleId production",
    );

    await app.tap("clear the log", "action-clear-update-logs");
    await app.assertText(
      "the log is empty again",
      "update-logs-result",
      "none",
      {
        exactText: true,
      },
    );
  },
};
