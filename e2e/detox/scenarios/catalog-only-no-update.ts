import type { DetoxScenarioDefinition } from "./types.ts";

export const catalogOnlyNoUpdateScenario: DetoxScenarioDefinition = {
  name: "catalog-only-no-update",
  run: async (app) => {
    await app.control(
      "deploy excluded catalog Release",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "catalog-only-no-update-detox",
        mode: "reset",
        rollout: 0,
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      { saveResultAs: "excludedBundleId" },
    );
    await app.launch("launch catalog-only app");
    await app.control("reset catalog-only proxy", "/e2e/proxy-control", {
      artifactFailures: 1,
      reset: true,
    });
    await app.tap(
      "check excluded catalog Release",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert catalog-only no update",
      "update-action-result",
      "current-channel -> no-update",
      { exactText: true },
    );
    await app.control("assert catalog-only transport", "/e2e/assert-proxy", {
      artifactFailuresRemaining: 1,
      artifactRequests: 0,
      catalogRequests: 1,
    });
  },
};
