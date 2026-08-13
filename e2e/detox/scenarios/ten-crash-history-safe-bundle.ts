import type { DetoxScenarioDefinition } from "./types.ts";

export const tenCrashHistorySafeBundleScenario: DetoxScenarioDefinition = {
  name: "ten-crash-history-safe-bundle",
  run: async (app) => {
    await app.control(
      "deploy crash-history safe Bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "ten-crash-safe-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "crashHistorySafeBundleId",
        saveResultFieldsAs: { releaseId: "crashHistorySafeReleaseId" },
      },
    );
    await app.control(
      "seed ten newer crashed Bundles",
      "/e2e/jobs/seed-crashed-bundle-frontier",
      { count: 10, sourceReleaseId: "$crashHistorySafeReleaseId" },
    );
    await app.control(
      "persist ten crashed Bundle ids",
      "/e2e/seed-crash-history",
      { bundleIds: "$bundleIds" },
    );
    await app.launch("launch ten-crash history app");
    await app.assertText(
      "assert ten crash entries loaded",
      "crash-history-count",
      "10",
      { exactText: true },
    );
    await app.tap(
      "install 11th safe Bundle",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert 11th safe Bundle selected",
      "update-action-result",
      "current-channel -> installed Release $crashHistorySafeReleaseId / Bundle $crashHistorySafeBundleId",
      { exactText: true },
    );
    await app.control(
      "wait 11th safe Bundle pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$crashHistorySafeBundleId",
        releaseId: "$crashHistorySafeReleaseId",
        verificationPending: true,
      },
    );
    await app.reload("reload 11th safe Bundle");
    await app.assertText(
      "assert 11th safe Bundle active",
      "runtime-bundle-id",
      "$crashHistorySafeBundleId",
    );
  },
};
