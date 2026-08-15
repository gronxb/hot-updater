import type { DetoxScenarioDefinition } from "./types.ts";

export const sameBundleReleaseAdoptionScenario: DetoxScenarioDefinition = {
  name: "same-bundle-release-adoption",
  run: async (app) => {
    await app.control(
      "deploy adoption bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "same-bundle-adoption-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "adoptionBundleId",
        saveResultFieldsAs: { releaseId: "originalReleaseId" },
      },
    );
    await app.launch("launch adoption app");
    await app.tap(
      "install adoption bundle",
      "action-install-current-channel-update",
    );
    await app.control(
      "wait adoption bundle pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$adoptionBundleId",
        releaseId: "$originalReleaseId",
        verificationPending: true,
      },
    );
    await app.reload("reload adoption bundle");
    await app.control(
      "wait adoption bundle active",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$adoptionBundleId",
        releaseId: "$originalReleaseId",
        verificationPending: false,
      },
    );
    await app.control(
      "create same-Bundle Release",
      "/e2e/jobs/create-rollback-release",
      {
        sourceReleaseId: "$originalReleaseId",
        toBundleId: "$adoptionBundleId",
      },
      { saveResultFieldsAs: { releaseId: "adoptedReleaseId" } },
    );
    await app.control("reset adoption proxy", "/e2e/proxy-control", {
      artifactFailures: 1,
      reset: true,
    });
    await app.tap(
      "adopt same-Bundle Release",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert metadata-only adoption",
      "update-action-result",
      "current-channel -> adopted Release $adoptedReleaseId / Bundle $adoptionBundleId",
      { exactText: true },
    );
    await app.assertText(
      "assert adoption did not reload",
      "runtime-scenario-marker",
      "same-bundle-adoption-detox",
    );
    await app.assertText(
      "assert adopted Release active",
      "runtime-release-state",
      "$adoptedReleaseId",
    );
    await app.control("assert adoption transport", "/e2e/assert-proxy", {
      artifactFailuresRemaining: 1,
      artifactRequests: 0,
      catalogRequests: 1,
    });
  },
};
