import type { ScenarioDefinition } from "./types.ts";

/**
 * Release catalog partitioning, turned on as an operator does it, with the
 * real `hot-updater db partition-catalogs`. The server checks its own table
 * and sets the switch, the next deploy converts the scope into a head over
 * partitions, and the device installs the update through it.
 */
export const partitionedCatalogUpdateScenario: ScenarioDefinition = {
  name: "partitioned-catalog-update",
  run: async (app) => {
    await app.control(
      "capture built-in bundle",
      "/e2e/capture-built-in-bundle-id",
      {},
      { saveResultAs: "builtInBundleId" },
    );
    await app.control(
      "partition release catalogs",
      "/e2e/jobs/partition-catalogs",
      {},
    );
    await app.control(
      "deploy partitioned catalog bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "partitioned-catalog-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "partitionedBundleId",
        saveResultFieldsAs: { releaseId: "partitionedReleaseId" },
      },
    );
    await app.control(
      "assert the scope is partitioned",
      "/e2e/assert-release-catalog-layout",
      { layout: "partitioned", releaseId: "$partitionedReleaseId" },
    );
    await app.launch("launch partitioned catalog app");
    await app.assertText(
      "assert partitioned catalog built-in marker",
      "runtime-scenario-marker",
      "$initialMarker",
    );
    await app.tap(
      "install partitioned catalog bundle",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert partitioned catalog action result",
      "update-action-result",
      "current-channel -> installed ID $partitionedReleaseId",
      { exactText: true },
    );
    await app.control(
      "wait partitioned catalog metadata pending",
      "/e2e/jobs/wait-for-metadata",
      { bundleId: "$partitionedBundleId", verificationPending: true },
    );
    await app.reload("reload partitioned catalog bundle");
    await app.control(
      "wait partitioned catalog metadata stable",
      "/e2e/jobs/wait-for-metadata",
      { bundleId: "$partitionedBundleId", verificationPending: false },
    );
    await app.assertText(
      "assert partitioned catalog marker",
      "runtime-scenario-marker",
      "partitioned-catalog-detox",
    );
    await app.control(
      "assert partitioned catalog bundle active",
      "/e2e/assert-metadata-active",
      { bundleId: "$partitionedBundleId" },
    );
  },
};
