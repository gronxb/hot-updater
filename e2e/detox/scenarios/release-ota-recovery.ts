import type { DetoxScenarioDefinition } from "./types.ts";

export const releaseOtaRecoveryScenario: DetoxScenarioDefinition = {
  name: "release-ota-recovery",
  run: async (app) => {
    await app.control(
      "capture built-in bundle id",
      "/e2e/capture-built-in-bundle-id",
      {},
      {
        saveResultAs: "builtInBundleId",
      },
    );
    await app.control(
      "deploy stable bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "stable-detox-recovery",
        message: "Detox recovery stable bundle",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "stableBundleId",
      },
    );
    await app.launch("launch stable update app");
    await app.tap(
      "install stable update",
      "action-install-current-channel-update",
    );
    await app.control(
      "wait stable metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$stableBundleId",
        verificationPending: true,
      },
    );
    await app.reload("reload stable bundle");
    await app.control(
      "wait stable metadata active",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$stableBundleId",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert stable launch",
      "launch-status-result",
      "Current Launch Status: STABLE",
    );
    await app.control(
      "deploy crash bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "crash-detox-recovery",
        message: "Detox recovery crash bundle",
        mode: "crash",
        safeBundleIds: ["$builtInBundleId", "$stableBundleId"],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "crashBundleId",
      },
    );
    await app.launch("launch crash update app");
    await app.tap(
      "install crash update",
      "action-install-current-channel-update",
    );
    await app.control(
      "wait crash metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$crashBundleId",
        recoveredStableBundleId: "$stableBundleId",
        verificationPending: true,
      },
    );
    await app.assertText(
      "assert crash action result",
      "update-action-result",
      "current-channel -> installed $crashBundleId (UPDATE)",
    );
    await app.launch("launch crash bundle");
    await app.control("wait crash recovery", "/e2e/wait-for-crash-recovery", {
      crashedBundleId: "$crashBundleId",
      stableBundleId: "$stableBundleId",
    });
    await app.control(
      "assert recovery launch report",
      "/e2e/assert-launch-report",
      {
        crashedBundleId: "$crashBundleId",
        stableBundleId: "$stableBundleId",
        status: "RECOVERED",
      },
    );
    await app.assertText(
      "assert recovered bundle id",
      "runtime-bundle-id",
      "$stableBundleId",
    );
    await app.assertText(
      "assert recovered marker",
      "runtime-scenario-marker",
      "stable-detox-recovery",
    );
    await app.control(
      "assert recovered metadata active",
      "/e2e/assert-metadata-active",
      {
        bundleId: "$stableBundleId",
      },
    );
    await app.control("assert crash history", "/e2e/assert-crash-history", {
      bundleId: "$crashBundleId",
    });
  },
};
