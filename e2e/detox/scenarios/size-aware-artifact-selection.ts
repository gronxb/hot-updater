import type { DetoxScenarioDefinition } from "./types.ts";

export const sizeAwareArtifactSelectionScenario: DetoxScenarioDefinition = {
  name: "size-aware-artifact-selection",
  run: async (app) => {
    await app.control(
      "deploy size-aware base bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "size-aware-base-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "sizeAwareBaseBundleId",
        saveResultFieldsAs: {
          releaseId: "sizeAwareBaseReleaseId",
        },
      },
    );
    await app.launch("launch size-aware base app");
    await app.tap(
      "install size-aware base update",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert size-aware base Release installed",
      "update-action-result",
      "current-channel -> installed ID $sizeAwareBaseReleaseId",
      { exactText: true },
    );
    await app.control(
      "wait size-aware base metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$sizeAwareBaseBundleId",
        releaseId: "$sizeAwareBaseReleaseId",
        verificationPending: true,
      },
    );
    await app.reload("reload size-aware base update");
    await app.control(
      "wait size-aware base metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$sizeAwareBaseBundleId",
        releaseId: "$sizeAwareBaseReleaseId",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert size-aware base Bundle active",
      "runtime-bundle-id",
      "$sizeAwareBaseBundleId",
    );
    await app.assertText(
      "assert size-aware base Release active",
      "runtime-release-state",
      "$sizeAwareBaseReleaseId",
    );

    await app.control(
      "deploy size-aware small diff bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        diffBaseBundleId: "$sizeAwareBaseBundleId",
        marker: "size-aware-small-diff-detox",
        mode: "reset",
        patchMaxBaseBundles: 1,
        safeBundleIds: ["$sizeAwareBaseBundleId"],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "sizeAwareSmallBundleId",
        saveResultFieldsAs: {
          releaseId: "sizeAwareSmallReleaseId",
        },
      },
    );
    await app.control(
      "assert size-aware small diff base",
      "/e2e/assert-bundle-patch-bases",
      {
        bundleId: "$sizeAwareSmallBundleId",
        expectedBaseBundleIds: ["$sizeAwareBaseBundleId"],
      },
    );
    await app.launch("launch size-aware small diff app");
    await app.control(
      "reset size-aware small artifact evidence",
      "/e2e/proxy-control",
      { reset: true },
    );
    await app.tap(
      "install size-aware small diff update",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert size-aware small Release installed",
      "update-action-result",
      "current-channel -> installed ID $sizeAwareSmallReleaseId",
      { exactText: true },
    );
    await app.control(
      "assert size-aware small manifest selection",
      "/e2e/assert-bundle-artifact-selection",
      {
        currentBundleId: "$sizeAwareBaseBundleId",
        selection: "manifest-v1",
        targetBundleId: "$sizeAwareSmallBundleId",
      },
    );
    await app.control(
      "assert size-aware small patch transfer",
      "/e2e/assert-bundle-artifact-transfers",
      {
        archiveRequests: 0,
        currentBundleId: "$sizeAwareBaseBundleId",
        fileRequests: 0,
        maxRequestsPerAsset: 1,
        minNetworkAssets: 1,
        patchRequests: 1,
        targetBundleId: "$sizeAwareSmallBundleId",
        verifyAllAssetHashes: true,
      },
    );
    await app.control(
      "wait size-aware small metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$sizeAwareSmallBundleId",
        releaseId: "$sizeAwareSmallReleaseId",
        verificationPending: true,
      },
    );
    await app.reload("reload size-aware small diff update");
    await app.control(
      "wait size-aware small metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$sizeAwareSmallBundleId",
        releaseId: "$sizeAwareSmallReleaseId",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert size-aware small Bundle active",
      "runtime-bundle-id",
      "$sizeAwareSmallBundleId",
    );
    await app.assertText(
      "assert size-aware small Release active",
      "runtime-release-state",
      "$sizeAwareSmallReleaseId",
    );
    await app.assertText(
      "assert size-aware small marker",
      "runtime-scenario-marker",
      "size-aware-small-diff-detox",
    );

    const installLargeVariant = async (input: {
      baseBundleId: string;
      bundleResultKey: string;
      corruptArchive: boolean;
      expectedFileRequests: number;
      expectedPatchRequests: number;
      label: string;
      marker: string;
      releaseResultKey: string;
    }) => {
      const bundleId = `$${input.bundleResultKey}`;
      const releaseId = `$${input.releaseResultKey}`;
      await app.control(
        `deploy size-aware ${input.label} bundle`,
        "/e2e/jobs/deploy-bundle",
        {
          bundleProfile: "sizeAwareLargeDiff",
          channel: "production",
          diffBaseBundleId: input.baseBundleId,
          marker: input.marker,
          mode: "reset",
          patchMaxBaseBundles: 1,
          safeBundleIds: [input.baseBundleId],
          targetAppVersion: "1.0.x",
        },
        {
          saveResultAs: input.bundleResultKey,
          saveResultFieldsAs: {
            releaseId: input.releaseResultKey,
          },
        },
      );
      await app.control(
        `assert size-aware ${input.label} diff base`,
        "/e2e/assert-bundle-patch-bases",
        {
          bundleId,
          expectedBaseBundleIds: [input.baseBundleId],
        },
      );
      await app.launch(`launch size-aware ${input.label} app`);
      await app.control(
        `reset size-aware ${input.label} artifact evidence`,
        "/e2e/proxy-control",
        {
          ...(input.corruptArchive
            ? { archiveFailureMode: "corrupt", archiveFailures: 1 }
            : {}),
          reset: true,
        },
      );
      await app.tap(
        `install size-aware ${input.label} update`,
        "action-install-current-channel-update",
      );
      await app.assertText(
        `assert size-aware ${input.label} Release installed`,
        "update-action-result",
        `current-channel -> installed ID ${releaseId}`,
        { exactText: true },
      );
      await app.control(
        `assert size-aware ${input.label} manifest selection`,
        "/e2e/assert-bundle-artifact-selection",
        {
          currentBundleId: input.baseBundleId,
          selection: "manifest-v1",
          targetBundleId: bundleId,
        },
      );
      await app.control(
        input.corruptArchive
          ? "assert corrupt archive falls back once per file"
          : "assert successful archive avoids per-file transfers",
        "/e2e/assert-bundle-artifact-transfers",
        {
          archiveRequests: 1,
          currentBundleId: input.baseBundleId,
          fileRequests: input.expectedFileRequests,
          maxRequestsPerAsset: 1,
          minNetworkAssets: input.corruptArchive ? 2 : 0,
          patchRequests: input.expectedPatchRequests,
          targetBundleId: bundleId,
          verifyAllAssetHashes: true,
        },
      );
      await app.control(
        `wait size-aware ${input.label} metadata pending`,
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId,
          releaseId,
          verificationPending: true,
        },
      );
      await app.reload(`reload size-aware ${input.label} update`);
      await app.control(
        `wait size-aware ${input.label} metadata stable`,
        "/e2e/jobs/wait-for-metadata",
        {
          bundleId,
          releaseId,
          verificationPending: false,
        },
      );
      await app.assertText(
        `assert size-aware ${input.label} Bundle active`,
        "runtime-bundle-id",
        bundleId,
      );
      await app.assertText(
        `assert size-aware ${input.label} Release active`,
        "runtime-release-state",
        releaseId,
      );
      await app.assertText(
        `assert size-aware ${input.label} marker`,
        "runtime-scenario-marker",
        input.marker,
      );
    };

    await installLargeVariant({
      baseBundleId: "$sizeAwareSmallBundleId",
      bundleResultKey: "sizeAwareLargeSuccessBundleId",
      corruptArchive: false,
      expectedFileRequests: 0,
      expectedPatchRequests: 0,
      label: "large success",
      marker: "size-aware-large-success-detox",
      releaseResultKey: "sizeAwareLargeSuccessReleaseId",
    });
    await installLargeVariant({
      baseBundleId: "$sizeAwareLargeSuccessBundleId",
      bundleResultKey: "sizeAwareLargeFallbackBundleId",
      corruptArchive: true,
      expectedFileRequests: 1,
      expectedPatchRequests: 1,
      label: "large fallback",
      marker: "size-aware-large-fallback-detox",
      releaseResultKey: "sizeAwareLargeFallbackReleaseId",
    });
  },
};
