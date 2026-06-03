import type { DetoxScenarioDefinition } from "./types.ts";

export const archiveToDiffScenario: DetoxScenarioDefinition = {
  name: "bspatch-archive-to-diff-ota",
  wave: 2,
  steps: [
    {
      body: {
        channel: "production",
        marker: "archive-base-detox",
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      kind: "control",
      pathName: "/e2e/jobs/deploy-bundle",
      saveResultAs: "archiveBundleId",
      stage: "deploy archive base bundle",
    },
    {
      action: "launch",
      kind: "device",
      stage: "launch archive base app",
    },
    {
      expectResultContains: "$archiveBundleId",
      kind: "tap",
      stage: "install archive base update",
      testID: "action-install-current-channel-update",
    },
    {
      body: {
        bundleId: "$archiveBundleId",
        relaunchLimit: 0,
        verificationPending: true,
      },
      kind: "control",
      pathName: "/e2e/jobs/wait-for-metadata",
      stage: "wait archive base metadata pending",
    },
    {
      body: {
        bundleId: "$archiveBundleId",
      },
      kind: "control",
      pathName: "/e2e/assert-first-ota-uses-archive",
      stage: "assert first ota uses archive",
    },
    {
      action: "reload",
      kind: "device",
      stage: "reload archive base update",
    },
    {
      body: { bundleId: "$archiveBundleId", verificationPending: false },
      kind: "control",
      pathName: "/e2e/jobs/wait-for-metadata",
      stage: "wait archive base metadata stable",
    },
    {
      body: {
        channel: "production",
        diffBaseBundleId: "$archiveBundleId",
        marker: "archive-diff-detox",
        mode: "reset",
        patchMaxBaseBundles: 1,
        safeBundleIds: ["$archiveBundleId"],
        targetAppVersion: "1.0.x",
      },
      kind: "control",
      pathName: "/e2e/jobs/deploy-bundle",
      saveResultAs: "diffBundleId",
      stage: "deploy diff bundle",
    },
    {
      body: {
        bundleId: "$diffBundleId",
        expectedBaseBundleIds: ["$archiveBundleId"],
      },
      kind: "control",
      pathName: "/e2e/assert-bundle-patch-bases",
      stage: "assert archive diff bases",
    },
    {
      action: "launch",
      kind: "device",
      stage: "launch archive diff app",
    },
    {
      expectResultContains: "$diffBundleId",
      kind: "tap",
      stage: "install archive diff update",
      testID: "action-install-current-channel-update",
    },
    {
      body: {
        bundleId: "$diffBundleId",
        relaunchLimit: 0,
        verificationPending: true,
      },
      kind: "control",
      pathName: "/e2e/jobs/wait-for-metadata",
      stage: "wait archive diff metadata pending",
    },
    {
      action: "reload",
      kind: "device",
      stage: "reload archive diff update",
    },
    {
      body: { bundleId: "$diffBundleId", verificationPending: false },
      kind: "control",
      pathName: "/e2e/jobs/wait-for-metadata",
      stage: "wait archive diff metadata stable",
    },
    {
      body: {
        assetPath: "$diffPatchAssetPath",
        baseBundleId: "$archiveBundleId",
      },
      kind: "control",
      pathName: "/e2e/assert-bsdiff-patch-applied",
      stage: "assert archive diff patch",
    },
  ],
};
