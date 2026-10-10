import type { ScenarioDefinition } from "./types.ts";

export const startupHangRecoveryScenario: ScenarioDefinition = {
  name: "startup-hang-recovery",
  run: async (app) => {
    await app.control(
      "deploy startup-hang stable",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "startup-hang-stable-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "hangStableBundleId",
        saveResultFieldsAs: { releaseId: "hangStableReleaseId" },
      },
    );
    await app.launch("launch startup-hang stable installer");
    await app.tap(
      "install startup-hang stable",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert startup-hang stable installed",
      "update-action-result",
      "current-channel -> installed ID $hangStableReleaseId",
      { exactText: true },
    );
    await app.control(
      "wait startup-hang stable installed",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$hangStableBundleId",
        verificationPending: true,
      },
    );
    await app.reload("load startup-hang stable");
    await app.control(
      "verify startup-hang stable first render",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$hangStableBundleId",
        verificationPending: false,
      },
    );
    await app.assertText(
      "verify stable screen before hang",
      "runtime-scenario-marker",
      "startup-hang-stable-detox",
    );

    await app.control(
      "deploy startup-hang bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "startup-hang-detox",
        mode: "hang",
        safeBundleIds: ["$hangStableBundleId"],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "hangBundleId",
        saveResultFieldsAs: { releaseId: "hangReleaseId" },
      },
    );
    await app.launch("refresh startup-hang update check");
    await app.tap(
      "install startup-hang bundle",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert startup-hang bundle installed",
      "update-action-result",
      "current-channel -> installed ID $hangReleaseId",
      { exactText: true },
    );
    await app.control(
      "wait startup-hang bundle installed",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$hangBundleId",
        verificationPending: true,
      },
    );
    await app.terminate("stop stable process before hang launch");
    await app.control(
      "verify JS hang before startup confirmation without fatal crash",
      "/e2e/launch-startup-hang",
      {
        bundleId: "$hangBundleId",
      },
    );
    await app.terminate("force-kill hung process");
    await app.launch("cold start after interrupted launch");
    await app.control(
      "recover stable bundle after startup hang",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$hangStableBundleId",
        releaseId: "$hangStableReleaseId",
        verificationPending: false,
        attempts: 120,
      },
    );
    await app.control(
      "assert startup-hang recovery report",
      "/e2e/assert-launch-report",
      {
        status: "RECOVERED",
        fromBundleId: "$hangBundleId",
        fromReleaseId: "$hangReleaseId",
        toBundleId: "$hangStableBundleId",
        toReleaseId: "$hangStableReleaseId",
      },
    );
    // One unfinished launch cannot tell a hang from a user leaving early.
    await app.control(
      "assert startup-hang bundle awaits its retry",
      "/e2e/assert-crash-history",
      {
        bundleId: "$hangBundleId",
        awaitingRetry: true,
      },
    );
    await app.control("capture startup-hang recovery", "/e2e/capture-state", {
      prefix: "startup-hang-recovered",
    });
    await app.tap(
      "check for updates in the session that recovered",
      "action-install-current-channel-update",
    );
    // The changed crash history re-adopts the running Release with a fresh
    // receipt; the hung bundle must not be staged.
    await app.assertText(
      "the session that recovered re-adopts the stable Release",
      "update-action-result",
      "current-channel -> adopted ID $hangStableReleaseId",
      { exactText: true },
    );
    await app.control(
      "the session that recovered keeps the hung bundle out",
      "/e2e/assert-metadata-active",
      {
        bundleId: "$hangStableBundleId",
      },
    );

    await app.terminate("stop recovered process");
    await app.launch("open the app after recovery");
    await app.tap(
      "install startup-hang bundle for its retry",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert startup-hang bundle installed for its retry",
      "update-action-result",
      "current-channel -> installed ID $hangReleaseId",
      { exactText: true },
    );
    await app.control(
      "wait startup-hang bundle installed for its retry",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$hangBundleId",
        verificationPending: true,
      },
    );
    await app.terminate("stop stable process before the retried hang launch");
    await app.control(
      "verify the retried launch hangs before first render",
      "/e2e/launch-startup-hang",
      {
        bundleId: "$hangBundleId",
      },
    );
    await app.terminate("force-kill the retried hung process");
    await app.launch("cold start after the second interrupted launch");
    await app.control(
      "recover stable bundle after the second startup hang",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$hangStableBundleId",
        releaseId: "$hangStableReleaseId",
        verificationPending: false,
        attempts: 120,
      },
    );
    await app.control(
      "assert second startup-hang recovery report",
      "/e2e/assert-launch-report",
      {
        status: "RECOVERED",
        fromBundleId: "$hangBundleId",
        fromReleaseId: "$hangReleaseId",
        toBundleId: "$hangStableBundleId",
        toReleaseId: "$hangStableReleaseId",
      },
    );
    await app.control(
      "assert startup-hang interruption recorded",
      "/e2e/assert-startup-interruption",
      {
        bundleId: "$hangBundleId",
        releaseId: "$hangReleaseId",
      },
    );
    await app.control(
      "capture second startup-hang recovery",
      "/e2e/capture-state",
      {
        prefix: "startup-hang-recovered-again",
      },
    );

    await app.terminate("stop recovered process again");
    await app.launch("cold start once more after recovery");
    await app.assertText(
      "stable marker survives another cold start",
      "runtime-scenario-marker",
      "startup-hang-stable-detox",
    );
    await app.assertText(
      "stable Bundle survives another cold start",
      "runtime-bundle-id",
      "$hangStableBundleId",
    );
    await app.assertText(
      "stable Release survives another cold start",
      "runtime-release-state",
      "$hangStableReleaseId",
    );
    await app.control(
      "assert stable metadata after another cold start",
      "/e2e/assert-metadata-active",
      {
        bundleId: "$hangStableBundleId",
      },
    );
    await app.tap(
      "check for updates after the second recovery",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "no update after the second recovery",
      "update-action-result",
      "current-channel -> no-update",
      { exactText: true },
    );
    await app.control(
      "the hung bundle is not installed again",
      "/e2e/assert-metadata-active",
      {
        bundleId: "$hangStableBundleId",
      },
    );
  },
};
