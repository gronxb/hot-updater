import type { DetoxScenarioDefinition } from "./types.ts";

export const startupHangRecoveryScenario: DetoxScenarioDefinition = {
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
      "current-channel -> installed ID $hangStableBundleId",
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
      "current-channel -> installed ID $hangBundleId",
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
      "verify JS hang before first render without crash marker",
      "/e2e/launch-startup-hang",
      {
        bundleId: "$hangBundleId",
      },
    );
    await app.terminate("force-kill hung process");
    await app.control(
      "cold start after interrupted launch",
      "/e2e/launch-uninstrumented-app",
    );
    await app.control(
      "recover stable bundle after startup hang",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$hangStableBundleId",
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
        toBundleId: "$hangStableBundleId",
      },
    );
    await app.control(
      "assert startup-hang failed bundle recorded",
      "/e2e/assert-crash-history",
      {
        bundleId: "$hangBundleId",
      },
    );
    await app.control("capture startup-hang recovery", "/e2e/capture-state", {
      prefix: "startup-hang-recovered",
    });

    await app.terminate("stop recovered process");
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
    await app.control(
      "assert stable metadata after another cold start",
      "/e2e/assert-metadata-active",
      {
        bundleId: "$hangStableBundleId",
      },
    );
  },
};
