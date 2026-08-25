import type { DetoxScenarioDefinition } from "./types.ts";

export const sizeAwareArtifactSelectionScenario: DetoxScenarioDefinition = {
  name: "size-aware-artifact-selection",
  run: async (app) => {
    await app.control(
      "deploy size-aware base bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        compressStrategy: "tar.br",
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
      "current-channel -> installed Release $sizeAwareBaseReleaseId / Bundle $sizeAwareBaseBundleId",
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
        compressStrategy: "tar.br",
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
      "current-channel -> installed Release $sizeAwareSmallReleaseId / Bundle $sizeAwareSmallBundleId",
      { exactText: true },
    );
    await app.control(
      "assert size-aware small manifest selection",
      "/e2e/assert-bundle-artifact-selection",
      {
        currentBundleId: "$sizeAwareBaseBundleId",
        selection: "manifest-diff",
        targetBundleId: "$sizeAwareSmallBundleId",
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

    await app.control(
      "deploy size-aware large diff bundle",
      "/e2e/jobs/deploy-bundle",
      {
        bundleProfile: "sizeAwareLargeDiff",
        channel: "production",
        compressStrategy: "tar.br",
        diffBaseBundleId: "$sizeAwareSmallBundleId",
        marker: "size-aware-large-diff-detox",
        mode: "reset",
        patchMaxBaseBundles: 1,
        safeBundleIds: ["$sizeAwareSmallBundleId"],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "sizeAwareLargeBundleId",
        saveResultFieldsAs: {
          releaseId: "sizeAwareLargeReleaseId",
        },
      },
    );
    await app.control(
      "assert size-aware large diff base",
      "/e2e/assert-bundle-patch-bases",
      {
        bundleId: "$sizeAwareLargeBundleId",
        expectedBaseBundleIds: ["$sizeAwareSmallBundleId"],
      },
    );
    await app.launch("launch size-aware large diff app");
    await app.control(
      "reset size-aware large artifact evidence",
      "/e2e/proxy-control",
      { reset: true },
    );
    await app.tap(
      "install size-aware large diff update",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "assert size-aware large Release installed",
      "update-action-result",
      "current-channel -> installed Release $sizeAwareLargeReleaseId / Bundle $sizeAwareLargeBundleId",
      { exactText: true },
    );
    await app.control(
      "assert size-aware large archive selection",
      "/e2e/assert-bundle-artifact-selection",
      {
        currentBundleId: "$sizeAwareSmallBundleId",
        selection: "archive-only",
        targetBundleId: "$sizeAwareLargeBundleId",
      },
    );
    await app.control(
      "wait size-aware large metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$sizeAwareLargeBundleId",
        releaseId: "$sizeAwareLargeReleaseId",
        verificationPending: true,
      },
    );
    await app.reload("reload size-aware large diff update");
    await app.control(
      "wait size-aware large metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$sizeAwareLargeBundleId",
        releaseId: "$sizeAwareLargeReleaseId",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert size-aware large Bundle active",
      "runtime-bundle-id",
      "$sizeAwareLargeBundleId",
    );
    await app.assertText(
      "assert size-aware large Release active",
      "runtime-release-state",
      "$sizeAwareLargeReleaseId",
    );
    await app.assertText(
      "assert size-aware large marker",
      "runtime-scenario-marker",
      "size-aware-large-diff-detox",
    );
  },
};
