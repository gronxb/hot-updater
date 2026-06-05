import type { DetoxScenarioDefinition } from "./types.ts";

export const wave1Scenarios: readonly DetoxScenarioDefinition[] = [
  {
    name: "release-ota-recovery",
    stages: [
      "launch built-in app",
      "capture built-in bundle id",
      "deploy stable bundle",
      "launch stable update app",
      "install stable update",
      "wait stable metadata pending",
      "reload stable bundle",
      "wait stable metadata active",
      "assert stable launch",
      "deploy crash bundle",
      "launch crash update app",
      "install crash update",
      "wait crash metadata pending",
      "launch crash bundle",
      "wait crash recovery",
      "assert recovery launch report",
      "assert recovered bundle id",
      "assert recovered marker",
      "assert recovered metadata active",
      "assert crash history",
    ],
    wave: 1,
    run: async (scenario) => {
      await scenario.launch("launch built-in app");
      await scenario.control(
        "capture built-in bundle id",
        "/e2e/capture-built-in-bundle-id",
        {},
        {
          saveResultAs: "builtInBundleId",
        },
      );
      await scenario.control(
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
      await scenario.launch("launch stable update app");
      await scenario.tap(
        "install stable update",
        "action-install-current-channel-update",
      );
      await scenario.control(
        "wait stable metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$stableBundleId",
          verificationPending: true,
        },
      );
      await scenario.reload("reload stable bundle");
      await scenario.control(
        "wait stable metadata active",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$stableBundleId",
          verificationPending: false,
        },
      );
      await scenario.assertText(
        "assert stable launch",
        "launch-status-result",
        "Current Launch Status: STABLE",
      );
      await scenario.control(
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
      await scenario.launch("launch crash update app");
      await scenario.tap(
        "install crash update",
        "action-install-current-channel-update",
      );
      await scenario.control(
        "wait crash metadata pending",
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId: "$crashBundleId",
          recoveredStableBundleId: "$stableBundleId",
          verificationPending: true,
        },
      );
      await scenario.launch("launch crash bundle");
      await scenario.control(
        "wait crash recovery",
        "/e2e/wait-for-crash-recovery",
        {
          crashedBundleId: "$crashBundleId",
          stableBundleId: "$stableBundleId",
        },
      );
      await scenario.control(
        "assert recovery launch report",
        "/e2e/assert-launch-report",
        {
          crashedBundleId: "$crashBundleId",
          status: "RECOVERED",
        },
      );
      await scenario.assertText(
        "assert recovered bundle id",
        "runtime-bundle-id",
        "$stableBundleId",
      );
      await scenario.assertText(
        "assert recovered marker",
        "runtime-scenario-marker",
        "stable-detox-recovery",
      );
      await scenario.control(
        "assert recovered metadata active",
        "/e2e/assert-metadata-active",
        {
          bundleId: "$stableBundleId",
        },
      );
      await scenario.control(
        "assert crash history",
        "/e2e/assert-crash-history",
        {
          bundleId: "$crashBundleId",
        },
      );
    },
  },
];
