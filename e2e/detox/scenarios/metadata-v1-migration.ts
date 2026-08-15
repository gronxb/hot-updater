import type { DetoxScenarioDefinition } from "./types.ts";

export const metadataV1MigrationScenario: DetoxScenarioDefinition = {
  name: "metadata-v1-migration",
  run: async (app) => {
    await app.control(
      "deploy migration stable",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "metadata-v1-stable-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      { saveResultAs: "migrationStableBundleId" },
    );
    await app.launch("launch migration stable");
    await app.tap(
      "install migration stable",
      "action-install-current-channel-update",
    );
    await app.control(
      "wait migration stable pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$migrationStableBundleId",
        verificationPending: true,
      },
    );
    await app.reload("reload migration stable");
    await app.control(
      "wait migration stable active",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$migrationStableBundleId",
        verificationPending: false,
      },
    );
    await app.control(
      "deploy migration staging",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "metadata-v1-staging-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "migrationStagingBundleId",
        saveResultFieldsAs: { releaseId: "migrationStagingReleaseId" },
      },
    );
    await app.launch("launch migration staging");
    await app.tap(
      "install migration staging",
      "action-install-current-channel-update",
    );
    await app.control(
      "wait migration staging pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$migrationStagingBundleId",
        verificationPending: true,
      },
    );
    await app.control(
      "seed metadata-v1 state",
      "/e2e/seed-legacy-metadata",
      {},
    );
    await app.launch("launch metadata-v1 migration");
    await app.assertText(
      "assert migrated staging Bundle launched",
      "runtime-bundle-id",
      "$migrationStagingBundleId",
    );
    await app.tap(
      "adopt migrated staging Release",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert migrated Release adoption",
      "update-action-result",
      "current-channel -> adopted Release $migrationStagingReleaseId / Bundle $migrationStagingBundleId",
      { exactText: true },
    );
    await app.assertText(
      "assert migrated v2 receipt",
      "runtime-release-state",
      "$migrationStagingReleaseId",
    );
  },
};
