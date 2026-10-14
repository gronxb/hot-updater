import type { ScenarioAppDriver, ScenarioDefinition } from "./types.ts";

/**
 * A bundle of many small assets installs from its archive. Each deploy writes
 * new small assets beside one large asset that stays the same, so the second
 * OTA reuses the large one from the first: the archive then carries more bytes
 * than the files left, but one archive request still beats dozens of files.
 */
const installAssetHeavyBundle = async (
  app: ScenarioAppDriver,
  input: {
    /** Omitted for the first OTA, which comes from the built-in Bundle. */
    currentBundleId?: string;
    label: string;
    marker: string;
    resultKey: string;
  },
) => {
  const bundleId = `$${input.resultKey}BundleId`;
  const releaseId = `$${input.resultKey}ReleaseId`;
  await app.control(
    `deploy asset-heavy ${input.label} bundle`,
    "/e2e/jobs/deploy-bundle",
    {
      bundleProfile: "assetHeavy",
      channel: "production",
      marker: input.marker,
      mode: "reset",
      safeBundleIds: [],
      targetAppVersion: "1.0.x",
    },
    {
      saveResultAs: `${input.resultKey}BundleId`,
      saveResultFieldsAs: {
        releaseId: `${input.resultKey}ReleaseId`,
      },
    },
  );
  await app.launch(`launch asset-heavy ${input.label} app`);
  await app.control(
    `reset asset-heavy ${input.label} artifact evidence`,
    "/e2e/proxy-control",
    { reset: true },
  );
  await app.tap(
    `install asset-heavy ${input.label} update`,
    "action-install-current-channel-update",
  );
  await app.assertText(
    `assert asset-heavy ${input.label} Release installed`,
    "update-action-result",
    `current-channel -> installed ID ${releaseId}`,
    { exactText: true },
  );
  await app.control(
    `assert asset-heavy ${input.label} installs from the archive`,
    "/e2e/assert-bundle-artifact-transfers",
    {
      archiveRequests: 1,
      ...(input.currentBundleId
        ? { currentBundleId: input.currentBundleId }
        : {}),
      fileRequests: 0,
      // The archive needs no URL per file, so the server signs none.
      filesRequests: 0,
      patchRequests: 0,
      targetBundleId: bundleId,
      verifyAllAssetHashes: true,
    },
  );
  await app.control(
    `wait asset-heavy ${input.label} metadata pending`,
    "/e2e/jobs/wait-for-metadata",
    { bundleId, releaseId, verificationPending: true },
  );
  await app.reload(`reload asset-heavy ${input.label} update`);
  await app.control(
    `wait asset-heavy ${input.label} metadata stable`,
    "/e2e/jobs/wait-for-metadata",
    { bundleId, releaseId, verificationPending: false },
  );
  await app.assertText(
    `assert asset-heavy ${input.label} Bundle active`,
    "runtime-bundle-id",
    bundleId,
  );
  await app.assertText(
    `assert asset-heavy ${input.label} marker`,
    "runtime-scenario-marker",
    input.marker,
  );
};

export const assetHeavyOtaUsesArchiveScenario: ScenarioDefinition = {
  name: "asset-heavy-ota-uses-archive",
  run: async (app) => {
    await installAssetHeavyBundle(app, {
      label: "first",
      marker: "asset-heavy-first-detox",
      resultKey: "assetHeavyFirst",
    });
    await installAssetHeavyBundle(app, {
      currentBundleId: "$assetHeavyFirstBundleId",
      label: "next",
      marker: "asset-heavy-next-detox",
      resultKey: "assetHeavyNext",
    });
  },
};
