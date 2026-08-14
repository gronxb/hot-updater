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
        saveResultFieldsAs: {
          releaseId: "stableReleaseId",
        },
      },
    );
    await app.launch("launch stable update app");
    await app.tap(
      "install stable update",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert stable update installed",
      "update-action-result",
      "current-channel -> installed Release $stableReleaseId / Bundle $stableBundleId",
      { exactText: true },
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
    await app.assertText("assert stable launch", "launch-status-result", [
      "Current Launch Status: UNCHANGED",
      "Current Launch Status: UPDATE_APPLIED",
    ]);
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
        saveResultFieldsAs: {
          releaseId: "crashReleaseId",
        },
      },
    );
    await app.launch("launch crash update app");
    await app.tap(
      "install crash update",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert crash update installed",
      "update-action-result",
      "current-channel -> installed Release $crashReleaseId / Bundle $crashBundleId",
      { exactText: true },
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
    await app.launch("launch crash bundle");
    await app.control("wait crash recovery", "/e2e/wait-for-crash-recovery", {
      crashedBundleId: "$crashBundleId",
      stableBundleId: "$stableBundleId",
    });
    await app.control(
      "assert recovery launch report",
      "/e2e/assert-launch-report",
      {
        fromBundleId: "$crashBundleId",
        fromReleaseId: "$crashReleaseId",
        status: "RECOVERED",
        toBundleId: "$stableBundleId",
        toReleaseId: "$stableReleaseId",
      },
    );
    await app.assertText(
      "assert recovered bundle id",
      "runtime-bundle-id",
      "$stableBundleId",
    );
    await app.assertText(
      "assert recovered Release id",
      "runtime-release-state",
      "$stableReleaseId",
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
    await app.control(
      "guard post-crash reselection artifact",
      "/e2e/proxy-control",
      { artifactFailures: 1 },
    );
    await app.tap(
      "refresh same-generation crash context",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert same-generation safe reselection",
      "update-action-result",
      "current-channel -> adopted Release $stableReleaseId / Bundle $stableBundleId",
      { exactText: true },
    );
    await app.control(
      "assert crash-context reselection skipped artifact",
      "/e2e/assert-proxy",
      { artifactFailuresRemaining: 1 },
    );
  },
};
