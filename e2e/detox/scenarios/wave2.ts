import { archiveToDiffScenario } from "./archive-to-diff.ts";
import type { DetoxScenarioDefinition } from "./types.ts";

const multiAssetPaths = [
  "assets/src/test/_fixture-multi-asset-a.bmp",
  "assets/src/test/_fixture-multi-asset-b.bmp",
  "assets/src/test/_fixture-multi-asset-c.bmp",
] as const;

export const wave2Scenarios: readonly DetoxScenarioDefinition[] = [
  {
    name: "multi-asset-replacement",
    wave: 2,
    steps: [
      { action: "launch", kind: "device", stage: "launch built-in app" },
      {
        body: {
          bundleProfile: "multiAssetReplacement",
          channel: "production",
          marker: "multi-assets-a-detox",
          mode: "reset",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        kind: "control",
        pathName: "/e2e/jobs/deploy-bundle",
        saveResultAs: "firstBundleId",
        stage: "deploy first multi-asset bundle",
      },
      {
        kind: "tap",
        stage: "install first multi-asset update",
        testID: "action-install-current-channel-update",
      },
      {
        body: {
          bundleId: "$firstBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
        kind: "control",
        pathName: "/e2e/jobs/wait-for-metadata",
        stage: "wait first multi-asset metadata pending",
      },
      {
        action: "reload",
        kind: "device",
        stage: "reload first multi-asset update",
      },
      {
        body: {
          bundleId: "$firstBundleId",
          verificationPending: false,
        },
        kind: "control",
        pathName: "/e2e/jobs/wait-for-metadata",
        stage: "wait first multi-asset metadata stable",
      },
      {
        body: {
          assetPaths: multiAssetPaths,
          bundleId: "$firstBundleId",
        },
        kind: "control",
        pathName: "/e2e/assert-bundle-assets-stored",
        stage: "assert first multi-assets stored",
      },
      {
        body: {
          bundleProfile: "multiAssetReplacement",
          channel: "production",
          marker: "multi-assets-b-detox",
          mode: "reset",
          safeBundleIds: ["$firstBundleId"],
          targetAppVersion: "1.0.x",
        },
        kind: "control",
        pathName: "/e2e/jobs/deploy-bundle",
        saveResultAs: "secondBundleId",
        stage: "deploy second multi-asset bundle",
      },
      {
        kind: "tap",
        stage: "install second multi-asset update",
        testID: "action-install-current-channel-update",
      },
      {
        body: {
          bundleId: "$secondBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
        kind: "control",
        pathName: "/e2e/jobs/wait-for-metadata",
        stage: "wait second multi-asset metadata pending",
      },
      {
        action: "reload",
        kind: "device",
        stage: "reload second multi-asset update",
      },
      {
        body: {
          bundleId: "$secondBundleId",
          verificationPending: false,
        },
        kind: "control",
        pathName: "/e2e/jobs/wait-for-metadata",
        stage: "wait second multi-asset metadata stable",
      },
      {
        body: {
          assetPaths: multiAssetPaths,
          bundleId: "$secondBundleId",
          previousBundleId: "$firstBundleId",
        },
        kind: "control",
        pathName: "/e2e/assert-multiple-assets-replaced",
        stage: "assert multi-assets replaced",
      },
    ],
  },
  archiveToDiffScenario,
  {
    name: "bspatch-consecutive-diff-ota",
    wave: 2,
    steps: [
      {
        body: {
          channel: "production",
          marker: "diff-a-detox",
          mode: "reset",
          patchMaxBaseBundles: 1,
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        kind: "control",
        pathName: "/e2e/jobs/deploy-bundle",
        saveResultAs: "firstBundleId",
        stage: "deploy first diff bundle",
      },
      {
        kind: "tap",
        stage: "install first diff bundle",
        testID: "action-install-current-channel-update",
      },
      {
        body: {
          bundleId: "$firstBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
        kind: "control",
        pathName: "/e2e/jobs/wait-for-metadata",
        stage: "wait first diff metadata pending",
      },
      {
        action: "reload",
        kind: "device",
        stage: "reload first diff bundle",
      },
      {
        body: { bundleId: "$firstBundleId", verificationPending: false },
        kind: "control",
        pathName: "/e2e/jobs/wait-for-metadata",
        stage: "wait first diff metadata stable",
      },
      {
        body: {
          channel: "production",
          diffBaseBundleId: "$firstBundleId",
          marker: "diff-b-detox",
          mode: "reset",
          patchMaxBaseBundles: 1,
          safeBundleIds: ["$firstBundleId"],
          targetAppVersion: "1.0.x",
        },
        kind: "control",
        pathName: "/e2e/jobs/deploy-bundle",
        saveResultAs: "secondBundleId",
        stage: "deploy second diff bundle",
      },
      {
        kind: "tap",
        stage: "install second diff bundle",
        testID: "action-install-current-channel-update",
      },
      {
        body: {
          bundleId: "$secondBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
        kind: "control",
        pathName: "/e2e/jobs/wait-for-metadata",
        stage: "wait second diff metadata pending",
      },
      {
        body: {
          assetPath: "$diffPatchAssetPath",
          baseBundleId: "$firstBundleId",
          bundleId: "$secondBundleId",
        },
        kind: "control",
        pathName: "/e2e/assert-bsdiff-patch-applied",
        stage: "assert consecutive diff patch",
      },
      {
        action: "reload",
        kind: "device",
        stage: "reload second diff bundle",
      },
      {
        body: { bundleId: "$secondBundleId", verificationPending: false },
        kind: "control",
        pathName: "/e2e/jobs/wait-for-metadata",
        stage: "wait second diff metadata stable",
      },
    ],
  },
  {
    name: "bspatch-disabled-chain-rollback",
    wave: 2,
    steps: [
      {
        body: {
          channel: "production",
          marker: "chain-base-detox",
          mode: "reset",
          patchMaxBaseBundles: 2,
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        kind: "control",
        pathName: "/e2e/jobs/deploy-bundle",
        saveResultAs: "baseBundleId",
        stage: "deploy chain base bundle",
      },
      {
        body: { bundleId: "$baseBundleId", enabled: false },
        kind: "control",
        pathName: "/e2e/jobs/patch-bundle",
        stage: "disable chain base bundle",
      },
      {
        body: { bundleId: "$baseBundleId" },
        kind: "control",
        pathName: "/e2e/assert-bundle-patch-bases",
        stage: "assert disabled chain bases",
      },
    ],
  },
  {
    name: "bspatch-manifest-diff-fallback",
    wave: 2,
    steps: [
      {
        body: {
          channel: "production",
          marker: "manifest-base-detox",
          mode: "reset",
          safeBundleIds: [],
          targetAppVersion: "1.0.x",
        },
        kind: "control",
        pathName: "/e2e/jobs/deploy-bundle",
        saveResultAs: "previousBundleId",
        stage: "deploy manifest base bundle",
      },
      {
        kind: "tap",
        stage: "install manifest base update",
        testID: "action-install-current-channel-update",
      },
      {
        body: {
          bundleId: "$previousBundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
        kind: "control",
        pathName: "/e2e/jobs/wait-for-metadata",
        stage: "wait manifest base metadata pending",
      },
      {
        action: "reload",
        kind: "device",
        stage: "reload manifest base update",
      },
      {
        body: { bundleId: "$previousBundleId", verificationPending: false },
        kind: "control",
        pathName: "/e2e/jobs/wait-for-metadata",
        stage: "wait manifest base metadata stable",
      },
      {
        body: {
          channel: "production",
          marker: "manifest-intermediate-detox",
          mode: "reset",
          safeBundleIds: ["$previousBundleId"],
          targetAppVersion: "1.0.x",
        },
        kind: "control",
        pathName: "/e2e/jobs/deploy-bundle",
        saveResultAs: "intermediateBundleId",
        stage: "deploy manifest intermediate bundle",
      },
      {
        body: {
          channel: "production",
          marker: "manifest-fallback-detox",
          mode: "reset",
          patchMaxBaseBundles: 1,
          safeBundleIds: ["$previousBundleId", "$intermediateBundleId"],
          targetAppVersion: "1.0.x",
        },
        kind: "control",
        pathName: "/e2e/jobs/deploy-bundle",
        saveResultAs: "bundleId",
        stage: "deploy manifest fallback bundle",
      },
      {
        body: {
          absentBaseBundleIds: ["$previousBundleId"],
          bundleId: "$bundleId",
          expectedBaseBundleIds: ["$intermediateBundleId"],
        },
        kind: "control",
        pathName: "/e2e/assert-bundle-patch-bases",
        stage: "assert manifest fallback patch bases",
      },
      {
        kind: "tap",
        stage: "install manifest fallback update",
        testID: "action-install-current-channel-update",
      },
      {
        body: {
          bundleId: "$bundleId",
          relaunchLimit: 0,
          verificationPending: true,
        },
        kind: "control",
        pathName: "/e2e/jobs/wait-for-metadata",
        stage: "wait manifest fallback metadata pending",
      },
      {
        action: "reload",
        kind: "device",
        stage: "reload manifest fallback update",
      },
      {
        body: { bundleId: "$bundleId", verificationPending: false },
        kind: "control",
        pathName: "/e2e/jobs/wait-for-metadata",
        stage: "wait manifest fallback metadata stable",
      },
      {
        body: {
          bundleId: "$bundleId",
          previousBundleId: "$previousBundleId",
        },
        kind: "control",
        pathName: "/e2e/assert-manifest-diff-applied",
        stage: "assert manifest diff fallback",
      },
    ],
  },
];
